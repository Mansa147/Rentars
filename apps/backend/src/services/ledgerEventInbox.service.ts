/**
 * ledgerEventInbox.service.ts — write-before-process inbox for ledger events.
 *
 * ## Purpose
 * Every sync worker projection (booking, property, review, payment) must
 * write an inbox record BEFORE applying the projection.  This guarantees
 * that if the process crashes mid-projection the event can be retried on
 * restart without re-scanning the full ledger history.
 *
 * ## Idempotency guarantee
 * The canonical `event_key` has a UNIQUE database constraint.  Inserting a
 * duplicate key is a silent no-op (`ON CONFLICT DO NOTHING`).  Callers can
 * therefore call `writeEvent()` on every poll tick without checking whether
 * the event was already seen — the database enforces uniqueness cheaply.
 *
 * ## Canonical event_key format
 *   "<entity_type>:<contract_id>:<ledger_sequence>:<tx_hash>"
 *   e.g. "booking:CBOOKI…:47821345:abcdef12…"
 *
 * When a transaction hash is unavailable (polling-based sync), the on-chain
 * entity_id acts as the discriminator:
 *   "<entity_type>:<contract_id>:<ledger_sequence>:entity:<entity_id>"
 *
 * ## Lifecycle
 *   pending    → written, not yet claimed
 *   processing → claimed by a worker (lock held)
 *   processed  → projection committed successfully
 *   failed     → last attempt errored, will be retried up to max_attempts
 *   dead       → exhausted retries; moved to dead-letter for operator review
 *
 * ## Dead-letter promotion
 * When attempt_count >= max_attempts the row is moved to `dead` status.
 * A separate DLQ cleanup job (cleanup-schedular.ts) scans dead rows and
 * exposes them via the /admin/sync/status endpoint.
 */

import { createHash } from 'node:crypto';
import os from 'node:os';
import { supabase } from '@/config/supabase.js';
import type { ServiceResponse } from './index.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default maximum projection attempts before a row is dead-lettered. */
export const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * After this many milliseconds a `processing` claim is considered stale
 * (worker crashed without releasing the lock) and may be reclaimed.
 */
export const STALE_CLAIM_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// ─── Types ────────────────────────────────────────────────────────────────────

export type EventEntityType = 'booking' | 'property' | 'review' | 'payment';
export type EventStatus = 'pending' | 'processing' | 'processed' | 'failed' | 'dead';

export interface LedgerEvent {
  id: string;
  event_key: string;
  entity_type: EventEntityType;
  entity_id: string;
  contract_id: string;
  ledger_sequence: number;
  tx_hash: string | null;
  payload: Record<string, unknown>;
  status: EventStatus;
  claimed_by: string | null;
  claimed_at: string | null;
  attempt_count: number;
  max_attempts: number;
  last_error: string | null;
  last_attempted_at: string | null;
  created_at: string;
  processed_at: string | null;
}

export interface WriteEventParams {
  entity_type: EventEntityType;
  entity_id: string;
  contract_id: string;
  ledger_sequence: number;
  tx_hash?: string | null;
  payload?: Record<string, unknown>;
  max_attempts?: number;
}

export interface ClaimResult {
  /** The claimed event, or null if the queue is empty. */
  event: LedgerEvent | null;
}

// ─── Canonical key builder ────────────────────────────────────────────────────

/**
 * Build the canonical deduplication key for a ledger event.
 *
 * Format:
 *   With tx_hash:    "<type>:<contract>:<sequence>:<hash>"
 *   Without tx_hash: "<type>:<contract>:<sequence>:entity:<entity_id>"
 */
export function buildEventKey(
  entityType: EventEntityType,
  contractId: string,
  ledgerSequence: number,
  txHashOrEntityId: { txHash: string } | { entityId: string },
): string {
  const discriminator =
    'txHash' in txHashOrEntityId
      ? txHashOrEntityId.txHash
      : `entity:${txHashOrEntityId.entityId}`;

  return `${entityType}:${contractId}:${ledgerSequence}:${discriminator}`;
}

/**
 * SHA-256 of the payload JSONB (sorted keys) — useful for detecting
 * reordered-but-identical events that carry the same semantic state.
 */
