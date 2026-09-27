/**
 * sync.service.ts — blockchain ↔ Supabase reconciliation.
 *
 * ## Idempotency guarantee (#idempotent-sync)
 *
 * Every projection (property, booking, reconciliation) now follows the
 * write-before-process pattern:
 *
 *   1. Build the canonical event_key for the ledger event.
 *   2. Call writeEvent() — inserts an inbox row, or silently returns the
 *      existing row on a duplicate key.  This is the idempotency gate.
 *   3. If the row is already 'processed' → skip (duplicate delivery).
 *   4. Claim the inbox row (sets status → 'processing').
 *   5. Apply the DB projection.
 *   6. On success → resolveEvent() + safeAdvanceCursor().
 *   7. On failure → failEvent() (auto-promotes to 'dead' after max_attempts).
 *
 * Restarting the sync worker after a crash re-polls ledger state but the
 * inbox deduplicates on event_key, so no booking, review, payment, or
 * notification is created twice.
 *
 * ## Cursor-based polling
 *
 * syncAllProperties() and syncAllBookings() now read the stored cursor and
 * only scan IDs above the last-committed high-water mark.  On a cold start
 * (null cursor) they fall back to scanning from ID 1.
 *
 * ## Retry + dead-letter
 *
 * Failed projections remain in 'failed' status and are re-queued by the
 * requeueFailedEvents() call in the scheduler.  After DEFAULT_MAX_ATTEMPTS
 * (5) the row is promoted to 'dead' and exposed on the /admin/sync/status
 * endpoint.
 *
 * ## Legacy
 * The public API surface (syncPropertyFromChain, syncBookingFromChain,
 * syncAllProperties, syncAllBookings, reconcileAllPendingEscrows) is
 * unchanged so existing callers (sync.controller.ts, cleanup-schedular.ts)
 * continue to work without modification.
 */

import {
  BOOKING_CONTRACT_ID,
  NETWORK_PASSPHRASE,
  PROPERTY_LISTING_CONTRACT_ID,
  STELLAR_RPC_URL,
} from '@/blockchain/config.js';
import { BookingClient } from '@/blockchain/bookingClient.js';
import { PropertyListingClient } from '@/blockchain/propertyListingClient.js';
import { getTransactionStatus } from '@/blockchain/transactionUtils.js';
import { getSorobanServer } from '@/blockchain/soroban.js';
import { supabase } from '@/config/supabase.js';
import { createNotification } from './notification.service.js';
import {
  writeEvent,
  resolveEvent,
  failEvent,
} from './ledgerEventInbox.service.js';
import {
  safeAdvanceCursor,
  readCursor,
} from './syncCursor.service.js';
import type { ServiceResponse } from './index.js';
import type { Booking as BookingDBRow } from '@/services/booking.service.js';

// ─── Sync log ─────────────────────────────────────────────────────────────────

type SyncStatus = 'success' | 'failed' | 'skipped';

interface SyncLogEntry {
  entity_type: 'property' | 'booking';
  entity_id: string;
  status: SyncStatus;
  error_message?: string;
  synced_at: string;
}

async function writeSyncLog(entry: Omit<SyncLogEntry, 'synced_at'>): Promise<void> {
  await supabase.from('sync_log').insert({ ...entry, synced_at: new Date().toISOString() });
}

// ─── Blockchain client factories ──────────────────────────────────────────────

function buildPropertyClient(): PropertyListingClient {
  return new PropertyListingClient(
    PROPERTY_LISTING_CONTRACT_ID,
    STELLAR_RPC_URL,
    NETWORK_PASSPHRASE,
  );
}

function buildBookingClient(): BookingClient {
  return new BookingClient(BOOKING_CONTRACT_ID, STELLAR_RPC_URL, NETWORK_PASSPHRASE);
}

// ─── Ledger sequence helpers ───────────────────────────────────────────────────

/**
 * The sync worker uses the on-chain entity count as a proxy for the ledger
 * sequence (the Soroban polling model doesn't expose per-entity ledger numbers
 * directly).  The cursor stores the last entity ID that was fully synced,
 * which is equivalent to a high-water mark over the sequential ID space.
 *
 * In a future migration to getEvents()-based streaming this would be replaced
 * by actual ledger sequence numbers from the event envelope.
 */
