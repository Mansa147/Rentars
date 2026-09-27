/**
 * adminSync.controller.ts — admin endpoints for sync worker observability.
 *
 * Endpoints:
 *   GET  /api/v1/admin/sync/status   — cursor positions, lag, inbox stats, DLQ count
 *   GET  /api/v1/admin/sync/dead-letter — paginated list of dead-lettered events
 *   POST /api/v1/admin/sync/cursor/reset — operator tool: reset a cursor to a given sequence
 *
 * All routes require the 'admin:reconciliation:read' scope (defined in
 * adminScopes.ts) which is held by the 'admin' and 'finance' roles.
 * The cursor reset route also validates the 'admin:reconciliation:read'
 * scope — operators wishing to restrict resets further can promote this
 * to a new 'admin:reconciliation:write' scope.
 */

import type { Response } from 'express';
import type { AdminRequest } from '@/middleware/admin.middleware.js';
import { z } from 'zod';
import { getInboxStats, listDeadLetterEvents } from '@/services/ledgerEventInbox.service.js';
import { computeLag, resetCursor } from '@/services/syncCursor.service.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function badRequest(res: Response, message: string): void {
  res.status(400).json({ success: false, error: message });
}

function internalError(res: Response, message: string): void {
  res.status(500).json({ success: false, error: message });
}

// ─── GET /api/v1/admin/sync/status ────────────────────────────────────────────

/**
 * Returns a combined view of:
 *   - cursor positions and lag for every tracked entity type
 *   - inbox queue depths (pending / processing / failed / dead)
 *   - processed event throughput over the last hour
 *
 * Operators can use this endpoint to confirm the worker is progressing,
 * identify stalled entity streams, and see dead-letter queue depth at a glance.
 *
 * Example response:
 * {
 *   "chain_tip": 47821345,
 *   "cursors": [
 *     { "entity_type": "booking", "last_ledger_sequence": 47821340,
 *       "lag_ledgers": 5, "last_advanced_at": "2026-09-27T10:00:00Z",
 *       "stalled": false },
 *     ...
 *   ],
 *   "inbox": {
 *     "pending": 3, "processing": 1, "failed": 2,
 *     "dead": 0, "processed_last_hour": 142
 *   }
 * }
 */
export async function getSyncStatusHandler(
  _req: AdminRequest,
  res: Response,
): Promise<void> {
  const [lagResult, inboxResult] = await Promise.all([
    computeLag(),
    getInboxStats(),
  ]);

  if (!lagResult.success) {
    internalError(res, `lag computation failed: ${lagResult.error}`);
    return;
  }

  if (!inboxResult.success) {
    internalError(res, `inbox stats failed: ${inboxResult.error}`);
    return;
  }

  const chainTip = lagResult.data![0]?.chain_tip ?? null;

  res.status(200).json({
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
      inbox: inboxResult.data!,
    },
  });
}

// ─── GET /api/v1/admin/sync/dead-letter ───────────────────────────────────────

const deadLetterQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : 50))
    .refine((n) => !Number.isNaN(n) && n > 0 && n <= 200, {
      message: 'limit must be 1–200',
    }),
  offset: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : 0))
    .refine((n) => !Number.isNaN(n) && n >= 0, {
      message: 'offset must be >= 0',
    }),
});

/**
 * Paginated list of dead-lettered ledger events.
 *
 * Query params:
 *   limit  — page size (1–200, default 50)
 *   offset — pagination offset (default 0)
 *
 * Each event includes the full error history and original payload so
 * operators can diagnose the root cause and decide whether to re-queue
 * or discard the event.
 */
export async function getDeadLetterEventsHandler(
  req: AdminRequest,
  res: Response,
): Promise<void> {
  const parsed = deadLetterQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    badRequest(res, parsed.error.issues.map((i) => i.message).join('; '));
    return;
  }

  const { limit, offset } = parsed.data;
  const result = await listDeadLetterEvents(limit, offset);

  if (!result.success) {
    internalError(res, result.error ?? 'unknown error');
    return;
  }

  res.status(200).json({
    success: true,
    data: result.data!.events,
    meta: {
      total: result.data!.total,
      limit,
      offset,
    },
  });
}

// ─── POST /api/v1/admin/sync/cursor/reset ─────────────────────────────────────

const resetCursorSchema = z.object({
  entity_type: z.enum(['booking', 'property', 'review', 'payment']),
  target_sequence: z
    .number()
    .int()
    .min(0, 'target_sequence must be >= 0'),
  worker_id: z.string().min(1).max(100).optional().default('primary'),
});

/**
 * Operator tool: reset a sync cursor to a specific ledger sequence.
 *
 * Used after a reorg, data-corruption incident, or source restart to replay
 * events from a known good point.  The inbox's idempotent writeEvent() and
 * per-entity deduplication in the projection layer guard against duplicate
 * side effects when replaying already-committed sequences.
 *
 * Body:
 *   entity_type      — "booking" | "property" | "review" | "payment"
 *   target_sequence  — ledger sequence to reset to (integer >= 0)
 *   worker_id        — worker to reset (default: "primary")
 *
 * ⚠️  This is a destructive operation.  Resetting backward may cause
 *     projections to be re-applied.  Audit log entry is written.
 */
export async function resetCursorHandler(
  req: AdminRequest,
  res: Response,
): Promise<void> {
  const parsed = resetCursorSchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, parsed.error.issues.map((i) => i.message).join('; '));
    return;
  }

  const { entity_type, target_sequence, worker_id } = parsed.data;

  const result = await resetCursor(entity_type, target_sequence, worker_id);
  if (!result.success) {
    internalError(res, result.error ?? 'cursor reset failed');
    return;
  }

  console.warn(
    `[AdminSync] Cursor reset by ${(req as AdminRequest & { user?: { id?: string } }).user?.id ?? 'unknown'}: ` +
    `entity=${entity_type} worker=${worker_id} target_sequence=${target_sequence}`,
  );

  res.status(200).json({
    success: true,
    data: {
      entity_type,
      worker_id,
      target_sequence,
      reset_at: new Date().toISOString(),
    },
  });
}
