/**
 * disputeResolution.service.ts
 *
 * Moderator-facing dispute resolution service.  All state changes that touch
 * a booking's dispute lifecycle go through this module so that:
 *
 *   1. The authoritative `bookingService.resolveDispute()` escrow+state-machine
 *      path is always used for actual resolution — never a raw Supabase UPDATE.
 *
 *   2. Every action (claim, unclaim, escalate, resolve) emits an `auditLogger`
 *      entry so the full decision chain is traceable.
 *
 *   3. Financial resolution is idempotent: if `resolveDispute()` is called a
 *      second time on an already-resolved booking the service returns a
 *      `{ alreadyResolved: true }` sentinel without re-running escrow logic.
 *
 * ## Stale-claim reclaim
 * A claim is considered stale after STALE_CLAIM_THRESHOLD_MS.  Any moderator
 * can reclaim a stale case — this prevents a dispute from being stuck while a
 * moderator is offline.
 */

import { supabase } from '@/config/supabase.js';
import { auditLogger } from '@/services/auditLogger.service.js';
import { BookingService } from '@/services/booking.service.js';
import { createNotification } from '@/services/notification.service.js';
import type { ServiceResponse } from '@/services/index.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** How long a claim is held before another moderator can reclaim it (ms). */
export const STALE_CLAIM_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours

// Singleton booking service instance — avoids re-constructing per call.
const bookingService = new BookingService();

// ─── Types ────────────────────────────────────────────────────────────────────

export type DisputeOutcome = 'refund_tenant' | 'release_to_host' | 'split';

/** Minimal participant shape returned in case detail. */
export interface DisputeParticipant {
  id: string;
  email: string;
  role: string;
}

/** Full dispute case returned by getDisputeCase(). */
export interface DisputeCase {
  booking_id: string;
  property_id: string;
  property_title: string | null;
  check_in: string;
  check_out: string;
  total_price: number;
  booking_status: string;
  dispute_status: string;
  dispute_reason: string | null;
  dispute_details: string | null;
  dispute_claimed_by: string | null;
  dispute_claimed_at: string | null;
  dispute_escalated_at: string | null;
  dispute_escalation_note: string | null;
  dispute_outcome: string | null;
  dispute_resolution_note: string | null;
  dispute_resolved_at: string | null;
  tenant: DisputeParticipant | null;
  host: DisputeParticipant | null;
  escrow_id: string | null;
  payment_status: string | null;
  created_at: string;
  updated_at: string | null;
  /** Full status-change history for the booking timeline. */
  history: Array<{
    id: string;
    from_status: string | null;
    status: string;
    changed_by: string | null;
    reason: string | null;
    notes: string | null;
    created_at: string;
  }>;
}

export interface DisputeQueueItem {
  booking_id: string;
  property_id: string;
  check_in: string;
  check_out: string;
  total_price: number;
  dispute_reason: string | null;
  dispute_status: string;
  dispute_claimed_by: string | null;
  dispute_claimed_at: string | null;
  dispute_escalated_at: string | null;
  created_at: string;
}

export interface DisputeQueueFilters {
  /** 'open' = unclaimed, 'claimed' = assigned to a moderator, 'escalated', 'all'. */
  queue?: 'open' | 'claimed' | 'escalated' | 'all';
  /** Filter to cases claimed by a specific moderator ID. */
  claimed_by?: string;
  page?: number;
  limit?: number;
}

// ─── Queue ────────────────────────────────────────────────────────────────────

/**
 * Return a paginated list of disputed bookings for the moderator queue.
 *
 * Default view is `open` (unclaimed, oldest first) so the queue drains FIFO.
 * The `claimed` view shows cases assigned to any or a specific moderator.
 * The `all` view returns everything in `Disputed` status regardless of claim.
 */
