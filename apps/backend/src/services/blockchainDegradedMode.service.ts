/**
 * blockchainDegradedMode.service.ts
 *
 * Coordinates safe behaviour during Stellar RPC and TrustlessWork outages.
 *
 * ## Responsibilities
 *
 * 1. **Deferred submission queue** — on-chain operations that would normally
 *    be submitted live are written to `blockchain_pending_ops` when the
 *    circuit breaker is OPEN. The drain loop (called by cleanup-schedular.ts)
 *    replays them once the breaker closes.
 *
 * 2. **Drain loop** — claims queued ops, re-executes them against the live
 *    dependency, marks done / failed.
 *
 * 3. **Queue depth accessor** — used by the health endpoint and Prometheus
 *    metrics to expose how many ops are waiting.
 *
 * ## Idempotency
 *
 * Every enqueued op has an `idempotency_key` (bookingId:opType:nonce).
 * The UNIQUE constraint on that column means enqueueing the same logical
 * operation twice is a silent no-op — the drain loop will process it once.
 *
 * ## Stale-claim reclaim
 *
 * If the drain loop crashes while processing a row, the row stays in
 * `draining` status. A stale-claim threshold (5 min) causes it to be
 * reclaimed on the next drain cycle.
 */

import os from 'node:os';
import { supabase } from '@/config/supabase.js';
import type { ServiceResponse } from './index.js';

// ─── Constants ────────────────────────────────────────────────────────────────

export const STALE_DRAIN_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_ATTEMPTS = 5;

// ─── Types ────────────────────────────────────────────────────────────────────

export type PendingOpType =
  | 'create_booking_on_chain'
  | 'cancel_booking_on_chain'
  | 'update_booking_status_on_chain'
  | 'release_escrow'
  | 'cancel_escrow';

