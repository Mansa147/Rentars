/**
 * adminDispute.controller.ts
 *
 * HTTP handlers for the moderator dispute-resolution workflow.
 * All routes require an admin-family JWT (enforced by requireAdminRole) and
 * the appropriate scope (enforced by requireScope) before these handlers run.
 *
 * Endpoints
 * ─────────
 *   GET  /admin/disputes                 — paginated queue with filters
 *   GET  /admin/disputes/:id             — full case detail
 *   POST /admin/disputes/:id/claim       — assign case to the calling moderator
 *   POST /admin/disputes/:id/unclaim     — return case to the open queue
 *   POST /admin/disputes/:id/escalate    — escalate to senior admin
 *   POST /admin/disputes/:id/resolve     — financial resolution (dual-approval)
 */

import type { Response } from 'express';
import { z } from 'zod';
import type { AdminRequest } from '@/middleware/admin.middleware.js';
import {
  listDisputeQueue,
  getDisputeCase,
  claimDisputeCase,
  unclaimDisputeCase,
  escalateDisputeCase,
  resolveDisputeCase,
} from '@/services/disputeResolution.service.js';

// ─── Validation schemas ───────────────────────────────────────────────────────

const listQuerySchema = z.object({
  queue: z.enum(['open', 'claimed', 'escalated', 'all']).default('open'),
  claimed_by: z.string().uuid('claimed_by must be a UUID').optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const escalateBodySchema = z.object({
  escalation_note: z
    .string()
    .min(10, 'escalation_note must be at least 10 characters')
    .max(2000, 'escalation_note must be 2000 characters or fewer'),
});

const resolveBodySchema = z.object({
  outcome: z.enum(['refund_tenant', 'release_to_host', 'split'], {
    required_error: 'outcome is required',
    invalid_type_error: 'outcome must be refund_tenant | release_to_host | split',
  }),
  resolution_note: z
    .string()
    .min(10, 'resolution_note must be at least 10 characters')
    .max(2000, 'resolution_note must be 2000 characters or fewer'),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function badRequest(res: Response, details: Record<string, string[]>): void {
  res.status(400).json({ error: { code: 'VALIDATION_ERROR', details } });
}

function notFound(res: Response, message: string): void {
  res.status(404).json({ error: { code: 'NOT_FOUND', message } });
}

function forbidden(res: Response, message: string): void {
  res.status(403).json({ error: { code: 'FORBIDDEN', message } });
}

function serverError(res: Response, message: string): void {
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message } });
}

// ─── Handlers ────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/disputes
 *
 * Return the paginated moderator dispute queue.
 *
 * Query params:
 *   queue       — 'open' (default) | 'claimed' | 'escalated' | 'all'
 *   claimed_by  — UUID: filter claimed cases to a specific moderator
 *   page        — integer >= 1 (default 1)
 *   limit       — 1–100 (default 20)
 *
 * Scope: admin:disputes:read
 */
export async function listDisputeQueue_handler(
  req: AdminRequest,
  res: Response,
): Promise<void> {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    badRequest(res, parsed.error.flatten().fieldErrors as Record<string, string[]>);
    return;
  }

  const result = await listDisputeQueue(parsed.data);
  if (!result.success) {
    serverError(res, result.error ?? 'Failed to load dispute queue');
    return;
  }

  const { cases, total } = result.data!;
  res.status(200).json({
    data: cases,
    meta: {
      page:  parsed.data.page,
      limit: parsed.data.limit,
      total,
      queue: parsed.data.queue,
    },
  });
}

/**
 * GET /api/v1/admin/disputes/:id
 *
 * Full dispute case detail: booking state, property, tenant/host identities
 * (id + email + role only — no sensitive fields), payment status, escrow ID,
 * and the full booking status history for the timeline.
 *
 * Scope: admin:disputes:read
 */
export async function getDisputeCase_handler(
  req: AdminRequest,
  res: Response,
): Promise<void> {
  const { id } = req.params;
  if (!id) {
    notFound(res, 'Dispute ID is required');
    return;
  }

  const result = await getDisputeCase(id);

  if (!result.success) {
    const msg = result.error ?? '';
    if (msg.includes('not found') || msg.includes('does not have a dispute record')) {
      notFound(res, msg);
    } else {
      serverError(res, msg);
    }
    return;
  }

  res.status(200).json({ data: result.data });
}

/**
 * POST /api/v1/admin/disputes/:id/claim
 *
 * Assign the calling moderator as the active reviewer.
 * Idempotent: claiming a case you already own returns HTTP 200.
 * Stale claims (older than 4h) can be reclaimed by another moderator.
 *
 * Scope: admin:disputes:claim
 */
