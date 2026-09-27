import { getRpcHealth } from '@/blockchain/soroban.js';
import { pingRedis } from '@/config/redis.js';
import { supabase } from '@/config/supabase.js';
import { type Request, type Response, Router } from 'express';
import { getAllBreakerSnapshots } from '@/services/chainCircuitBreaker.service.js';
import { getPendingOpsStats } from '@/services/blockchainDegradedMode.service.js';

const router = Router();

export type HealthStatus = 'ok' | 'error' | 'not_configured';

/**
 * Probe database connectivity. Never throws — resolves to false on failure.
 */
export async function pingDatabase(): Promise<boolean> {
  try {
    const { error } = await supabase.from('properties').select('id').limit(1);
    return !error;
  } catch {
    return false;
  }
}

/**
 * Turn a settled probe result into a health status.
 * `null` means the dependency isn't configured; a rejection is treated as a failure.
 */
export function toHealthStatus(result: PromiseSettledResult<boolean | null>): HealthStatus {
  if (result.status === 'rejected') return 'error';
  if (result.value === null) return 'not_configured';
  return result.value ? 'ok' : 'error';
}

/**
 * Detailed health check endpoint that verifies:
 * - API is running
 * - Database connectivity
 * - Redis connectivity (if configured)
 * - Blockchain RPC status
 * - Circuit breaker states for soroban-rpc and trustlesswork-api
 * - Pending operations queue depth (deferred during outages)
 *
 * Each dependency is probed concurrently with a bounded timeout. Returns
 * HTTP 503 with status "degraded" if any configured dependency is down.
 *
 * @openapi
 * /health:
 *   get:
 *     tags: [Health]
 *     summary: Dependency health check
 *     responses:
 *       200:
 *         description: All configured dependencies healthy
 *       503:
 *         description: One or more dependencies degraded
 */
router.get('/health', async (_req: Request, res: Response) => {
  const [databaseResult, redisResult, blockchainResult, pendingOpsResult] =
    await Promise.allSettled([
      pingDatabase(),
      process.env.REDIS_URL ? pingRedis() : Promise.resolve(null),
      process.env.STELLAR_RPC_URL ? getRpcHealth() : Promise.resolve(null),
      getPendingOpsStats(),
    ]);

  const checks: Record<'database' | 'redis' | 'blockchain', HealthStatus> = {
    database: toHealthStatus(databaseResult),
    redis: toHealthStatus(redisResult),
    blockchain: toHealthStatus(blockchainResult),
  };

  const degraded = Object.values(checks).some((check) => check === 'error');

  // Collect circuit breaker snapshots — never throw, always include.
  const circuitBreakers = getAllBreakerSnapshots().map((s) => ({
    name: s.name,
    state: s.state,
    failureCount: s.failureCount,
    retriableInMs: s.retriableInMs,
    lastFailureAt: s.lastFailureAt,
    lastSuccessAt: s.lastSuccessAt,
    totalCalls: s.totalCalls,
    totalFailures: s.totalFailures,
  }));

  // Pending operations queue depth — null if the query failed.
  const pendingOps =
    pendingOpsResult.status === 'fulfilled' && pendingOpsResult.value.success
      ? pendingOpsResult.value.data
      : null;

  res.status(degraded ? 503 : 200).json({
    status: degraded ? 'degraded' : 'ok',
    service: 'Rentars API 🚀',
    timestamp: new Date().toISOString(),
    checks,
    circuitBreakers,
    pendingOps,
  });
});

export default router;
