/**
 * Admin Routes
 *
 * Every route in this file is protected by TWO middleware layers:
 *
 *   1. requireAdminRole  — validates a JWT with an admin-family role claim
 *      (admin | moderator | support | finance).
 *
 *   2. requireScope(scope) — verifies the caller's role includes the specific
 *      capability required by that endpoint.  HIGH-RISK scopes also require
 *      the X-Approval-Actor header (dual approval).
 *
 * See: src/config/adminScopes.ts   — scope definitions and role→scope mapping
 *      src/middleware/adminScope.middleware.ts — enforcement logic
 *      docs/admin-runbooks.md       — operational runbooks for each action
 *
 * Role capabilities at a glance:
 *   admin      — all scopes
 *   moderator  — content, disputes (read + claim + escalate + resolve), analytics
 *   support    — read-only lookup (no mutations)
 *   finance    — refund approval, reconciliation (dual-approval required)
 */

import { Router } from 'express';
import { requireAdminRole, requireScope } from '@/middleware/adminScope.middleware.js';
import {
  getRateLimitSummary,
  setFeaturedHandler,
  clearFeaturedHandler,
  getTopQueriesHandler,
  getZeroResultQueriesHandler,
  getSearchVolumeHandler,
  // User management
  listUsers,
  getUserDetail,
  suspendUser,
  activateUser,
  // Property management
  listAdminProperties,
  suspendProperty,
  activateProperty,
  // Bookings
  listAdminBookings,
  // Dashboard
  getDashboard,
  // Audit logs
  getAuditLogsHandler,
} from '@/controllers/admin.controller.js';

import {
  listDisputeQueue_handler,
  getDisputeCase_handler,
  claimDispute_handler,
  unclaimDispute_handler,
  escalateDispute_handler,
  resolveDispute_handler,
} from '@/controllers/adminDispute.controller.js';

const router = Router();

/**
 * All routes first verify the actor holds an admin-family role JWT.
 * Individual routes then check the specific scope required.
 */
router.use(requireAdminRole);

// ── Dashboard ─────────────────────────────────────────────────────────────────
// Scope: admin:dashboard:read
// Roles: admin, moderator
router.get('/dashboard', requireScope('admin:dashboard:read'), getDashboard);

// ── User management ───────────────────────────────────────────────────────────
// Scope: admin:users:read      → admin, moderator, support
// Scope: admin:users:suspend   → admin only (HIGH-RISK — dual approval required)
// Scope: admin:users:activate  → admin, moderator
router.get('/users',                  requireScope('admin:users:read'),     listUsers);
router.get('/users/:id',              requireScope('admin:users:read'),     getUserDetail);
router.post('/users/:id/suspend',     requireScope('admin:users:suspend'),  suspendUser);
router.post('/users/:id/activate',    requireScope('admin:users:activate'), activateUser);

// ── Property management ───────────────────────────────────────────────────────
// Scope: admin:properties:read     → admin, moderator, support
// Scope: admin:properties:suspend  → admin, moderator
// Scope: admin:properties:activate → admin, moderator
// Scope: admin:properties:feature  → admin, moderator
router.get('/properties',                          requireScope('admin:properties:read'),     listAdminProperties);
router.post('/properties/:id/suspend',             requireScope('admin:properties:suspend'),  suspendProperty);
router.post('/properties/:id/activate',            requireScope('admin:properties:activate'), activateProperty);
router.put('/properties/:id/featured',             requireScope('admin:properties:feature'),  setFeaturedHandler);
router.delete('/properties/:id/featured',          requireScope('admin:properties:feature'),  clearFeaturedHandler);

// ── Bookings (admin view) ─────────────────────────────────────────────────────
// Scope: admin:bookings:read → admin, moderator, support, finance
router.get('/bookings', requireScope('admin:bookings:read'), listAdminBookings);

// ── Dispute management ────────────────────────────────────────────────────────
//
// Scopes used:
//   admin:disputes:read     → admin, moderator, support, finance (read-only)
//   admin:disputes:claim    → admin, moderator (claim/unclaim)
//   admin:disputes:escalate → admin, moderator (escalate)
//   admin:disputes:resolve  → admin, moderator (HIGH-RISK — dual approval required)
//
// Workflow:
//   1. GET  /disputes          — browse open queue (read)
//   2. GET  /disputes/:id      — view full case detail (read)
//   3. POST /disputes/:id/claim    — assign case to self (claim)
//   4. POST /disputes/:id/unclaim  — return case to queue (claim)
//   5. POST /disputes/:id/escalate — escalate to senior admin (escalate)
//   6. POST /disputes/:id/resolve  — financial settlement (resolve, dual-approval)

router.get('/disputes',
  requireScope('admin:disputes:read'),
  listDisputeQueue_handler,
);

router.get('/disputes/:id',
  requireScope('admin:disputes:read'),
  getDisputeCase_handler,
);

router.post('/disputes/:id/claim',
  requireScope('admin:disputes:claim'),
  claimDispute_handler,
);

router.post('/disputes/:id/unclaim',
  requireScope('admin:disputes:claim'),
  unclaimDispute_handler,
);

router.post('/disputes/:id/escalate',
  requireScope('admin:disputes:escalate'),
  escalateDispute_handler,
);

router.post('/disputes/:id/resolve',
  requireScope('admin:disputes:resolve'),  // enforces dual-approval via requireScope
  resolveDispute_handler,
);

// ── Rate-limit summary ────────────────────────────────────────────────────────
// Scope: admin:ratelimits:read → admin, support
router.get('/rate-limits', requireScope('admin:ratelimits:read'), getRateLimitSummary);

// ── Search analytics ──────────────────────────────────────────────────────────
// Scope: admin:analytics:read → admin, moderator
router.get('/analytics/search/top-queries',  requireScope('admin:analytics:read'), getTopQueriesHandler);
router.get('/analytics/search/zero-results', requireScope('admin:analytics:read'), getZeroResultQueriesHandler);
router.get('/analytics/search/volume',       requireScope('admin:analytics:read'), getSearchVolumeHandler);

// ── Audit log ─────────────────────────────────────────────────────────────────
// Scope: admin:audit:read → admin, moderator, support, finance
router.get('/audit-logs', requireScope('admin:audit:read'), getAuditLogsHandler);

// ── Refund approval (finance) ─────────────────────────────────────────────────
// Scope: admin:refunds:approve → admin, finance (HIGH-RISK — dual approval required)
// Body: { booking_id: string, refund_amount: number, reason: string }
import { approveRefundHandler } from '@/controllers/admin.controller.js';
router.post('/refunds/approve', requireScope('admin:refunds:approve'), approveRefundHandler);

// ── Sync worker observability ──────────────────────────────────────────────────
// Scope: admin:reconciliation:read → admin, finance
import {
  getSyncStatusHandler,
  getDeadLetterEventsHandler,
  resetCursorHandler,
} from '@/controllers/adminSync.controller.js';

router.get('/sync/status',       requireScope('admin:reconciliation:read'), getSyncStatusHandler);
router.get('/sync/dead-letter',  requireScope('admin:reconciliation:read'), getDeadLetterEventsHandler);
router.post('/sync/cursor/reset', requireScope('admin:reconciliation:read'), resetCursorHandler);

export default router;
