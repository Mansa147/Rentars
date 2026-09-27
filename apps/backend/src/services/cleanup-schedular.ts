/**
 * cleanup-schedular.ts — background job scheduler.
 *
 * All periodic work runs as `setInterval` loops inside the HTTP server
 * process.  Jobs are fire-and-forget with per-job error handlers so one
 * failing job never crashes the server.
 *
 * Jobs and their intervals:
 *
 *   Blockchain sync (properties + bookings)   — 1 hour
 *   Escrow reconciliation                      — 5 minutes
 *   Ledger event DLQ retry                     — 10 minutes
 *   Sync lag + inbox metrics refresh           — 2 minutes
 *   Idempotency key cleanup                    — 1 hour
 *   Booking expiry cleanup                     — 10 minutes
 *   Data retention sweep                       — RETENTION_INTERVAL_HOURS (default 24 h)
 */

import { env } from '@/config/env.js';
import { syncAllBookings, syncAllProperties, reconcileAllPendingEscrows } from './sync.service.js';
import { purgeExpired as purgeExpiredIdempotencyKeys } from './idempotency.service.js';
import { BookingService } from './booking.service.js';
import { requeueFailedEvents, getInboxStats } from './ledgerEventInbox.service.js';
import { computeLag } from './syncCursor.service.js';
import { drainPendingOps, getPendingOpsStats } from './blockchainDegradedMode.service.js';
import type { PendingOp } from './blockchainDegradedMode.service.js';
import {
  isSorobanDegraded,
  isTrustlessWorkDegraded,
} from './chainCircuitBreaker.service.js';
import {
  incCounter,
  syncLagLedgers,
  syncDeadLetterDepth,
  syncRequeueTotal,
  syncInboxStatusTotal,
  blockchainPendingOpsDepth,
  blockchainOpsDrainedTotal,
  blockchainOpsFailedTotal,
} from '@/middleware/metrics.middleware.js';

// ─── Import runDataRetention lazily to avoid circular dependency ──────────────
// (data-retention.service imports booking.service which imports sync.service)
type DataRetentionOpts = { dryRun?: boolean; label?: string };
type DataRetentionFn = (opts?: DataRetentionOpts) => Promise<unknown>;
let _runDataRetention: DataRetentionFn | null = null;