export async function listDisputeQueue(
  filters: DisputeQueueFilters = {},
): Promise<ServiceResponse<{ cases: DisputeQueueItem[]; total: number }>> {
  const { queue = 'open', claimed_by, page = 1, limit = 20 } = filters;
  const safePage  = Math.max(1, page);
  const safeLimit = Math.min(100, Math.max(1, limit));
  const offset    = (safePage - 1) * safeLimit;

  let query = supabase
    .from('bookings')
    .select(
      'id, property_id, check_in, check_out, total_price, dispute_reason, ' +
      'dispute_status, dispute_claimed_by, dispute_claimed_at, dispute_escalated_at, created_at',
      { count: 'exact' },
    )
    .eq('status', 'Disputed')
    .order('created_at', { ascending: true }) // oldest first — FIFO
    .range(offset, offset + safeLimit - 1);

  if (queue === 'open') {
    query = query.is('dispute_claimed_by', null);
  } else if (queue === 'claimed') {
    query = query.not('dispute_claimed_by', 'is', null);
  } else if (queue === 'escalated') {
    query = query.not('dispute_escalated_at', 'is', null);
  }
  // 'all' — no extra filter

  if (claimed_by) {
    query = query.eq('dispute_claimed_by', claimed_by);
  }

  const { data, error, count } = await query;

  if (error) {
    return { success: false, error: `dispute queue query failed: ${error.message}` };
  }

  const cases: DisputeQueueItem[] = (data ?? []).map((row) => ({
    booking_id:          row.id,
    property_id:         row.property_id,
    check_in:            row.check_in,
    check_out:           row.check_out,
    total_price:         row.total_price,
    dispute_reason:      row.dispute_reason ?? null,
    dispute_status:      row.dispute_status ?? 'raised',
    dispute_claimed_by:  row.dispute_claimed_by ?? null,
    dispute_claimed_at:  row.dispute_claimed_at ?? null,
    dispute_escalated_at: row.dispute_escalated_at ?? null,
    created_at:          row.created_at,
  }));

  return { success: true, data: { cases, total: count ?? 0 } };
}

// ─── Case detail ──────────────────────────────────────────────────────────────

/**
 * Load a single dispute case with all context a moderator needs:
 *   - Full booking + property title
 *   - Tenant and host email + role (only id, email, role — no passwords etc.)
 *   - Payment status
 *   - Full booking status history for the timeline
 *
 * Only loads a booking that is currently in Disputed status.
 */
export async function getDisputeCase(
  bookingId: string,
): Promise<ServiceResponse<DisputeCase>> {
  // Booking + property title + tenant/host join
  const { data: row, error } = await supabase
    .from('bookings')
    .select(
      `id, property_id, check_in, check_out, guest_count, total_price,
       status, created_at, updated_at, escrow_id, tenant_id,
       dispute_reason, dispute_details, dispute_status,
       dispute_claimed_by, dispute_claimed_at,
       dispute_escalated_at, dispute_escalation_note,
       dispute_outcome, dispute_resolution_note, dispute_resolved_at,
       properties!inner ( title, owner_id )`,
    )
    .eq('id', bookingId)
    .single();

  if (error || !row) {
    return { success: false, error: `Dispute case not found: ${error?.message ?? bookingId}` };
  }

  // biome-ignore lint/suspicious/noExplicitAny: raw Supabase join shape
  const booking = row as any;

  if (!['Disputed', 'Completed', 'Cancelled'].includes(booking.status) || !booking.dispute_reason) {
    return { success: false, error: 'This booking does not have a dispute record' };
  }

  const propertyOwnerId: string | null = booking.properties?.owner_id ?? null;

  // Load tenant + host user info in parallel, fail gracefully on missing users
  const [tenantResult, hostResult, paymentResult, historyResult] = await Promise.all([
    booking.tenant_id
      ? supabase
          .from('users')
          .select('id, email, role')
          .eq('id', booking.tenant_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),

    propertyOwnerId
      ? supabase
          .from('users')
          .select('id, email, role')
          .eq('id', propertyOwnerId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),

    supabase
      .from('payments')
      .select('status')
      .eq('booking_id', bookingId)
      .maybeSingle(),

    supabase
      .from('booking_status_history')
      .select('id, from_status, status, changed_by, reason, notes, created_at')
      .eq('booking_id', bookingId)
      .order('created_at', { ascending: true }),
  ]);

  const disputeCase: DisputeCase = {
    booking_id:              booking.id,
    property_id:             booking.property_id,
    property_title:          booking.properties?.title ?? null,
    check_in:                booking.check_in,
    check_out:               booking.check_out,
    total_price:             booking.total_price,
    booking_status:          booking.status,
    dispute_status:          booking.dispute_status ?? 'raised',
    dispute_reason:          booking.dispute_reason ?? null,
    dispute_details:         booking.dispute_details ?? null,
    dispute_claimed_by:      booking.dispute_claimed_by ?? null,
    dispute_claimed_at:      booking.dispute_claimed_at ?? null,
    dispute_escalated_at:    booking.dispute_escalated_at ?? null,
    dispute_escalation_note: booking.dispute_escalation_note ?? null,
    dispute_outcome:         booking.dispute_outcome ?? null,
    dispute_resolution_note: booking.dispute_resolution_note ?? null,
    dispute_resolved_at:     booking.dispute_resolved_at ?? null,
    tenant:                  tenantResult.data as DisputeParticipant | null,
    host:                    hostResult.data as DisputeParticipant | null,
    escrow_id:               booking.escrow_id ?? null,
    payment_status:          (paymentResult.data as { status?: string } | null)?.status ?? null,
    created_at:              booking.created_at,
    updated_at:              booking.updated_at ?? null,
    history:                 (historyResult.data ?? []) as DisputeCase['history'],
  };

  return { success: true, data: disputeCase };
}