function entityIdToLedgerSequence(id: bigint): number {
  // Safe: on-chain IDs are u64 but realistically well within Number.MAX_SAFE_INTEGER
  // for the foreseeable future (~9 quadrillion — Stellar has not approached this).
  return Number(id);
}

// ─── Single-entity projections ────────────────────────────────────────────────

/**
 * Sync a single property from the blockchain to Supabase.
 *
 * Wraps the projection in the inbox write-before-process pattern to guarantee
 * idempotency: replaying this call with the same propertyId is a safe no-op.
 *
 * @param propertyId - On-chain property ID (u64 as string)
 */
export async function syncPropertyFromChain(
  propertyId: string,
): Promise<ServiceResponse<{ outcome: 'synced' | 'skipped' }>> {
  if (!PROPERTY_LISTING_CONTRACT_ID) {
    return { success: false, error: 'PROPERTY_LISTING_CONTRACT_ID is not configured' };
  }

  // ── Step 1: write inbox record ────────────────────────────────────────────
  const ledgerSeq = entityIdToLedgerSequence(BigInt(propertyId));
  const inboxResult = await writeEvent({
    entity_type: 'property',
    entity_id: propertyId,
    contract_id: PROPERTY_LISTING_CONTRACT_ID,
    ledger_sequence: ledgerSeq,
    payload: { entity_id: propertyId },
  });

  if (!inboxResult.success) {
    return { success: false, error: inboxResult.error };
  }

  const { event } = inboxResult.data!;

  // ── Step 2: duplicate detection ──────────────────────────────────────────
  if (event.status === 'processed') {
    await writeSyncLog({ entity_type: 'property', entity_id: propertyId, status: 'skipped' });
    return { success: true, data: { outcome: 'skipped' } };
  }

  if (event.status === 'dead') {
    await writeSyncLog({
      entity_type: 'property',
      entity_id: propertyId,
      status: 'failed',
      error_message: `event dead-lettered: ${event.last_error ?? 'unknown'}`,
    });
    return { success: false, error: `property ${propertyId} inbox event is dead-lettered` };
  }

  // ── Step 3: project ───────────────────────────────────────────────────────
  try {
    const client = buildPropertyClient();
    const listing = await client.getListing(BigInt(propertyId));

    const { error } = await supabase
      .from('properties')
      .update({
        title: listing.title,
        description: listing.description,
        price_per_night: Number(listing.price_per_night) / 10_000_000,
        status: listing.status.toLowerCase(),
        updated_at: new Date().toISOString(),
      })
      .eq('on_chain_id', Number(propertyId));

    if (error) {
      await failEvent(event.id, error.message);
      await writeSyncLog({
        entity_type: 'property',
        entity_id: propertyId,
        status: 'failed',
        error_message: error.message,
      });
      return { success: false, error: error.message };
    }

    // ── Step 4: resolve inbox + advance cursor ────────────────────────────
    await resolveEvent(event.id);
    await safeAdvanceCursor('property', ledgerSeq);
    await writeSyncLog({ entity_type: 'property', entity_id: propertyId, status: 'success' });
    return { success: true, data: { outcome: 'synced' } };
  } catch (err) {
    const message = (err as Error).message;
    await failEvent(event.id, message);
    await writeSyncLog({
      entity_type: 'property',
      entity_id: propertyId,
      status: 'failed',
      error_message: message,
    });
    return { success: false, error: message };
  }
}

/**
 * Sync a single booking from the blockchain to Supabase.
 *
 * Idempotent: replaying with the same bookingId never creates duplicates.
 *
 * @param bookingId - On-chain booking ID (u64 as string)
 */