export function hashPayload(payload: Record<string, unknown>): string {
  const stable = JSON.stringify(payload, Object.keys(payload).sort());
  return createHash('sha256').update(stable).digest('hex');
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Persist a ledger event to the inbox before the projection is applied.
 *
 * Idempotent: if the event_key already exists the INSERT is silently skipped
 * and the existing row is returned.  Callers do not need to pre-check.
 *
 * @returns `{ written: true, event }` on a fresh insert.
 *          `{ written: false, event }` when the key already existed (duplicate).
 */
export async function writeEvent(
  params: WriteEventParams,
): Promise<ServiceResponse<{ written: boolean; event: LedgerEvent }>> {
  const {
    entity_type,
    entity_id,
    contract_id,
    ledger_sequence,
    tx_hash,
    payload = {},
    max_attempts = DEFAULT_MAX_ATTEMPTS,
  } = params;

  const event_key = buildEventKey(
    entity_type,
    contract_id,
    ledger_sequence,
    tx_hash ? { txHash: tx_hash } : { entityId: entity_id },
  );

  // Attempt insert — ON CONFLICT DO NOTHING ensures idempotency.
  const { error: insertError } = await supabase
    .from('ledger_event_inbox')
    .insert({
      event_key,
      entity_type,
      entity_id,
      contract_id,
      ledger_sequence,
      tx_hash: tx_hash ?? null,
      payload,
      status: 'pending',
      attempt_count: 0,
      max_attempts,
    });

  // A unique-constraint violation (code 23505) means duplicate — fetch existing.
  const isDuplicate =
    insertError?.code === '23505' ||
    insertError?.message?.includes('uq_ledger_event_inbox_key');

  if (insertError && !isDuplicate) {
    return { success: false, error: `inbox write failed: ${insertError.message}` };
  }

  // Fetch the canonical row (fresh insert or existing duplicate).
  const { data, error: fetchError } = await supabase
    .from('ledger_event_inbox')
    .select('*')
    .eq('event_key', event_key)
    .single();

  if (fetchError || !data) {
    return {
      success: false,
      error: `inbox fetch after write failed: ${fetchError?.message ?? 'not found'}`,
    };
  }

  return {
    success: true,
    data: { written: !isDuplicate, event: data as LedgerEvent },
  };
}

// ─── Claim ────────────────────────────────────────────────────────────────────

/**
 * Atomically claim the next pending event from the inbox.
 *
 * Uses optimistic locking: SELECT the oldest pending row, then UPDATE
 * WHERE status = 'pending' to set it to 'processing'.  If the UPDATE
 * touches 0 rows (another worker raced us) we return `{ event: null }`.
 *
 * Also reclaims stale `processing` rows whose `claimed_at` is older than
 * STALE_CLAIM_THRESHOLD_MS — this handles crashed workers.
 *
 * @param entityType - If supplied, only claim events of this type.
 */
export async function claimNextEvent(
  entityType?: EventEntityType,
): Promise<ServiceResponse<ClaimResult>> {
  const staleCutoff = new Date(Date.now() - STALE_CLAIM_THRESHOLD_MS).toISOString();
  const workerId = `${os.hostname()}:${process.pid}`;

  // Find the oldest claimable row:
  //   • status = 'pending', OR
  //   • status = 'processing' AND claimed_at is stale (crashed worker)
  let query = supabase
    .from('ledger_event_inbox')
    .select('id, status, attempt_count, max_attempts, event_key')
    .or(`status.eq.pending,and(status.eq.processing,claimed_at.lt.${staleCutoff})`)
    .order('ledger_sequence', { ascending: true })
    .limit(1);

  if (entityType) {
    query = query.eq('entity_type', entityType);
  }

  const { data: rows, error: selectError } = await query;

  if (selectError) {
    return { success: false, error: `inbox claim select failed: ${selectError.message}` };
  }

  if (!rows || rows.length === 0) {
    return { success: true, data: { event: null } };
  }

  const candidate = rows[0] as Pick<LedgerEvent, 'id' | 'status' | 'attempt_count' | 'max_attempts' | 'event_key'>;

  // Attempt the optimistic claim.
  const { data: claimed, error: updateError } = await supabase
    .from('ledger_event_inbox')
    .update({
      status: 'processing',
      claimed_by: workerId,
      claimed_at: new Date().toISOString(),
      attempt_count: candidate.attempt_count + 1,
      last_attempted_at: new Date().toISOString(),
    })
    .eq('id', candidate.id)
    // Only win the race if the row is still in the expected claimable state.
    .or(`status.eq.pending,and(status.eq.processing,claimed_at.lt.${staleCutoff})`)
    .select('*')
    .maybeSingle();

  if (updateError) {
    return { success: false, error: `inbox claim update failed: ${updateError.message}` };
  }

  // Another worker won the race — return empty.
  if (!claimed) {
    return { success: true, data: { event: null } };
  }

  return { success: true, data: { event: claimed as LedgerEvent } };
}

// ─── Resolve ──────────────────────────────────────────────────────────────────

/**
 * Mark a claimed event as successfully processed.
 *
 * Sets status → 'processed' and records the processed_at timestamp.
 * Safe to call multiple times — idempotent via the WHERE clause.
 */
export async function resolveEvent(eventId: string): Promise<ServiceResponse<void>> {
  const { error } = await supabase
    .from('ledger_event_inbox')
    .update({
      status: 'processed',
      processed_at: new Date().toISOString(),
      claimed_by: null,
      last_error: null,
    })
    .eq('id', eventId);

  if (error) {
    return { success: false, error: `inbox resolve failed: ${error.message}` };
  }
  return { success: true };
}

// ─── Fail ─────────────────────────────────────────────────────────────────────

/**
 * Record a failed projection attempt.
 *
 * If attempt_count < max_attempts → status = 'failed' (will be retried).
 * If attempt_count >= max_attempts → status = 'dead' (dead-lettered).
 *
 * Returns `{ deadLettered: true }` when the row is promoted to dead.
 */
export async function failEvent(
  eventId: string,
  errorMessage: string,
): Promise<ServiceResponse<{ deadLettered: boolean }>> {
  // First read current counters.
  const { data: row, error: fetchError } = await supabase
    .from('ledger_event_inbox')
    .select('attempt_count, max_attempts')
    .eq('id', eventId)
    .single();

  if (fetchError || !row) {
    return {
      success: false,
      error: `inbox fail fetch failed: ${fetchError?.message ?? 'not found'}`,
    };
  }

  const { attempt_count, max_attempts } = row as Pick<LedgerEvent, 'attempt_count' | 'max_attempts'>;
  const deadLettered = attempt_count >= max_attempts;
  const newStatus: EventStatus = deadLettered ? 'dead' : 'failed';

  const { error: updateError } = await supabase
    .from('ledger_event_inbox')
    .update({
      status: newStatus,
      last_error: errorMessage.slice(0, 2048), // cap to avoid bloated rows
      claimed_by: null,
      claimed_at: null,
    })
    .eq('id', eventId);

  if (updateError) {
    return { success: false, error: `inbox fail update failed: ${updateError.message}` };
  }

  return { success: true, data: { deadLettered } };
}

// ─── Retry queue ──────────────────────────────────────────────────────────────

/**
 * Re-queue failed events whose retry back-off window has elapsed.
 *
 * Promotes `failed` rows back to `pending` so the next claimNextEvent() call
 * picks them up.  Only re-queues rows where attempt_count < max_attempts —
 * rows that have exhausted retries should already be `dead`, but this guard
 * prevents any edge-case row from looping indefinitely.
 *
 * @param olderThanMs - Minimum age since last_attempted_at before re-queuing.
 *                      Implements exponential back-off when the caller passes
 *                      a growing interval.
 * @returns The number of rows re-queued.
 */
export async function requeueFailedEvents(
  olderThanMs = 60_000,
): Promise<ServiceResponse<{ requeued: number }>> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();

  // Re-queue failed rows whose last attempt was old enough AND that have not
  // exhausted their max_attempts budget.
  // Note: PostgREST does not support column-to-column comparisons in filters,
  // so we use a raw RPC call via supabase.rpc or rely on the DB enforcing
  // `dead` status for exhausted rows.  As a defensive belt-and-suspenders
  // guard we also filter attempt_count < DEFAULT_MAX_ATTEMPTS on the client.
  const { data, error } = await supabase
    .from('ledger_event_inbox')
    .update({ status: 'pending' })
    .eq('status', 'failed')
    .lt('last_attempted_at', cutoff)
    .lt('attempt_count', DEFAULT_MAX_ATTEMPTS) // guard: never re-queue exhausted rows
    .select('id');

  if (error) {
    return { success: false, error: `inbox requeue failed: ${error.message}` };
  }

  const requeued = Array.isArray(data) ? data.length : 0;
  return { success: true, data: { requeued } };
}