export interface PendingOp {
  id: string;
  booking_id: string;
  op_type: PendingOpType;
  idempotency_key: string;
  payload: Record<string, unknown>;
  status: 'queued' | 'draining' | 'done' | 'failed';
  attempt_count: number;
  max_attempts: number;
  last_error: string | null;
  last_attempted_at: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface EnqueueOpParams {
  booking_id: string;
  op_type: PendingOpType;
  /** Unique nonce appended to the key to distinguish separate ops of the same type on the same booking. */
  nonce?: string;
  payload: Record<string, unknown>;
}

// ─── Enqueue ──────────────────────────────────────────────────────────────────

/**
 * Persist an on-chain operation to the durable queue.
 *
 * Idempotent: if the same idempotency_key already exists the insert is a
 * no-op and the existing row is returned.
 */
export async function enqueueOp(
  params: EnqueueOpParams,
): Promise<ServiceResponse<{ enqueued: boolean; op: PendingOp }>> {
  const { booking_id, op_type, nonce = '0', payload } = params;
  const idempotency_key = `${booking_id}:${op_type}:${nonce}`;

  const { error: insertError } = await supabase
    .from('blockchain_pending_ops')
    .insert({
      booking_id,
      op_type,
      idempotency_key,
      payload,
      status: 'queued',
      attempt_count: 0,
      max_attempts: DEFAULT_MAX_ATTEMPTS,
    });

  const isDuplicate =
    insertError?.code === '23505' ||
    insertError?.message?.includes('uq_blockchain_pending_ops_key');

  if (insertError && !isDuplicate) {
    return { success: false, error: `enqueue failed: ${insertError.message}` };
  }

  const { data, error: fetchError } = await supabase
    .from('blockchain_pending_ops')
    .select('*')
    .eq('idempotency_key', idempotency_key)
    .single();

  if (fetchError || !data) {
    return {
      success: false,
      error: `enqueue fetch failed: ${fetchError?.message ?? 'not found'}`,
    };
  }

  return {
    success: true,
    data: { enqueued: !isDuplicate, op: data as PendingOp },
  };
}

// ─── Claim (drain loop internal) ──────────────────────────────────────────────

/**
 * Atomically claim the next queued op for draining.
 *
 * Also reclaims stale `draining` rows whose `claimed_at` is older than
 * STALE_DRAIN_THRESHOLD_MS — handles crashed drain workers.
 */
async function claimNextOp(): Promise<PendingOp | null> {
  const staleCutoff = new Date(Date.now() - STALE_DRAIN_THRESHOLD_MS).toISOString();
  const workerId = `${os.hostname()}:${process.pid}`;

  const { data: rows } = await supabase
    .from('blockchain_pending_ops')
    .select('id, attempt_count')
    .or(`status.eq.queued,and(status.eq.draining,claimed_at.lt.${staleCutoff})`)
    .order('created_at', { ascending: true })
    .limit(1);

  if (!rows || rows.length === 0) return null;

  const candidate = rows[0] as Pick<PendingOp, 'id' | 'attempt_count'>;

  const { data: claimed } = await supabase
    .from('blockchain_pending_ops')
    .update({
      status: 'draining',
      claimed_by: workerId,
      claimed_at: new Date().toISOString(),
      attempt_count: candidate.attempt_count + 1,
      last_attempted_at: new Date().toISOString(),
    })
    .eq('id', candidate.id)
    .or(`status.eq.queued,and(status.eq.draining,claimed_at.lt.${staleCutoff})`)
    .select('*')
    .maybeSingle();

  return claimed ? (claimed as PendingOp) : null;
}

// ─── Resolve / fail (drain loop internal) ────────────────────────────────────

async function resolveOp(opId: string): Promise<void> {
  await supabase
    .from('blockchain_pending_ops')
    .update({
      status: 'done',
      completed_at: new Date().toISOString(),
      claimed_by: null,
      last_error: null,
    })
    .eq('id', opId);
}

async function failOp(opId: string, errorMessage: string, attemptCount: number, maxAttempts: number): Promise<void> {
  const newStatus = attemptCount >= maxAttempts ? 'failed' : 'queued';
  await supabase
    .from('blockchain_pending_ops')
    .update({
      status: newStatus,
      last_error: errorMessage.slice(0, 2048),
      claimed_by: null,
      claimed_at: null,
    })
    .eq('id', opId);
}

// ─── Drain loop ───────────────────────────────────────────────────────────────

/**
 * Drain-loop executor type: given a claimed PendingOp, perform the actual
 * on-chain call and return success or throw on error.
 *
 * This is injected by cleanup-schedular.ts so the degraded-mode service
 * stays free of circular dependencies on bookingContract.ts / trustlessWork.ts.
 */
export type OpExecutor = (op: PendingOp) => Promise<void>;

/**
 * Drain one batch of queued ops.
 *
 * Called by the scheduler after the circuit breaker closes.
 * `executor` is provided by the caller (cleanup-schedular.ts) which knows
 * how to dispatch each op_type to the correct downstream.
 *
 * @param executor  - Function that performs the actual on-chain call.
 * @param batchSize - Maximum ops to process per drain cycle. Default: 10.
 * @returns Summary of drained / failed ops in this batch.
 */
export async function drainPendingOps(
  executor: OpExecutor,
  batchSize = 10,
): Promise<ServiceResponse<{ drained: number; failed: number }>> {
  let drained = 0;
  let failed = 0;

  for (let i = 0; i < batchSize; i++) {
    const op = await claimNextOp();
    if (!op) break; // queue empty

    try {
      await executor(op);
      await resolveOp(op.id);
      drained++;
    } catch (err) {
      const message = (err as Error).message;
      await failOp(op.id, message, op.attempt_count, op.max_attempts);
      failed++;
      console.error(
        `[DegradedMode] Drain failed op=${op.id} type=${op.op_type} ` +
          `booking=${op.booking_id} attempt=${op.attempt_count}: ${message}`,
      );
    }
  }

  return { success: true, data: { drained, failed } };
}

// ─── Queue depth accessors ────────────────────────────────────────────────────

/**
 * Returns counts by status for the Prometheus metrics exporter and
 * the /health endpoint.
 */
export async function getPendingOpsStats(): Promise<
  ServiceResponse<{
    queued: number;
    draining: number;
    failed: number;
    done_last_hour: number;
  }>
> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const [qRes, drRes, fRes, dRes] = await Promise.all([
    supabase
      .from('blockchain_pending_ops')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'queued'),
    supabase
      .from('blockchain_pending_ops')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'draining'),
    supabase
      .from('blockchain_pending_ops')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'failed'),
    supabase
      .from('blockchain_pending_ops')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'done')
      .gte('completed_at', oneHourAgo),
  ]);

  for (const res of [qRes, drRes, fRes, dRes]) {
    if (res.error) {
      return { success: false, error: `pending ops stats failed: ${res.error.message}` };
    }
  }

  return {
    success: true,
    data: {
      queued: qRes.count ?? 0,
      draining: drRes.count ?? 0,
      failed: fRes.count ?? 0,
      done_last_hour: dRes.count ?? 0,
    },
  };
}

/**
 * List failed pending ops for operator inspection (admin endpoint).
 */
export async function listFailedOps(
  limit = 50,
  offset = 0,
): Promise<ServiceResponse<{ ops: PendingOp[]; total: number }>> {
  const { data, error, count } = await supabase
    .from('blockchain_pending_ops')
    .select('*', { count: 'exact' })
    .eq('status', 'failed')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    return { success: false, error: `list failed ops: ${error.message}` };
  }

  return {
    success: true,
    data: { ops: (data ?? []) as PendingOp[], total: count ?? 0 },
  };
}