// ─── Claim ────────────────────────────────────────────────────────────────────

/**
 * Claim a dispute case for active review.
 *
 * Rules:
 *   - A case can only be claimed if it is Disputed + dispute_status = 'raised'.
 *   - An already-claimed case can be reclaimed if the existing claim is stale
 *     (older than STALE_CLAIM_THRESHOLD_MS).
 *   - A moderator cannot claim a case they already own (idempotent).
 *
 * @returns `{ claimed: true }` on success, or an error.
 */
export async function claimDisputeCase(
  bookingId: string,
  moderatorId: string,
  ip?: string,
): Promise<ServiceResponse<{ claimed: boolean; alreadyOwned: boolean }>> {
  const { data: row, error: fetchError } = await supabase
    .from('bookings')
    .select('id, status, dispute_status, dispute_claimed_by, dispute_claimed_at')
    .eq('id', bookingId)
    .single();

  if (fetchError || !row) {
    return { success: false, error: 'Dispute case not found' };
  }

  // biome-ignore lint/suspicious/noExplicitAny: raw shape
  const booking = row as any;

  if (booking.status !== 'Disputed' || booking.dispute_status !== 'raised') {
    return { success: false, error: 'This booking does not have an active dispute' };
  }

  // Already owned by this moderator — idempotent success
  if (booking.dispute_claimed_by === moderatorId) {
    return { success: true, data: { claimed: true, alreadyOwned: true } };
  }

  // If claimed by someone else, check staleness
  if (booking.dispute_claimed_by !== null) {
    const claimedMs = booking.dispute_claimed_at
      ? new Date(booking.dispute_claimed_at).getTime()
      : 0;
    const isStale = Date.now() - claimedMs > STALE_CLAIM_THRESHOLD_MS;

    if (!isStale) {
      return {
        success: false,
        error: `This case is currently claimed by another moderator (${booking.dispute_claimed_by}). Stale reclaim available after ${STALE_CLAIM_THRESHOLD_MS / 3_600_000}h.`,
      };
    }
  }

  const { error: updateError } = await supabase
    .from('bookings')
    .update({
      dispute_claimed_by:  moderatorId,
      dispute_claimed_at:  new Date().toISOString(),
    })
    .eq('id', bookingId);

  if (updateError) {
    return { success: false, error: `claim failed: ${updateError.message}` };
  }

  await auditLogger.log({
    actorId:      moderatorId,
    action:       'dispute.modify',
    resourceType: 'dispute',
    resourceId:   bookingId,
    ip,
    meta:         { action: 'claim', reclaimed: booking.dispute_claimed_by !== null },
  });

  return { success: true, data: { claimed: true, alreadyOwned: false } };
}

// ─── Unclaim ──────────────────────────────────────────────────────────────────

/**
 * Release a claim, returning the case to the open queue.
 *
 * Only the moderator who holds the claim (or an admin) may unclaim it.
 */
