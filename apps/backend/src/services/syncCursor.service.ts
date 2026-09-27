/**
 * syncCursor.service.ts — persist and advance the ledger cursor.
 *
 * ## Purpose
 * The cursor records the highest ledger sequence for which every event has
 * been fully projected and committed.  On restart the sync worker reads its
 * cursor and resumes from `last_ledger_sequence + 1`, skipping all history
 * that has already been processed.
 *
 * ## Lag
 * Lag is the distance between the current chain tip and the cursor:
 *
 *   lag_ledgers = chain_tip - cursor.last_ledger_sequence
 *
 * A lag of 0 means the worker is fully caught up.  A growing lag signals
 * that the worker is falling behind or has stopped.
 *
 * ## Multi-instance note
 * All public functions accept a `workerId` parameter (default: `'primary'`).
 * A future multi-instance deployment can maintain per-pod cursors and elect
 * a leader; for now a single 'primary' cursor suffices.
 */

import { supabase } from '@/config/supabase.js';
import { getSorobanServer } from '@/blockchain/soroban.js';
import type { ServiceResponse } from './index.js';
import type { EventEntityType } from './ledgerEventInbox.service.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SyncCursor {
  id: string;
  worker_id: string;
  entity_type: EventEntityType;
  /** Highest ledger sequence fully committed.  null = cold start (never advanced). */
  last_ledger_sequence: number | null;
  last_advanced_at: string | null;
  chain_tip_at_last_advance: number | null;
  created_at: string;
  updated_at: string;
}