// ─── Dead-letter inspection ───────────────────────────────────────────────────

/**
 * Return dead-lettered events for operator inspection.
 *
 * @param limit  - Page size (default 50).
 * @param offset - Page offset for pagination.
 */
export async function listDeadLetterEvents(
  limit = 50,
  offset = 0,
): Promise<ServiceResponse<{ events: LedgerEvent[]; total: number }>> {
  const { data, error, count } = await supabase
    .from('ledger_event_inbox')
    .select('*', { count: 'exact' })
    .eq('status', 'dead')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    return { success: false, error: `dead-letter list failed: ${error.message}` };
  }

  return {
    success: true,
    data: {
      events: (data ?? []) as LedgerEvent[],
      total: count ?? 0,
    },
  };
}

/**
 * Counts pending + failed + dead-letter rows.
 * Used by the metrics exporter and the /admin/sync/status endpoint.
 */
export async function getInboxStats(): Promise<
  ServiceResponse<{
    pending: number;
    processing: number;
    failed: number;
    dead: number;
    processed_last_hour: number;
  }>
> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const [pendingRes, processingRes, failedRes, deadRes, processedRes] =
    await Promise.all([
      supabase
        .from('ledger_event_inbox')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending'),
      supabase
        .from('ledger_event_inbox')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'processing'),
      supabase
        .from('ledger_event_inbox')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'failed'),
      supabase
        .from('ledger_event_inbox')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'dead'),
      supabase
        .from('ledger_event_inbox')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'processed')
        .gte('processed_at', oneHourAgo),
    ]);

  for (const res of [pendingRes, processingRes, failedRes, deadRes, processedRes]) {
    if (res.error) {
      return { success: false, error: `inbox stats failed: ${res.error.message}` };
    }
  }

  return {
    success: true,
    data: {
      pending: pendingRes.count ?? 0,
      processing: processingRes.count ?? 0,
      failed: failedRes.count ?? 0,
      dead: deadRes.count ?? 0,
      processed_last_hour: processedRes.count ?? 0,
    },
  };
}
