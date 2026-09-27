/**
 * chainCircuitBreaker.service.ts
 *
 * Generic circuit-breaker state machine with per-dependency tracking for
 * the two blockchain dependencies: the Stellar Soroban RPC and the
 * TrustlessWork escrow REST API.
 *
 * ## States
 *
 *   CLOSED   → healthy: every call goes through normally.
 *   OPEN     → failing: calls are rejected immediately (fail-fast) without
 *              hitting the dependency. A probe is scheduled after RESET_TIMEOUT_MS.
 *   HALF_OPEN → recovery probe: one call is allowed through. Success → CLOSED;
 *              failure → OPEN again with a fresh timeout.
 *
 * ## Failure threshold
 *
 * The breaker opens when FAILURE_THRESHOLD consecutive failures are recorded
 * within the SAMPLING_WINDOW_MS time window.  The window resets on every
 * successful call.
 *
 * ## Usage
 *
 *   import { sorobanBreaker, trustlessWorkBreaker } from './chainCircuitBreaker.service.js';
 *
 *   // Wrap a call — throws CircuitOpenError if the breaker is OPEN
 *   const result = await sorobanBreaker.execute(() => server.simulateTransaction(tx));
 *
 *   // Read state without calling through
 *   const { state, failureCount } = sorobanBreaker.getState();
 *
 * ## Exported error class
 *
 *   CircuitOpenError — thrown when the breaker is OPEN and the caller
 *   should surface a degraded-mode response to the user.
 */

import { performance } from 'node:perf_hooks';

// ─── Error ────────────────────────────────────────────────────────────────────

export class CircuitOpenError extends Error {
  readonly dependency: string;
  readonly retriableAfterMs: number;

  constructor(dependency: string, retriableAfterMs: number) {
    super(
      `Circuit breaker OPEN for dependency "${dependency}". ` +
        `Retry after ~${Math.ceil(retriableAfterMs / 1000)}s.`,
    );
    this.name = 'CircuitOpenError';
    this.dependency = dependency;
    this.retriableAfterMs = retriableAfterMs;
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Consecutive failures within the window before the circuit opens. Default: 5. */
  failureThreshold?: number;
  /** Number of consecutive successes in HALF_OPEN before closing. Default: 2. */
  successThreshold?: number;
  /** How long the circuit stays OPEN before allowing a half-open probe (ms). Default: 30 000. */
  resetTimeoutMs?: number;
  /** Sliding window duration for counting failures (ms). Default: 60 000. */
  samplingWindowMs?: number;
  /** Human-readable name used in log messages and errors. */
  name: string;
}

export interface CircuitBreakerSnapshot {
  name: string;
  state: CircuitState;
  failureCount: number;
  successCount: number;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  openedAt: string | null;
  /** Milliseconds remaining until the half-open probe fires. null if not OPEN. */
  retriableInMs: number | null;
  totalCalls: number;
  totalFailures: number;
}

// ─── Implementation ───────────────────────────────────────────────────────────

export class CircuitBreaker {
  private readonly name: string;
  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly samplingWindowMs: number;

  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private successCount = 0;
  private windowStart: number = performance.now();
  private openedAt: number | null = null;
  private lastFailureAt: Date | null = null;
  private lastSuccessAt: Date | null = null;

  // Lifetime counters for metrics
  private totalCalls = 0;
  private totalFailures = 0;

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.successThreshold = options.successThreshold ?? 2;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30_000;
    this.samplingWindowMs = options.samplingWindowMs ?? 60_000;
  }

  /**
   * Execute `fn` through the circuit breaker.
   *
   * @throws CircuitOpenError if the circuit is OPEN (fast-fail).
   * @throws The original error from `fn` if it fails while CLOSED or HALF_OPEN.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.totalCalls++;

    if (this.state === 'OPEN') {
      const elapsed = performance.now() - (this.openedAt ?? 0);
      const remaining = this.resetTimeoutMs - elapsed;

      if (remaining > 0) {
        throw new CircuitOpenError(this.name, remaining);
      }

      // Timeout elapsed — allow one probe through
      this.transitionTo('HALF_OPEN');
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure(err);
      throw err;
    }
  }

  /**
   * Record an external success (e.g. from a health-check probe).
   * Safe to call when the breaker is in any state.
   */
  recordSuccess(): void {
    this.onSuccess();
  }

  /**
   * Record an external failure (e.g. from a health-check probe).
   * Safe to call when the breaker is in any state.
   */
  recordFailure(err?: unknown): void {
    this.onFailure(err);
  }