export async function syncBookingFromChain(
  bookingId: string,
): Promise<ServiceResponse<{ outcome: 'synced' | 'skipped' }>> {
  if (!BOOKING_CONTRACT_ID) {
    return { success: false, error: 'BOOKING_CONTRACT_ID is not configured' };
  }

  // ── Step 1: write inbox record ────────────────────────────────────────────
  const ledgerSeq = entityIdToLedgerSequence(BigInt(bookingId));
  const inboxResult = await writeEvent({
    entity_type: 'booking',
    entity_id: bookingId,
    contract_id: BOOKING_CONTRACT_ID,
    ledger_sequence: ledgerSeq,
    payload: { entity_id: bookingId },
  });

  if (!inboxResult.success) {
    return { success: false, error: inboxResult.error };
  }

  const { event } = inboxResult.data!;

  // ── Step 2: duplicate detection ──────────────────────────────────────────
  if (event.status === 'processed') {
    await writeSyncLog({ entity_type: 'booking', entity_id: bookingId, status: 'skipped' });
    return { success: true, data: { outcome: 'skipped' } };
  }

  if (event.status === 'dead') {
    await writeSyncLog({
      entity_type: 'booking',
      entity_id: bookingId,
      status: 'failed',
      error_message: `event dead-lettered: ${event.last_error ?? 'unknown'}`,
    });
    return { success: false, error: `booking ${bookingId} inbox event is dead-lettered` };
  }

  // ── Step 3: project ───────────────────────────────────────────────────────
  try {
    const client = buildBookingClient();
    const booking = await client.getBooking(BigInt(bookingId));

    const { error } = await supabase
      .from('bookings')
      .update({
        status: booking.status.toLowerCase(),
        escrow_id: booking.escrow_id || undefined,
        updated_at: new Date().toISOString(),
      })
      .eq('on_chain_id', Number(bookingId));

    if (error) {
      await failEvent(event.id, error.message);
      await writeSyncLog({
        entity_type: 'booking',
        entity_id: bookingId,
        status: 'failed',
        error_message: error.message,
      });
      return { success: false, error: error.message };
    }

    // ── Step 4: resolve inbox + advance cursor ────────────────────────────
    await resolveEvent(event.id);
    await safeAdvanceCursor('booking', ledgerSeq);
    await writeSyncLog({ entity_type: 'booking', entity_id: bookingId, status: 'success' });
    return { success: true, data: { outcome: 'synced' } };
  } catch (err) {
    const message = (err as Error).message;
    await failEvent(event.id, message);
    await writeSyncLog({
      entity_type: 'booking',
      entity_id: bookingId,
      status: 'failed',
      error_message: message,
    });
    return { success: false, error: message };
  }
}

// ─── Bulk sync (cursor-bounded) ───────────────────────────────────────────────

/**
 * Sync every on-chain property listing to Supabase.
 *
 * Cursor-bounded: reads the stored cursor and only processes IDs above the
 * last committed high-water mark.  On a cold start (null cursor) scans from
 * ID 1.  This makes the full scan O(new entities) instead of O(all entities).
 *
 * @returns ServiceResponse with counts of synced, failed, and skipped properties.
 */
export async function syncAllProperties(): Promise<
  ServiceResponse<{ synced: number; failed: number; skipped: number }>
