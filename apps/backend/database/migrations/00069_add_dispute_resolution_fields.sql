-- #admin-dispute-resolution: Add missing dispute columns and support
-- the full moderator claim → review → resolve workflow.
--
-- Columns added to bookings:
--
--   dispute_details         — extended evidence text from the raiseDisputeSchema
--                             `details` field; was accepted by the service but had
--                             no corresponding column.
--
--   dispute_resolution_note — moderator-authored note explaining the decision;
--                             referenced in admin.controller.ts but missing from
--                             every previous migration.
--
--   dispute_resolved_at     — timestamp when the dispute was closed; referenced
--                             in admin.controller.ts but missing.
--
--   dispute_outcome         — the financial disposition:
--                             'refund_tenant' | 'release_to_host' | 'split' | 'escalated'
--                             referenced in admin.controller.ts but missing.
--
--   dispute_claimed_by      — UUID of the moderator who has claimed this case for
--                             active review; NULL = unclaimed (in queue).
--
--   dispute_claimed_at      — when the claim was recorded; used for stale-claim
--                             detection (moderator closed their browser mid-review).
--
--   dispute_escalated_at    — when the case was escalated to a senior role.
--
--   dispute_escalation_note — reason for escalation.
--
-- Status CHECK constraint:
--   The existing constraint (00062_booking_expiry_and_timeout.sql) only allows
--   Pending | Confirmed | Cancelled | Completed | Disputed | Expired.
--   The admin controller previously tried to write 'dispute_resolved' which
--   would have been rejected. Instead of adding a seventh status to the state
--   machine (which would break VALID_TRANSITIONS), we keep the existing six
--   statuses: a resolved dispute ends as 'Completed' (host wins) or 'Cancelled'
--   (tenant wins), matching the service-layer state machine. The
--   dispute_outcome column carries the financial disposition detail.
--
-- All ALTER TABLEs use ADD COLUMN IF NOT EXISTS for idempotency.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS dispute_details           TEXT,
  ADD COLUMN IF NOT EXISTS dispute_resolution_note   TEXT,
  ADD COLUMN IF NOT EXISTS dispute_resolved_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dispute_outcome           VARCHAR(32)
    CHECK (dispute_outcome IN ('refund_tenant', 'release_to_host', 'split', 'escalated')),
  ADD COLUMN IF NOT EXISTS dispute_claimed_by        UUID
    REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS dispute_claimed_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dispute_escalated_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dispute_escalation_note   TEXT;

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Moderator work queue: all open, unclaimed disputes ordered by age.
CREATE INDEX IF NOT EXISTS idx_bookings_dispute_queue
  ON bookings (created_at ASC)
  WHERE status = 'Disputed'
    AND dispute_status = 'raised'
    AND dispute_claimed_by IS NULL;

-- Claimed cases: find cases owned by a specific moderator quickly.
CREATE INDEX IF NOT EXISTS idx_bookings_dispute_claimed
  ON bookings (dispute_claimed_by, dispute_claimed_at DESC)
  WHERE status = 'Disputed'
    AND dispute_claimed_by IS NOT NULL;

-- Stale-claim detection: claims older than a threshold can be reclaimed.
CREATE INDEX IF NOT EXISTS idx_bookings_dispute_stale_claims
  ON bookings (dispute_claimed_at ASC)
  WHERE status = 'Disputed'
    AND dispute_claimed_by IS NOT NULL;
