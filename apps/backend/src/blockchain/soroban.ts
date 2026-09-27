import {
  FeeBumpTransaction,
  Keypair,
  Transaction,
  TransactionBuilder,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import { performance } from 'node:perf_hooks';
import { BASE_FEE, NETWORK_PASSPHRASE, STELLAR_RPC_URL } from './config.js';
import { TransactionError } from './errors.js';
import { sorobanBreaker } from '@/services/chainCircuitBreaker.service.js';
import {
  incCounter,
  observeHistogram,
  blockchainRpcCallsTotal,
  blockchainRpcDurationSeconds,
} from '@/middleware/metrics.middleware.js';

const POLL_INTERVAL_MS = 1000;
const MAX_POLL_ATTEMPTS = 30;

export function getSorobanServer(): rpc.Server {
  return new rpc.Server(STELLAR_RPC_URL, {
    allowHttp: STELLAR_RPC_URL.startsWith('http://'),
  });
}

const RPC_HEALTH_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Stellar RPC health check timed out')), ms);
    }),
  ]);
}

/**
 * Verify Stellar RPC connectivity with a bounded-time getHealth() probe.
 *
 * Also feeds the circuit breaker: a healthy response closes it (if HALF_OPEN),
 * a failure increments its failure counter.
 *
 * @returns true if the RPC endpoint reports "healthy" within the timeout, false otherwise
 */
export async function getRpcHealth(): Promise<boolean> {
  try {
    const server = getSorobanServer();
    const health = await withTimeout(server.getHealth(), RPC_HEALTH_TIMEOUT_MS);
    const isHealthy = health.status === 'healthy';

    if (isHealthy) {
      sorobanBreaker.recordSuccess();
    } else {
      sorobanBreaker.recordFailure(new Error('RPC reported unhealthy'));
    }

    return isHealthy;
  } catch (err) {
    sorobanBreaker.recordFailure(err);
    return false;
  }
}

// ─── Instrumented RPC helpers ─────────────────────────────────────────────────

/**
 * Measure a single RPC call and record to Prometheus.
 * Internal helper — callers use submitAndWait / simulateReadOnly instead.
 */
async function trackedRpcCall<T>(
  method: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = performance.now();
  try {
    const result = await fn();
    const dur = (performance.now() - start) / 1000;
    incCounter(blockchainRpcCallsTotal, { method, outcome: 'success' });
    observeHistogram(blockchainRpcDurationSeconds, { method }, dur);
    return result;
  } catch (err) {
    const dur = (performance.now() - start) / 1000;
    incCounter(blockchainRpcCallsTotal, { method, outcome: 'failure' });
    observeHistogram(blockchainRpcDurationSeconds, { method }, dur);
    throw err;
  }
}

/**
 * Submit a signed Soroban transaction and poll until it is confirmed.
 *
 * Wrapped in the circuit breaker: throws CircuitOpenError immediately when
 * the Soroban RPC breaker is OPEN (no network round-trip).
 */
export async function submitAndWait(
  server: rpc.Server,
  tx: Transaction,
): Promise<rpc.Api.GetTransactionResponse> {
  return sorobanBreaker.execute(async () => {
    const sendResponse = await trackedRpcCall('sendTransaction', () =>
      server.sendTransaction(tx),
    );

    if (sendResponse.status === 'ERROR') {
      const detail =
        sendResponse.errorResult?.toXDR('base64') ?? 'unknown error';
      throw new TransactionError(`Transaction submission failed: ${detail}`);
    }

    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      const getResponse = await trackedRpcCall('getTransaction', () =>
        server.getTransaction(sendResponse.hash),
      );

      if (getResponse.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
        if (getResponse.status === rpc.Api.GetTransactionStatus.FAILED) {
          throw new TransactionError(
            'Transaction failed on-chain',
            sendResponse.hash,
          );
        }
        return getResponse;
      }

      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new TransactionError(
      `Transaction not confirmed after ${MAX_POLL_ATTEMPTS} attempts`,
      sendResponse.hash,
    );
  });
}

/**
 * Wrap an inner transaction in a fee-bump and sign with the fee-source keypair.
 */
export function buildFeeBump(
  innerTx: Transaction,
  feeSourceKeypair: Keypair,
): FeeBumpTransaction {
  const bumpFee = String(Math.max(200, Number(BASE_FEE) * 10));
  const feeBump = TransactionBuilder.buildFeeBumpTransaction(
    feeSourceKeypair,
    bumpFee,
    innerTx,
    NETWORK_PASSPHRASE,
  );
  feeBump.sign(feeSourceKeypair);
  return feeBump;
}

/**
 * Simulate a read-only contract call and return the result ScVal.
 *
 * Wrapped in the circuit breaker: throws CircuitOpenError when the
 * Soroban RPC breaker is OPEN.
 */
export async function simulateReadOnly(
  server: rpc.Server,
  tx: Transaction,
  methodName: string,
): Promise<xdr.ScVal> {
  return sorobanBreaker.execute(async () => {
    const simResult = await trackedRpcCall('simulateTransaction', () =>
      server.simulateTransaction(tx),
    );

    if (rpc.Api.isSimulationError(simResult)) {
      throw new TransactionError(
        `Simulation failed for ${methodName}: ${(simResult as rpc.Api.SimulateTransactionErrorResponse).error}`,
      );
    }

    const success = simResult as rpc.Api.SimulateTransactionSuccessResponse;
    if (!success.result?.retval) {
      throw new TransactionError(`No return value from ${methodName}`);
    }

    return success.result.retval;
  });
}