> {
  if (!PROPERTY_LISTING_CONTRACT_ID) {
    return { success: false, error: 'PROPERTY_LISTING_CONTRACT_ID is not configured' };
  }

  try {
    const client = buildPropertyClient();
    const count = await client.listingCount();

    // Read the stored cursor (last processed property ID).
    const cursorResult = await readCursor('property');
    const startFrom = cursorResult.success && cursorResult.data?.last_ledger_sequence
      ? BigInt(cursorResult.data.last_ledger_sequence) + 1n
      : 1n;

    let synced = 0;
    let failed = 0;
    let skipped = 0;

    for (let i = startFrom; i <= count; i++) {
      const result = await syncPropertyFromChain(String(i));
      if (!result.success) {
        failed++;
      } else if (result.data?.outcome === 'skipped') {
        skipped++;
      } else {
        synced++;
      }
    }

    return { success: true, data: { synced, failed, skipped } };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Sync every on-chain booking to Supabase.
 *
 * Cursor-bounded: only processes IDs above the stored cursor's high-water mark.
 *
 * @returns ServiceResponse with counts of synced, failed, and skipped bookings.
 */
export async function syncAllBookings(): Promise<
  ServiceResponse<{ synced: number; failed: number; skipped: number }>
> {
  if (!BOOKING_CONTRACT_ID) {
    return { success: false, error: 'BOOKING_CONTRACT_ID is not configured' };
  }

  try {
    const client = buildBookingClient();
    const count = await client.bookingCount();

    // Read the stored cursor (last processed booking ID).
    const cursorResult = await readCursor('booking');
    const startFrom = cursorResult.success && cursorResult.data?.last_ledger_sequence
      ? BigInt(cursorResult.data.last_ledger_sequence) + 1n
      : 1n;

    let synced = 0;
    let failed = 0;
    let skipped = 0;

    for (let i = startFrom; i <= count; i++) {
      const result = await syncBookingFromChain(String(i));
      if (!result.success) {
        failed++;
      } else if (result.data?.outcome === 'skipped') {
        skipped++;
      } else {
        synced++;
      }
    }

    return { success: true, data: { synced, failed, skipped } };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// ─── Reconciliation constants ─────────────────────────────────────────────────

/** Maximum reconciliation attempts before quarantining the booking. */
const MAX_RECONCILE_ATTEMPTS = 5;

/** Errors indicating a transient (retryable) failure. */
const TRANSIENT_ERROR_PATTERNS = [
  /network/i,
  /timeout/i,
  /econnreset/i,
  /enotfound/i,
  /503/,
  /502/,
  /rate.?limit/i,
];

type ErrorCategory = 'transient' | 'permanent';

function classifyError(message: string): ErrorCategory {
  return TRANSIENT_ERROR_PATTERNS.some((p) => p.test(message))
    ? 'transient'
    : 'permanent';
}

// ─── Blockchain log helper ────────────────────────────────────────────────────

async function writeBlockchainLog(entry: {
  booking_id: string;
  tx_hash?: string;
  log_type: 'reconciliation' | 'error' | 'success';
  message?: string;
  on_chain_status?: string;
  error_category?: ErrorCategory;
  attempt?: number;
}): Promise<void> {
  await supabase.from('blockchain_logs').insert({
    ...entry,
    created_at: new Date().toISOString(),
  });
}

// ─── Tenant / host notification helpers ──────────────────────────────────────

async function getTenantId(bookingId: string): Promise<string | null> {
  const { data } = await supabase
    .from('bookings')
    .select('tenant_id')
    .eq('id', bookingId)
    .single();
  return (data as { tenant_id?: string } | null)?.tenant_id ?? null;
}

async function getHostId(bookingId: string): Promise<string | null> {
  const { data } = await supabase
    .from('bookings')
    .select('properties(owner_id)')
    .eq('id', bookingId)
    .single();
  // biome-ignore lint/suspicious/noExplicitAny: raw Supabase join shape
  return (data as any)?.properties?.owner_id ?? null;
}

/**
 * Send one-time privacy-safe failure notifications to tenant and host.
 * Deduplication is enforced via the `escrow_failure_notified_at` column —
 * this function is safe to call multiple times per booking.
 */
async function notifyEscrowFailure(bookingId: string, attempt: number): Promise<void> {
  const { data: booking } = await supabase
    .from('bookings')
    .select('escrow_failure_notified_at, tenant_id, property_id')
    .eq('id', bookingId)
    .single();

  if (
    (booking as { escrow_failure_notified_at?: string | null } | null)
      ?.escrow_failure_notified_at
  ) {
    return; // already notified
  }

  const tenantId = await getTenantId(bookingId);
  const hostId = await getHostId(bookingId);

  const notificationPayload: Record<string, unknown> = {
    bookingId,
    message:
      'Your booking escrow could not be confirmed after multiple attempts. Our support team has been alerted.',
    supportLink: '/support',
    attempt,
  };

  const tasks: Promise<unknown>[] = [];

  if (tenantId) {
    tasks.push(
      createNotification(tenantId, 'system_alert', {
        ...notificationPayload,
        audience: 'tenant',
      }).catch((err) =>
        console.error(`[Reconcile] Failed to notify tenant ${tenantId}:`, err),
      ),
    );
  }

  if (hostId) {
    tasks.push(
      createNotification(hostId, 'system_alert', {
        bookingId,
        message:
          'An escrow transaction for one of your bookings could not be confirmed. Support has been alerted.',
        supportLink: '/host/support',
        attempt,
        audience: 'host',
      }).catch((err) =>
        console.error(`[Reconcile] Failed to notify host ${hostId}:`, err),
      ),
    );
  }

  await Promise.all(tasks);

  await supabase
    .from('bookings')
    .update({ escrow_failure_notified_at: new Date().toISOString() })
    .eq('id', bookingId);
}

// ─── Reconciliation ───────────────────────────────────────────────────────────

/**
 * Move a booking to the `escrow_reconcile_failed` quarantine state and notify
 * participants.  Idempotent — safe to call multiple times.
 */
async function quarantineBooking(
  bookingId: string,
  txHash: string,
  attempt: number,
  reason: string,
): Promise<void> {
  await supabase
    .from('bookings')
    .update({
      status: 'escrow_reconcile_failed',
      last_reconcile_error: reason,
      updated_at: new Date().toISOString(),
    })
    .eq('id', bookingId);

  await writeBlockchainLog({
    booking_id: bookingId,
    tx_hash: txHash,
    log_type: 'error',
    message: `Booking quarantined: ${reason}`,
    on_chain_status: 'escrow_reconcile_failed',
    attempt,
  });

  console.error(
    `[Reconcile] QUARANTINE booking=${bookingId} attempt=${attempt} reason="${reason}"`,
  );

  await notifyEscrowFailure(bookingId, attempt);
}

/**
 * Reconcile a single booking's escrow transaction.
 *
 * Wrapped in the inbox write-before-process pattern:
 *  - The event_key is scoped to the booking's escrow_hash so that replaying
 *    the reconciliation (e.g. after a restart) never re-sends notifications
 *    or re-applies the confirmed/quarantine state change.
 *  - The reconcile_attempts counter is incremented in the DB before the
 *    network call so crashed workers still account for the attempt.
 */
async function reconcilePendingEscrow(
  booking: BookingDBRow & {
    escrow_hash?: string;
    reconcile_attempts?: number;
  },
): Promise<void> {
  if (!booking.escrow_hash || !booking.on_chain_id) {
    return;
  }

  const currentAttempt = (booking.reconcile_attempts ?? 0) + 1;

  // ── Step 1: write reconciliation inbox record ─────────────────────────────
  // One inbox row per (booking, attempt, escrow_hash) so each retry attempt
  // gets its own deduplication entry.  writeEvent() builds the canonical key
  // internally from these same inputs.
  const inboxResult = await writeEvent({
    entity_type: 'booking',
    entity_id: booking.id,
    contract_id: BOOKING_CONTRACT_ID,
    ledger_sequence: currentAttempt,
    tx_hash: booking.escrow_hash,
    payload: {
      reconcile_attempt: currentAttempt,
      escrow_hash: booking.escrow_hash,
      booking_id: booking.id,
    },
  });

  if (!inboxResult.success) {
    console.error(`[Reconcile] inbox write failed for booking ${booking.id}:`, inboxResult.error);
    return;
  }

  const { event } = inboxResult.data!;

  // If this exact attempt was already processed (restart mid-run) skip it.
  if (event.status === 'processed') {
    return;
  }

  // ── Step 2: increment attempt counter ─────────────────────────────────────
  await supabase
    .from('bookings')
    .update({
      reconcile_attempts: currentAttempt,
      last_reconcile_at: new Date().toISOString(),
    })
    .eq('id', booking.id);

  // ── Step 3: poll transaction status ───────────────────────────────────────
  try {
    const server = getSorobanServer();
    const txStatus = await getTransactionStatus(server, booking.escrow_hash);

    if (txStatus.status === 'pending') {
      await writeBlockchainLog({
        booking_id: booking.id,
        tx_hash: booking.escrow_hash,
        log_type: 'reconciliation',
        message: 'Transaction still pending',
        attempt: currentAttempt,
      });

      if (currentAttempt >= MAX_RECONCILE_ATTEMPTS) {
        await quarantineBooking(
          booking.id,
          booking.escrow_hash,
          currentAttempt,
          'Exceeded max attempts while pending',
        );
        await resolveEvent(event.id); // mark as processed so we don't retry quarantine
      } else {
        await failEvent(event.id, 'Transaction still pending — will retry');
      }
      return;
    }

    if (txStatus.status === 'success') {
      await supabase
        .from('bookings')
        .update({ status: 'confirmed', updated_at: new Date().toISOString() })
        .eq('id', booking.id);

      await writeBlockchainLog({
        booking_id: booking.id,
        tx_hash: booking.escrow_hash,
        log_type: 'success',
        message: 'Escrow transaction confirmed',
        on_chain_status: 'funded',
        attempt: currentAttempt,
      });

      await resolveEvent(event.id);
      return;
    }

    if (txStatus.status === 'failed') {
      await quarantineBooking(
        booking.id,
        booking.escrow_hash,
        currentAttempt,
        'On-chain transaction failed',
      );
      await resolveEvent(event.id);
    }
  } catch (err) {
    const message = (err as Error).message;
    const category = classifyError(message);

    await writeBlockchainLog({
      booking_id: booking.id,
      tx_hash: booking.escrow_hash,
      log_type: 'error',
      message: `Reconciliation error: ${message}`,
      error_category: category,
      attempt: currentAttempt,
    });

    if (category === 'permanent' || currentAttempt >= MAX_RECONCILE_ATTEMPTS) {
      await quarantineBooking(
        booking.id,
        booking.escrow_hash,
        currentAttempt,
        message,
      );
      await resolveEvent(event.id);
    } else {
      // Transient — leave as failed so the DLQ retry loop re-queues it.
      await failEvent(event.id, message);
    }
  }
}

/**
 * Reconcile all bookings with pending escrow transactions.
 *
 * Polls transaction status for every booking in `pending` state that has an
 * escrow hash and has not yet exceeded MAX_RECONCILE_ATTEMPTS.
 *
 * @returns ServiceResponse with counts of reconciled and failed bookings.
 */
export async function reconcileAllPendingEscrows(): Promise<
  ServiceResponse<{ reconciled: number; failed: number }>
> {
  if (!BOOKING_CONTRACT_ID) {
    return { success: false, error: 'BOOKING_CONTRACT_ID is not configured' };
  }

  try {
    const { data: bookings, error } = await supabase
      .from('bookings')
      .select('*')
      .eq('status', 'pending')
      .not('escrow_hash', 'is', null)
      .lt('reconcile_attempts', MAX_RECONCILE_ATTEMPTS);

    if (error) {
      return { success: false, error: error.message };
    }

    let reconciled = 0;
    let failed = 0;

    for (const booking of bookings ?? []) {
      try {
        await reconcilePendingEscrow(
          booking as BookingDBRow & {
            escrow_hash?: string;
            reconcile_attempts?: number;
          },
        );
        reconciled++;
      } catch (err) {
        failed++;
        console.error(
          `[reconcile] Failed to reconcile booking ${booking.id}:`,
          err,
        );
      }
    }

    return { success: true, data: { reconciled, failed } };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// ─── Lag snapshot (used by the status endpoint and metrics) ──────────────────

/**
 * Returns the current chain tip, cursor positions for all entity types, and
 * computed lag.  Exported so the admin status endpoint can call it directly.
 */
export async function getSyncStatus(): Promise<
  ServiceResponse<{
    chain_tip: number | null;
    cursors: Array<{
      entity_type: string;
      last_ledger_sequence: number | null;
      lag_ledgers: number | null;
      last_advanced_at: string | null;
      stalled: boolean;
    }>;
  }>
> {
  const { computeLag } = await import('./syncCursor.service.js');
  const lagResult = await computeLag();

  if (!lagResult.success) {
    return { success: false, error: lagResult.error };
  }

  const chainTip = lagResult.data![0]?.chain_tip ?? null;

  return {
    success: true,
    data: {
      chain_tip: chainTip,
      cursors: lagResult.data!.map((l) => ({
        entity_type: l.entity_type,
        last_ledger_sequence: l.last_ledger_sequence,
        lag_ledgers: l.lag_ledgers,
        last_advanced_at: l.last_advanced_at,
        stalled: l.stalled,
      })),
    },
  };
}
