-- #idempotent-sync: Add missing reconciliation columns to the bookings table.
--
-- These columns are already referenced by sync.service.ts and
-- reconcilePendingEscrow() but were never backed by a migration.  Adding them
-- here closes the gap between the TypeScript interface and the live schema.
--
-- escrow_hash               — Stellar transaction hash of the escrow fund call.
--                             Used as the polling key in reconcilePendingEscrow().
-- reconcile_attempts        — How many times we have polled this booking's tx.
--                             Capped at MAX_RECONCILE_ATTEMPTS before quarantine.
-- last_reconcile_at         — Wall-clock timestamp of the most recent attempt.
-- escrow_failure_notified_at — Set once when failure notifications are dispatched.
--                             Prevents duplicate tenant / host notifications.
-- last_reconcile_error      — Last error message stored for operator inspection.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS escrow_hash                TEXT,
  ADD COLUMN IF NOT EXISTS reconcile_attempts         SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reconcile_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS escrow_failure_notified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_reconcile_error       TEXT;

-- Index on escrow_hash for fast reconciliation look-ups.
CREATE INDEX IF NOT EXISTS idx_bookings_escrow_hash
  ON bookings (escrow_hash)
  WHERE escrow_hash IS NOT NULL;

-- Partial index for the reconciliation work queue:
-- only pending bookings that have an escrow hash and have not exhausted retries.
CREATE INDEX IF NOT EXISTS idx_bookings_reconcile_queue
  ON bookings (last_reconcile_at ASC NULLS FIRST)
  WHERE status = 'pending'
    AND escrow_hash IS NOT NULL
    AND reconcile_attempts < 5;

-- ── Add missing columns to the payments table ─────────────────────────────────
--
-- The TypeScript Payment interface uses version, last_event_hash,
-- amount_stroops, escrow_id, and quote_hash but the original
-- 00028_create_audit_and_payments.sql migration only has amount_usdc and
-- stellar_tx_hash.  Adding the missing columns here.

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS amount_stroops   NUMERIC(30, 0),
  ADD COLUMN IF NOT EXISTS escrow_id        TEXT,
  ADD COLUMN IF NOT EXISTS quote_hash       TEXT,
  ADD COLUMN IF NOT EXISTS version          INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_event_hash  TEXT;

-- Optimistic concurrency: ensure version is always positive.
-- Guarded with DO block to prevent duplicate constraint error on re-run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payments_version_positive' AND conrelid = 'payments'::regclass
  ) THEN
    ALTER TABLE payments ADD CONSTRAINT payments_version_positive CHECK (version >= 1);
  END IF;
END;
$$;

-- ── payment_callback_events ───────────────────────────────────────────────────
--
-- Replay ledger for inbound payment webhook events.
-- Referenced by paymentCallback.service.ts#isReplay() and #recordEvent()
-- but no migration existed.

CREATE TABLE IF NOT EXISTS payment_callback_events (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    TEXT        NOT NULL,          -- provider-assigned unique event ID
  provider    TEXT        NOT NULL DEFAULT 'trustless_work',
  booking_id  UUID        REFERENCES bookings(id) ON DELETE SET NULL,
  payload     JSONB       NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_payment_callback_events_event_id UNIQUE (event_id)
);

-- TTL index: the cleanup job purges rows older than 24 hours.
CREATE INDEX IF NOT EXISTS idx_pce_created_at
  ON payment_callback_events (created_at ASC);

-- Fast replay check by event_id.
CREATE INDEX IF NOT EXISTS idx_pce_event_id
  ON payment_callback_events (event_id);

ALTER TABLE payment_callback_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY pce_service_role_only ON payment_callback_events
  USING (auth.role() = 'service_role');