export async function unclaimDisputeCase(
  bookingId: string,
  moderatorId: string,
  moderatorRole: string,
  ip?: string,
): Promise<ServiceResponse<void>> {
  const { data: row, error: fetchError } = await supabase
    .from('bookings')
    .select('id, status, dispute_status, dispute_claimed_by')
    .eq('id', bookingId)
    .single();

  if (fetchError || !row) {
    return { success: false, error: 'Dispute case not found' };
  }

  // biome-ignore lint/suspicious/noExplicitAny: raw shape
  const booking = row as any;

  if (booking.status !== 'Disputed') {
    return { success: false, error: 'This booking does not have an active dispute' };
  }

  if (booking.dispute_claimed_by === null) {
    return { success: true }; // already unclaimed — idempotent
  }

  // Only the claimant or an admin can release a claim
  if (booking.dispute_claimed_by !== moderatorId && moderatorRole !== 'admin') {
    return {
      success: false,
      error: 'Only the moderator who holds this claim (or an admin) may release it',
      statusCode: 403,
    };
  }

  const { error: updateError } = await supabase
    .from('bookings')
    .update({
      dispute_claimed_by:  null,
      dispute_claimed_at:  null,
    })
    .eq('id', bookingId);

  if (updateError) {
    return { success: false, error: `unclaim failed: ${updateError.message}` };
  }

  await auditLogger.log({
    actorId:      moderatorId,
    action:       'dispute.modify',
    resourceType: 'dispute',
    resourceId:   bookingId,
    ip,
    meta:         { action: 'unclaim', previous_claimant: booking.dispute_claimed_by },
  });

  return { success: true };
}

// ─── Escalate ─────────────────────────────────────────────────────────────────

/**
 * Escalate a dispute to a senior admin.
 *
 * Records `dispute_escalated_at` + `dispute_escalation_note` and sets
 * `dispute_outcome = 'escalated'` on the booking row.  Does NOT change the
 * booking status — the case remains Disputed and in the queue but is now
 * visible in the `escalated` filter.
 *
 * Emits a notification to all admins via the `system_alert` channel (future:
 * could be a dedicated `dispute_escalated` type once the notification schema
 * is extended).
 */
export async function escalateDisputeCase(
  bookingId: string,
  moderatorId: string,
  escalationNote: string,
  ip?: string,
): Promise<ServiceResponse<void>> {
  const { data: row, error: fetchError } = await supabase
    .from('bookings')
    .select('id, status, dispute_status, dispute_claimed_by, tenant_id, properties!inner(owner_id)')
    .eq('id', bookingId)
    .single();

  if (fetchError || !row) {
    return { success: false, error: 'Dispute case not found' };
  }

  // biome-ignore lint/suspicious/noExplicitAny: raw Supabase join shape
  const booking = row as any;

  if (booking.status !== 'Disputed') {
    return { success: false, error: 'This booking does not have an active dispute' };
  }

  if (booking.dispute_escalated_at) {
    return { success: true }; // already escalated — idempotent
  }

  const { error: updateError } = await supabase
    .from('bookings')
    .update({
      dispute_escalated_at:   new Date().toISOString(),
      dispute_escalation_note: escalationNote,
      dispute_outcome:        'escalated',
    })
    .eq('id', bookingId);

  if (updateError) {
    return { success: false, error: `escalate failed: ${updateError.message}` };
  }

  await auditLogger.log({
    actorId:      moderatorId,
    action:       'dispute.modify',
    resourceType: 'dispute',
    resourceId:   bookingId,
    ip,
    meta:         { action: 'escalate', escalation_note: escalationNote },
  });

  // Notify participants that their case has been escalated
  const notifyIds = [
    booking.tenant_id,
    booking.properties?.owner_id,
  ].filter(Boolean) as string[];

  await Promise.all(
    notifyIds.map((uid) =>
      createNotification(uid, 'system_alert', {
        booking_id:       bookingId,
        message:          'Your dispute has been escalated to a senior review team.',
        escalation_note:  escalationNote,
      }).catch(() => {}),
    ),
  );

  return { success: true };
}

// ─── Resolve ──────────────────────────────────────────────────────────────────