async function runDataRetention(opts?: DataRetentionOpts): Promise<void> {
  if (!_runDataRetention) {
    const mod = await import('./dataRetention.service.js').catch(() => null);
    if (!mod) {
      console.warn('[retention] dataRetention.service not found — skipping');
      return;
    }
    _runDataRetention = mod.runDataRetention as DataRetentionFn;
  }
  await _runDataRetention(opts);
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SYNC_INTERVAL_MS                = 60 * 60 * 1000;       // 1 hour
const RECONCILIATION_INTERVAL_MS      =  5 * 60 * 1000;       // 5 minutes
const DLQ_RETRY_INTERVAL_MS           = 10 * 60 * 1000;       // 10 minutes
const METRICS_REFRESH_INTERVAL_MS     =  2 * 60 * 1000;       // 2 minutes
const PENDING_OPS_DRAIN_INTERVAL_MS   =  2 * 60 * 1000;       // 2 minutes
const IDEMPOTENCY_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;       // 1 hour
const BOOKING_EXPIRY_INTERVAL_MS      = 10 * 60 * 1000;       // 10 minutes

const MAX_CONCURRENT_RECONCILIATIONS = 5;
const INITIAL_BACKOFF_MS             = 1_000;                 // 1 second
const MAX_BACKOFF_MS                 = 30_000;                // 30 seconds

/**
 * Exponential back-off window for failed events before they are re-queued.
 * Starts at 1 min and doubles up to 30 min.
 */
const DLQ_INITIAL_BACKOFF_MS = 60_000;
const DLQ_MAX_BACKOFF_MS     = 30 * 60 * 1000;

const RETENTION_INTERVAL_MS =
  (env.RETENTION_INTERVAL_HOURS ?? 24) * 60 * 60 * 1000;

const RETENTION_STARTUP_PREVIEW_DELAY_MS = 10_000;

// ─── Shared mutable state ─────────────────────────────────────────────────────

const bookingService = new BookingService();

let concurrentReconciliations = 0;
let reconciliationBackoffMs    = INITIAL_BACKOFF_MS;
let dlqBackoffMs               = DLQ_INITIAL_BACKOFF_MS;

// ─── Sync ─────────────────────────────────────────────────────────────────────

async function runSync(): Promise<void> {
  const propertiesResult = await syncAllProperties();
  if (propertiesResult.success) {
    const { synced, failed, skipped } = propertiesResult.data ?? { synced: 0, failed: 0, skipped: 0 };
    console.log(`[sync] Properties: ${synced} synced, ${failed} failed, ${skipped} skipped`);
  } else {
    console.error(`[sync] Property sync failed: ${propertiesResult.error}`);
  }

  const bookingsResult = await syncAllBookings();
  if (bookingsResult.success) {
    const { synced, failed, skipped } = bookingsResult.data ?? { synced: 0, failed: 0, skipped: 0 };
    console.log(`[sync] Bookings: ${synced} synced, ${failed} failed, ${skipped} skipped`);
  } else {
    console.error(`[sync] Booking sync failed: ${bookingsResult.error}`);
  }
}

// ─── Escrow reconciliation ────────────────────────────────────────────────────

async function runEscrowReconciliation(): Promise<void> {
  if (concurrentReconciliations >= MAX_CONCURRENT_RECONCILIATIONS) {
    console.log(
      `[reconcile] Skipping — max concurrency (${MAX_CONCURRENT_RECONCILIATIONS}) reached`,
    );
    return;
  }

  concurrentReconciliations++;

  try {
    const result = await reconcileAllPendingEscrows();
    if (result.success) {
      console.log(
        `[reconcile] Escrows: ${result.data?.reconciled} reconciled, ${result.data?.failed} failed`,
      );
      reconciliationBackoffMs = INITIAL_BACKOFF_MS;
    } else {
      console.error(`[reconcile] Reconciliation failed: ${result.error}`);
      reconciliationBackoffMs = Math.min(reconciliationBackoffMs * 2, MAX_BACKOFF_MS);
    }
  } catch (err) {
    console.error('[reconcile] Scheduler error:', err);
    reconciliationBackoffMs = Math.min(reconciliationBackoffMs * 2, MAX_BACKOFF_MS);
  } finally {
    concurrentReconciliations--;
  }
}

// ─── DLQ retry loop ───────────────────────────────────────────────────────────

/**
 * Re-queue failed ledger events whose back-off window has elapsed.
 *
 * Uses exponential back-off: starts at 1 min, doubles on consecutive
 * requeue cycles that produce 0 results, resets to base on any requeue.
 */
async function runDlqRetry(): Promise<void> {
  try {
    const result = await requeueFailedEvents(dlqBackoffMs);

    if (!result.success) {
      console.error(`[dlq] Requeue failed: ${result.error}`);
      dlqBackoffMs = Math.min(dlqBackoffMs * 2, DLQ_MAX_BACKOFF_MS);
      return;
    }

    const { requeued } = result.data!;

    if (requeued > 0) {
      console.log(`[dlq] Re-queued ${requeued} failed event(s)`);
      incCounter(syncRequeueTotal, {}, requeued);
      dlqBackoffMs = DLQ_INITIAL_BACKOFF_MS; // reset back-off after productive run
    } else {
      // Nothing to requeue yet — grow the back-off window gradually.
      dlqBackoffMs = Math.min(dlqBackoffMs * 2, DLQ_MAX_BACKOFF_MS);
    }
  } catch (err) {
    console.error('[dlq] Scheduler error:', err);
  }
}

// ─── Pending ops drain (recovery after outage) ───────────────────────────────

/**
 * Build the executor function that the drain loop uses to re-run queued
 * on-chain operations.  Imported lazily to avoid circular imports at
 * module load time.
 */
async function buildOpExecutor(): Promise<((op: PendingOp) => Promise<void>) | null> {
  try {
    const [{ cancelBookingOnChain, createBookingOnChain, updateBookingStatusOnChain }, { trustlessWorkClient }] =
      await Promise.all([
        import('@/blockchain/bookingContract.js'),
        import('@/blockchain/trustlessWork.js'),
      ]);

    return async (op: PendingOp): Promise<void> => {
      const p = op.payload as Record<string, string>;

      switch (op.op_type) {
        case 'create_booking_on_chain':
          await createBookingOnChain(
            BigInt(p.on_chain_property_id),
            p.buyer_stellar_address,
            BigInt(p.check_in_ts),
            BigInt(p.check_out_ts),
            BigInt(p.total_price_stroops),
          );
          break;

        case 'cancel_booking_on_chain':
          await cancelBookingOnChain(BigInt(p.on_chain_id), p.caller_address);
          break;

        case 'update_booking_status_on_chain':
          await updateBookingStatusOnChain(
            BigInt(p.on_chain_id),
            p.new_status as import('@/blockchain/types.js').BookingStatus,
            p.caller_address,
          );
          break;

        case 'release_escrow':
          await trustlessWorkClient.releaseEscrow(p.escrow_id, p.reason);
          break;

        case 'cancel_escrow':
          await trustlessWorkClient.cancelEscrow(p.escrow_id);
          break;

        default:
          throw new Error(`Unknown op_type: ${(op as PendingOp).op_type}`);
      }
    };
  } catch (err) {
    console.error('[drain] Failed to build op executor:', err);
    return null;
  }
}

/**
 * Drain the blockchain pending-ops queue.
 * Only runs when neither circuit breaker is OPEN — if either is still open,
 * we skip to avoid re-queuing the same failures immediately.
 */
async function runPendingOpsDrain(): Promise<void> {
  if (isSorobanDegraded() || isTrustlessWorkDegraded()) {
    // At least one dependency is still degraded — wait for next cycle.
    return;
  }

  const executor = await buildOpExecutor();
  if (!executor) return;

  try {
    const result = await drainPendingOps(executor, 10);
    if (!result.success) {
      console.error(`[drain] Drain failed: ${result.error}`);
      return;
    }

    const { drained, failed } = result.data!;
    if (drained > 0 || failed > 0) {
      console.log(`[drain] Drained ${drained} op(s), ${failed} failed`);
      if (drained > 0) incCounter(blockchainOpsDrainedTotal, {}, drained);
      if (failed > 0) incCounter(blockchainOpsFailedTotal, {}, failed);
    }
  } catch (err) {
    console.error('[drain] Scheduler error:', err);
  }
}

// ─── Sync lag + inbox metrics refresh ────────────────────────────────────────

/**
 * Refresh Prometheus gauges for sync lag, dead-letter depth, and inbox
 * status counts.  Called every 2 minutes so the /metrics endpoint always
 * reflects a reasonably current view without hitting the DB on every scrape.
 *
 * Because the metrics registry uses incrementing counters (not settable
 * gauges), we record the delta since the last refresh.  For lag and DLQ
 * depth — which can go down as well as up — we use an absolute snapshot
 * approach: each refresh reads the current value and records it as a new
 * labelled time-series sample.  Grafana/Prometheus operators should use
 * `rate()` or `last_over_time()` depending on the metric type.
 */
async function runMetricsRefresh(): Promise<void> {
  try {
    const [lagResult, inboxResult] = await Promise.all([
      computeLag(),
      getInboxStats(),
    ]);

    // ── Lag gauges ─────────────────────────────────────────────────────────
    if (lagResult.success) {
      for (const l of lagResult.data!) {
        if (l.lag_ledgers !== null) {
          incCounter(syncLagLedgers, { entity_type: l.entity_type }, l.lag_ledgers);
        }
        if (l.stalled) {
          console.warn(
            `[metrics] Sync worker stalled for entity_type=${l.entity_type} ` +
            `last_advanced_at=${l.last_advanced_at ?? 'never'}`,
          );
        }
      }
    } else {
      console.error(`[metrics] Lag refresh failed: ${lagResult.error}`);
    }

    // ── Inbox status / DLQ depth ───────────────────────────────────────────
    if (inboxResult.success) {
      const { dead, failed, processed_last_hour } = inboxResult.data!;

      // DLQ depth — a non-zero and non-decreasing value should alert.
      incCounter(syncDeadLetterDepth, {}, dead);

      // Log DLQ depth prominently so it appears in structured log streams.
      if (dead > 0) {
        console.warn(`[dlq] Dead-letter depth: ${dead} event(s) awaiting operator review`);
      }

      // Status totals (for throughput tracking in Grafana).
      incCounter(syncInboxStatusTotal, { status: 'dead' }, dead);
      incCounter(syncInboxStatusTotal, { status: 'failed' }, failed);
      incCounter(syncInboxStatusTotal, { status: 'processed' }, processed_last_hour);
    } else {
      console.error(`[metrics] Inbox stats refresh failed: ${inboxResult.error}`);
    }

    // ── Pending ops queue depth ────────────────────────────────────────────
    const pendingOpsResult = await getPendingOpsStats();
    if (pendingOpsResult.success) {
      const { queued, failed: opsFailed } = pendingOpsResult.data!;
      const total = queued + opsFailed;
      if (total > 0) {
        incCounter(blockchainPendingOpsDepth, {}, total);
        console.warn(
          `[drain] Pending on-chain ops: ${queued} queued, ${opsFailed} failed`,
        );
      }
    }
  } catch (err) {
    console.error('[metrics] Refresh error:', err);
  }
}

// ─── Idempotency cleanup ──────────────────────────────────────────────────────

async function runIdempotencyCleanup(): Promise<void> {
  const result = await purgeExpiredIdempotencyKeys();
  if (result.success) {
    if ((result.data?.deleted ?? 0) > 0) {
      console.log(`[idempotency] Purged ${result.data?.deleted} expired key(s)`);
    }
  } else {
    console.error(`[idempotency] Cleanup failed: ${result.error}`);
  }
}

// ─── Booking expiry ───────────────────────────────────────────────────────────

async function runBookingExpiryCleanup(): Promise<void> {
  const result = await bookingService.expireStaleBookings();
  if (result.success) {
    const { expired, failed } = result.data ?? { expired: 0, failed: 0 };
    if (expired > 0 || failed > 0) {
      console.log(`[expiry] Expired ${expired} booking(s), ${failed} failure(s)`);
    }
  } else {
    console.error(`[expiry] Cleanup failed: ${result.error}`);
  }
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Start all background job loops.  Called once from src/index.ts after the
 * HTTP server begins listening.
 */
export function startSyncScheduler(): void {
  // ── Blockchain sync ───────────────────────────────────────────────────────
  setInterval(() => {
    runSync().catch((err) => console.error('[sync] Scheduler error:', err));
  }, SYNC_INTERVAL_MS);

  // ── Escrow reconciliation ─────────────────────────────────────────────────
  setInterval(() => {
    runEscrowReconciliation().catch((err) =>
      console.error('[reconcile] Scheduler error:', err),
    );
  }, RECONCILIATION_INTERVAL_MS);

  // ── Ledger event DLQ retry ────────────────────────────────────────────────
  setInterval(() => {
    runDlqRetry().catch((err) => console.error('[dlq] Scheduler error:', err));
  }, DLQ_RETRY_INTERVAL_MS);

  // ── Blockchain pending-ops drain (recovery after outage) ──────────────────
  setInterval(() => {
    runPendingOpsDrain().catch((err) => console.error('[drain] Scheduler error:', err));
  }, PENDING_OPS_DRAIN_INTERVAL_MS);

  // ── Sync lag + inbox metrics ──────────────────────────────────────────────
  setInterval(() => {
    runMetricsRefresh().catch((err) => console.error('[metrics] Scheduler error:', err));
  }, METRICS_REFRESH_INTERVAL_MS);

  // ── Idempotency key cleanup ───────────────────────────────────────────────
  setInterval(() => {
    runIdempotencyCleanup().catch((err) =>
      console.error('[idempotency] Cleanup error:', err),
    );
  }, IDEMPOTENCY_CLEANUP_INTERVAL_MS);

  // ── Booking expiry cleanup ────────────────────────────────────────────────
  setInterval(() => {
    runBookingExpiryCleanup().catch((err) =>
      console.error('[expiry] Scheduler error:', err),
    );
  }, BOOKING_EXPIRY_INTERVAL_MS);

  // ── Data-retention cleanup ────────────────────────────────────────────────
  setInterval(() => {
    runDataRetention().catch((err) => console.error('[retention] Scheduler error:', err));
  }, RETENTION_INTERVAL_MS);

  // ── Startup tasks ─────────────────────────────────────────────────────────
  // Run idempotency + expiry cleanup soon after startup to drain stale records
  // that might have been created during a server restart.
  setTimeout(() => {
    runIdempotencyCleanup().catch((err) =>
      console.error('[idempotency] Initial cleanup error:', err),
    );
    runBookingExpiryCleanup().catch((err) =>
      console.error('[expiry] Initial cleanup error:', err),
    );
    // Seed metrics on first scrape rather than waiting 2 minutes.
    runMetricsRefresh().catch((err) =>
      console.error('[metrics] Initial refresh error:', err),
    );
    // Attempt an initial drain in case ops were queued before the last restart.
    runPendingOpsDrain().catch((err) =>
      console.error('[drain] Initial drain error:', err),
    );
  }, 30_000); // 30 s after startup

  // Startup dry-run preview of retention — lets operators see what the next
  // scheduled run will touch before it mutates data.
  setTimeout(() => {
    runDataRetention({ dryRun: true, label: 'startup-preview' }).catch((err) =>
      console.error('[retention] Startup preview error:', err),
    );
  }, RETENTION_STARTUP_PREVIEW_DELAY_MS);

  // Optional immediate live retention run after a policy change.
  if (env.RETENTION_RUN_ON_STARTUP) {
    setTimeout(() => {
      runDataRetention({ dryRun: false, label: 'startup-live' }).catch((err) =>
        console.error('[retention] Startup live-run error:', err),
      );
    }, 60_000); // 60 s — after the dry-run preview
  }

  console.log(
    '[sync] Scheduler started — ' +
    `sync: ${SYNC_INTERVAL_MS / 1000}s, ` +
    `reconcile: ${RECONCILIATION_INTERVAL_MS / 1000}s, ` +
    `dlq-retry: ${DLQ_RETRY_INTERVAL_MS / 1000}s, ` +
    `pending-ops-drain: ${PENDING_OPS_DRAIN_INTERVAL_MS / 1000}s, ` +
    `metrics: ${METRICS_REFRESH_INTERVAL_MS / 1000}s, ` +
    `idempotency-cleanup: ${IDEMPOTENCY_CLEANUP_INTERVAL_MS / 1000}s, ` +
    `expiry: ${BOOKING_EXPIRY_INTERVAL_MS / 1000}s`,
  );
}