  /**
   * Read a non-mutating snapshot of the current breaker state.
   */
  getSnapshot(): CircuitBreakerSnapshot {
    const retriableInMs =
      this.state === 'OPEN' && this.openedAt !== null
        ? Math.max(0, this.resetTimeoutMs - (performance.now() - this.openedAt))
        : null;

    return {
      name: this.name,
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureAt: this.lastFailureAt?.toISOString() ?? null,
      lastSuccessAt: this.lastSuccessAt?.toISOString() ?? null,
      openedAt: this.openedAt !== null ? new Date(Date.now() - (performance.now() - this.openedAt)).toISOString() : null,
      retriableInMs,
      totalCalls: this.totalCalls,
      totalFailures: this.totalFailures,
    };
  }

  /** True when callers must not attempt the dependency. */
  get isOpen(): boolean {
    if (this.state !== 'OPEN') return false;
    const elapsed = performance.now() - (this.openedAt ?? 0);
    return elapsed < this.resetTimeoutMs;
  }

  /** True when the dependency is healthy and calls go through normally. */
  get isClosed(): boolean {
    return this.state === 'CLOSED';
  }

  // ─── Private state transitions ─────────────────────────────────────────────

  private onSuccess(): void {
    this.lastSuccessAt = new Date();

    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.transitionTo('CLOSED');
      }
      return;
    }

    // CLOSED state — reset sliding window on success
    this.failureCount = 0;
    this.windowStart = performance.now();
  }

  private onFailure(err?: unknown): void {
    this.lastFailureAt = new Date();
    this.totalFailures++;

    if (this.state === 'HALF_OPEN') {
      // Any failure in HALF_OPEN → back to OPEN
      this.transitionTo('OPEN');
      return;
    }

    // Reset sliding window if it has expired
    if (performance.now() - this.windowStart > this.samplingWindowMs) {
      this.failureCount = 0;
      this.windowStart = performance.now();
    }

    this.failureCount++;

    if (this.failureCount >= this.failureThreshold) {
      this.transitionTo('OPEN');
    }
  }

  private transitionTo(newState: CircuitState): void {
    const prev = this.state;
    this.state = newState;

    if (newState === 'OPEN') {
      this.openedAt = performance.now();
      this.successCount = 0;
      console.warn(
        `[CircuitBreaker] "${this.name}" OPENED after ${this.failureCount} failure(s) ` +
          `(was ${prev}). Retry probe in ${this.resetTimeoutMs / 1000}s.`,
      );
    } else if (newState === 'HALF_OPEN') {
      this.successCount = 0;
      console.info(`[CircuitBreaker] "${this.name}" → HALF_OPEN (probe allowed).`);
    } else if (newState === 'CLOSED') {
      this.failureCount = 0;
      this.successCount = 0;
      this.openedAt = null;
      this.windowStart = performance.now();
      console.info(`[CircuitBreaker] "${this.name}" CLOSED (recovered).`);
    }
  }
}

// ─── Singletons ───────────────────────────────────────────────────────────────

/**
 * Circuit breaker for the Stellar Soroban RPC.
 *
 * Opens after 5 consecutive RPC failures within 60 s.
 * Allows a probe after 30 s; closes after 2 consecutive probe successes.
 */
export const sorobanBreaker = new CircuitBreaker({
  name: 'soroban-rpc',
  failureThreshold: 5,
  successThreshold: 2,
  resetTimeoutMs: 30_000,
  samplingWindowMs: 60_000,
});

/**
 * Circuit breaker for the TrustlessWork escrow REST API.
 *
 * Opens after 3 consecutive failures within 60 s — lower threshold than
 * Soroban because TW failures are always fatal for booking state transitions.
 * Allows a probe after 60 s (longer reset — TW outages tend to last longer).
 */
export const trustlessWorkBreaker = new CircuitBreaker({
  name: 'trustlesswork-api',
  failureThreshold: 3,
  successThreshold: 2,
  resetTimeoutMs: 60_000,
  samplingWindowMs: 60_000,
});

/**
 * Get a snapshot of all registered circuit breakers for the status endpoint.
 */
export function getAllBreakerSnapshots(): CircuitBreakerSnapshot[] {
  return [sorobanBreaker.getSnapshot(), trustlessWorkBreaker.getSnapshot()];
}

/**
 * True when any registered breaker is open.
 * Used by booking.service.ts to gate operations at the service entry point.
 */
export function isAnyBreakerOpen(): boolean {
  return sorobanBreaker.isOpen || trustlessWorkBreaker.isOpen;
}

/**
 * True specifically when the Soroban RPC breaker is open.
 */
export function isSorobanDegraded(): boolean {
  return sorobanBreaker.isOpen;
}

/**
 * True specifically when the TrustlessWork breaker is open.
 */
export function isTrustlessWorkDegraded(): boolean {
  return trustlessWorkBreaker.isOpen;
}