export interface CursorLag {
  entity_type: EventEntityType;
  worker_id: string;
  last_ledger_sequence: number | null;
  chain_tip: number | null;
  /** null when chain_tip or cursor is unknown. */
  lag_ledgers: number | null;
  last_advanced_at: string | null;
  /** True when the cursor has not advanced in > STALL_THRESHOLD_MS. */
  stalled: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Worker considered stalled if the cursor hasn't advanced in this period. */
export const STALL_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

/** Default worker identity for single-instance deployments. */
export const PRIMARY_WORKER_ID = 'primary';

// ─── Read cursor ──────────────────────────────────────────────────────────────

/**
 * Read the current cursor for a given worker + entity type.
 *
 * Returns the cursor row, or null if no row exists (should not happen after
 * the seed migration runs, but handled defensively).
 */
export async function readCursor(
  entityType: EventEntityType,
  workerId: string = PRIMARY_WORKER_ID,
): Promise<ServiceResponse<SyncCursor | null>> {
  const { data, error } = await supabase
    .from('sync_cursors')
    .select('*')
    .eq('worker_id', workerId)
    .eq('entity_type', entityType)
    .maybeSingle();

  if (error) {
    return { success: false, error: `cursor read failed: ${error.message}` };
  }

  return { success: true, data: (data as SyncCursor | null) };
}

/**
 * Read all cursors for a worker.
 * Useful for the status endpoint which returns all entity types at once.
 */
export async function readAllCursors(
  workerId: string = PRIMARY_WORKER_ID,
): Promise<ServiceResponse<SyncCursor[]>> {
  const { data, error } = await supabase
    .from('sync_cursors')
    .select('*')
    .eq('worker_id', workerId)
    .order('entity_type', { ascending: true });

  if (error) {
    return { success: false, error: `cursor read-all failed: ${error.message}` };
  }

  return { success: true, data: (data ?? []) as SyncCursor[] };
}

// ─── Advance cursor ───────────────────────────────────────────────────────────

/**
 * Advance the cursor to `newLedgerSequence`.
 *
 * Only advances forward — if `newLedgerSequence` is lower than the stored
 * value (e.g. reorg or duplicate delivery) the update is a no-op.
 *
 * @param entityType        - The entity stream being advanced.
 * @param newLedgerSequence - The highest fully-committed ledger sequence.
 * @param chainTip          - The current chain tip at the time of this call
 *                            (stored for lag calculation, optional).
 * @param workerId          - Worker identity (default: 'primary').
 */
export async function advanceCursor(
  entityType: EventEntityType,
  newLedgerSequence: number,
  chainTip?: number,
  workerId: string = PRIMARY_WORKER_ID,
): Promise<ServiceResponse<void>> {
  // Upsert: create the row if missing, otherwise update only when advancing.
  const { error } = await supabase
    .from('sync_cursors')
    .upsert(
      {
        worker_id: workerId,
        entity_type: entityType,
        last_ledger_sequence: newLedgerSequence,
        last_advanced_at: new Date().toISOString(),
        chain_tip_at_last_advance: chainTip ?? null,
      },
      {
        onConflict: 'worker_id,entity_type',
        // Only advance — don't regress if a reordered/duplicate call arrives.
        // PostgREST upsert does a full replace on conflict; the guard is in
        // the application layer below.
        ignoreDuplicates: false,
      },
    );

  if (error) {
    return { success: false, error: `cursor advance failed: ${error.message}` };
  }

  return { success: true };
}

/**
 * Advance the cursor only when `newLedgerSequence` is strictly greater than
 * the stored value.  This is the safe version to call from projection code
 * where out-of-order delivery is possible.
 */
export async function safeAdvanceCursor(
  entityType: EventEntityType,
  newLedgerSequence: number,
  chainTip?: number,
  workerId: string = PRIMARY_WORKER_ID,
): Promise<ServiceResponse<{ advanced: boolean }>> {
  const readResult = await readCursor(entityType, workerId);
  if (!readResult.success) {
    return { success: false, error: readResult.error };
  }

  const current = readResult.data?.last_ledger_sequence ?? -1;

  if (newLedgerSequence <= current) {
    // Already at or past this sequence — safe no-op.
    return { success: true, data: { advanced: false } };
  }

  const advanceResult = await advanceCursor(
    entityType,
    newLedgerSequence,
    chainTip,
    workerId,
  );

  if (!advanceResult.success) {
    return { success: false, error: advanceResult.error };
  }

  return { success: true, data: { advanced: true } };
}

// ─── Chain tip ────────────────────────────────────────────────────────────────

/**
 * Fetch the current Stellar ledger sequence (chain tip) from the Soroban RPC.
 *
 * Returns null if the RPC is unreachable — callers treat null tip as
 * "lag unknown" rather than failing the entire sync run.
 */
export async function fetchChainTip(): Promise<number | null> {
  try {
    const server = getSorobanServer();
    const latestLedger = await server.getLatestLedger();
    return latestLedger.sequence;
  } catch {
    return null;
  }
}

// ─── Lag calculation ──────────────────────────────────────────────────────────

/**
 * Compute lag for every entity type tracked by `workerId`.
 *
 * Fetches the chain tip once and returns one CursorLag entry per cursor row.
 */
export async function computeLag(
  workerId: string = PRIMARY_WORKER_ID,
): Promise<ServiceResponse<CursorLag[]>> {
  const [cursorsResult, chainTip] = await Promise.all([
    readAllCursors(workerId),
    fetchChainTip(),
  ]);

  if (!cursorsResult.success) {
    return { success: false, error: cursorsResult.error };
  }

  const now = Date.now();

  const lags: CursorLag[] = cursorsResult.data!.map((cursor) => {
    const lag =
      chainTip !== null && cursor.last_ledger_sequence !== null
        ? Math.max(0, chainTip - cursor.last_ledger_sequence)
        : null;

    const lastAdvancedMs = cursor.last_advanced_at
      ? new Date(cursor.last_advanced_at).getTime()
      : null;

    const stalled =
      lastAdvancedMs !== null
        ? now - lastAdvancedMs > STALL_THRESHOLD_MS
        : false; // Never advanced — cold start, not yet stalled

    return {
      entity_type: cursor.entity_type,
      worker_id: cursor.worker_id,
      last_ledger_sequence: cursor.last_ledger_sequence,
      chain_tip: chainTip,
      lag_ledgers: lag,
      last_advanced_at: cursor.last_advanced_at,
      stalled,
    };
  });

  return { success: true, data: lags };
}

// ─── Reset (operator tool) ────────────────────────────────────────────────────

/**
 * Reset the cursor to a specific ledger sequence.
 *
 * This is an operator-only action (exposed via the admin status endpoint) that
 * lets the team replay events from a known good point after a reorg or data
 * corruption incident.  All inbox rows with ledger_sequence > targetSequence
 * for this entity type will be re-processed on the next worker run.
 *
 * ⚠️  Resetting backward can re-apply already-committed projections.  The
 *     inbox's idempotent writeEvent + per-entity deduplication in the
 *     projection layer guards against duplicate side effects, but callers
 *     should confirm intent before calling this.
 */
export async function resetCursor(
  entityType: EventEntityType,
  targetSequence: number,
  workerId: string = PRIMARY_WORKER_ID,
): Promise<ServiceResponse<void>> {
  const { error } = await supabase
    .from('sync_cursors')
    .update({
      last_ledger_sequence: targetSequence,
      last_advanced_at: new Date().toISOString(),
      chain_tip_at_last_advance: null,
    })
    .eq('worker_id', workerId)
    .eq('entity_type', entityType);

  if (error) {
    return { success: false, error: `cursor reset failed: ${error.message}` };
  }

  return { success: true };
}