export async function claimDispute_handler(
  req: AdminRequest,
  res: Response,
): Promise<void> {
  const { id } = req.params;
  if (!id) {
    notFound(res, 'Dispute ID is required');
    return;
  }

  const moderatorId = req.adminId!;
  const result = await claimDisputeCase(id, moderatorId, req.ip);

  if (!result.success) {
    const msg = result.error ?? '';
    if (msg.includes('not found')) {
      notFound(res, msg);
    } else if (msg.includes('currently claimed')) {
      res.status(409).json({ error: { code: 'ALREADY_CLAIMED', message: msg } });
    } else {
      serverError(res, msg);
    }
    return;
  }

  const { alreadyOwned } = result.data!;
  res.status(200).json({
    message: alreadyOwned ? 'You already own this case.' : 'Case claimed successfully.',
    claimed_by: moderatorId,
    booking_id: id,
  });
}

/**
 * POST /api/v1/admin/disputes/:id/unclaim
 *
 * Release the claim, returning the case to the open queue.
 * Only the current claimant or an admin may unclaim.
 *
 * Scope: admin:disputes:claim
 */
export async function unclaimDispute_handler(
  req: AdminRequest,
  res: Response,
): Promise<void> {
  const { id } = req.params;
  if (!id) {
    notFound(res, 'Dispute ID is required');
    return;
  }

  const result = await unclaimDisputeCase(
    id,
    req.adminId!,
    req.adminRole!,
    req.ip,
  );

  if (!result.success) {
    const msg = result.error ?? '';
    if (msg.includes('not found')) {
      notFound(res, msg);
    } else if (result.statusCode === 403) {
      forbidden(res, msg);
    } else {
      serverError(res, msg);
    }
    return;
  }

  res.status(200).json({ message: 'Case returned to queue.', booking_id: id });
}

/**
 * POST /api/v1/admin/disputes/:id/escalate
 *
 * Escalate the case to a senior admin and add an escalation note.
 * Idempotent: re-escalating an already-escalated case is a no-op.
 *
 * Body:
 *   escalation_note  — required, 10–2000 chars
 *
 * Scope: admin:disputes:escalate
 */
export async function escalateDispute_handler(
  req: AdminRequest,
  res: Response,
): Promise<void> {
  const { id } = req.params;
  if (!id) {
    notFound(res, 'Dispute ID is required');
    return;
  }

  const parsed = escalateBodySchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, parsed.error.flatten().fieldErrors as Record<string, string[]>);
    return;
  }

  const result = await escalateDisputeCase(
    id,
    req.adminId!,
    parsed.data.escalation_note,
    req.ip,
  );

  if (!result.success) {
    const msg = result.error ?? '';
    if (msg.includes('not found')) {
      notFound(res, msg);
    } else {
      serverError(res, msg);
    }
    return;
  }

  res.status(200).json({
    message: 'Case escalated.',
    booking_id: id,
    escalated_by: req.adminId,
  });
}

/**
 * POST /api/v1/admin/disputes/:id/resolve
 *
 * Resolve the dispute with a financial outcome and a mandatory resolution note.
 * This is a HIGH-RISK action requiring dual approval (X-Approval-Actor header).
 * The requireScope middleware enforces dual-approval before this handler runs.
 *
 * Body:
 *   outcome          — 'refund_tenant' | 'release_to_host' | 'split'
 *   resolution_note  — required, 10–2000 chars
 *
 * The handler is idempotent: if the booking is already in a terminal state
 * (Completed or Cancelled) it returns HTTP 200 with `already_resolved: true`.
 *
 * Scope: admin:disputes:resolve  (dual-approval required)
 */
export async function resolveDispute_handler(
  req: AdminRequest,
  res: Response,
): Promise<void> {
  const { id } = req.params;
  if (!id) {
    notFound(res, 'Dispute ID is required');
    return;
  }

  const parsed = resolveBodySchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, parsed.error.flatten().fieldErrors as Record<string, string[]>);
    return;
  }

  const { outcome, resolution_note } = parsed.data;
  const approvalActorId =
    (req as AdminRequest & { approvalActorId?: string }).approvalActorId ?? '';

  const result = await resolveDisputeCase(
    id,
    req.adminId!,
    req.adminRole!,
    outcome,
    resolution_note,
    approvalActorId,
    req.ip,
  );

  if (!result.success) {
    const msg = result.error ?? '';
    if (msg.includes('not found')) {
      notFound(res, msg);
    } else if (msg.includes('Cannot resolve') || msg.includes('No active dispute')) {
      res.status(422).json({ error: { code: 'INVALID_STATE', message: msg } });
    } else if (msg.includes('Failed to resolve escrow') || msg.includes('temporarily unavailable')) {
      // Circuit-open or escrow failure — tell the caller to retry
      res.status(503).json({ error: { code: 'ESCROW_UNAVAILABLE', message: msg } });
    } else {
      serverError(res, msg);
    }
    return;
  }

  const { alreadyResolved } = result.data!;

  if (alreadyResolved) {
    res.status(200).json({
      message: 'This dispute has already been resolved.',
      already_resolved: true,
      booking_id: id,
    });
    return;
  }

  res.status(200).json({
    message: 'Dispute resolved.',
    already_resolved: false,
    booking_id: id,
    outcome,
    resolved_by:   req.adminId,
    co_approved_by: approvalActorId,
  });
}