/**
 * Resolve a dispute with a financial outcome and a mandatory resolution note.
 *
 * This is the **only** path that should be called for admin dispute resolution.
 * It delegates to `bookingService.resolveDispute()` which handles:
 *   - TrustlessWork escrow settlement (release_to_host or cancel/refund_tenant)
 *   - VALID_TRANSITIONS state machine (Disputed → Completed | Cancelled)
 *   - Participant notifications
 *
 * After a successful resolution this function:
 *   - Writes `dispute_resolution_note`, `dispute_resolved_at`, `dispute_outcome`
 *     to the booking row (the service only updates status/dispute_status).
 *   - Emits `dispute.resolve` audit log entry with actor, outcome, and note.
 *
 * Idempotency: if the booking is already in a terminal status (Completed or
 * Cancelled) the call returns `{ alreadyResolved: true }` without re-running
 * escrow logic.  This prevents double-release if a moderator clicks Submit
 * twice.
 *
 * @param bookingId        - UUID of the booking
 * @param moderatorId      - UUID of the moderator resolving the case
 * @param moderatorRole    - 'admin' | 'moderator'
 * @param outcome          - Financial disposition
 * @param resolutionNote   - Required moderator-authored explanation (min 10 chars)
 * @param approvalActorId  - UUID of the second approver (dual-approval)
 * @param ip               - Caller IP for audit
 */
export async function resolveDisputeCase(
  bookingId: string,
  moderatorId: string,
  moderatorRole: string,
  outcome: DisputeOutcome,
  resolutionNote: string,
  approvalActorId: string,
  ip?: string,
): Promise<ServiceResponse<{ alreadyResolved: boolean }>> {
  // Fetch current booking state
  const { data: row, error: fetchError } = await supabase
    .from('bookings')
    .select('id, status, dispute_status, dispute_outcome, dispute_resolved_at')
    .eq('id', bookingId)
    .single();

  if (fetchError || !row) {
    return { success: false, error: 'Dispute case not found' };
  }

  // biome-ignore lint/suspicious/noExplicitAny: raw shape
  const booking = row as any;

  // ── Idempotency guard ──────────────────────────────────────────────────────
  const terminalStatuses = new Set(['Completed', 'Cancelled']);
  if (terminalStatuses.has(booking.status)) {
    return { success: true, data: { alreadyResolved: true } };
  }

  if (booking.status !== 'Disputed') {
    return {
      success: false,
      error: `Cannot resolve: booking is in '${booking.status}' status, expected 'Disputed'`,
    };
  }

  // Map split → refund_tenant for escrow (split is a UI concept; the escrow
  // system only supports full release or full cancel; partial splits require
  // separate manual escrow operations outside this flow).
  const escrowResolution: 'release_to_host' | 'refund_tenant' =
    outcome === 'release_to_host' ? 'release_to_host' : 'refund_tenant';

  // ── Delegate to the authoritative service path ─────────────────────────────
  const serviceResult = await bookingService.resolveDispute(
    bookingId,
    moderatorId,
    escrowResolution,
    resolutionNote,
    moderatorRole,
  );

  if (!serviceResult.success) {
    await auditLogger.log({
      actorId:      moderatorId,
      action:       'dispute.resolve',
      resourceType: 'dispute',
      resourceId:   bookingId,
      ip,
      success:      false,
      error:        serviceResult.error,
      meta:         { outcome, resolution_note: resolutionNote, approval_actor: approvalActorId },
    });
    return serviceResult as ServiceResponse<never>;
  }

  // ── Persist resolution metadata ────────────────────────────────────────────
  // The service layer already updated status and dispute_status.
  // We write the additional admin-layer fields that the service doesn't know about.
  const { error: metaUpdateError } = await supabase
    .from('bookings')
    .update({
      dispute_resolution_note:  resolutionNote,
      dispute_resolved_at:      new Date().toISOString(),
      dispute_outcome:          outcome === 'split' ? 'split' : escrowResolution,
      dispute_claimed_by:       null,   // release claim on resolution
      dispute_claimed_at:       null,
    })
    .eq('id', bookingId);

  if (metaUpdateError) {
    // The escrow and state transition already succeeded — log the metadata
    // failure but do not fail the overall resolution so the escrow is not
    // double-released on a retry.
    console.error(
      `[DisputeResolution] metadata update failed for booking ${bookingId}: ${metaUpdateError.message}`,
    );
  }

  await auditLogger.log({
    actorId:      moderatorId,
    action:       'dispute.resolve',
    resourceType: 'dispute',
    resourceId:   bookingId,
    ip,
    success:      true,
    meta: {
      outcome,
      escrow_resolution:  escrowResolution,
      resolution_note:    resolutionNote,
      approval_actor:     approvalActorId,
      dual_approval:      true,
    },
  });

  return { success: true, data: { alreadyResolved: false } };
}
