-- #blockchain-degraded-mode: Durable queue for on-chain operations that were
-- submitted while the Soroban RPC or TrustlessWork API was degraded/unavailable.
--
-- During an outage, eligible operations (create_booking_on_chain,
-- cancel_booking_on_chain, update_booking_status_on_chain) are persisted here
-- instead of failing the whole request.  When the circuit breaker closes
-- (dependency recovers), a drain loop processes queued ops in order.
--
-- ## Op type taxonomy
--
--   create_booking_on_chain       — record the booking on Soroban after escrow
--   cancel_booking_on_chain       — cancel the on-chain record on cancellation
--   update_booking_status_on_chain — sync status change to Soroban
--   release_escrow                — TrustlessWork release (confirm/complete)
--   cancel_escrow                 — TrustlessWork cancel (full refund)
--
-- ## Idempotency
--
-- Each row carries an idempotency_key (booking_id + op_type + sequence).
-- The UNIQUE constraint on idempotency_key ensures the drain loop never
-- submits the same operation twice even if it crashes and replays.
--
-- ## Status lifecycle
--
--   queued    → waiting for recovery drain
--   draining  → drain loop has claimed this row
--   done      → operation completed successfully
--   failed    → exceeded max_attempts; requires operator intervention
--
-- ## Precedence over the ledger_event_inbox
--
-- This table is NOT the same as ledger_event_inbox (which tracks inbound
-- blockchain events for idempotent projection).  blockchain_pending_ops
-- tracks OUTBOUND operations that must be submitted once the chain is back.

CREATE TABLE IF NOT EXISTS blockchain_pending_ops (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ── Identity ──────────────────────────────────────────────────────────────
  -- booking_id is the Supabase UUID of the booking this op belongs to.
  booking_id       UUID        NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,

  -- op_type identifies the exact operation to execute on recovery.
  op_type          VARCHAR(60) NOT NULL
                   CHECK (op_type IN (
                     'create_booking_on_chain',
                     'cancel_booking_on_chain',
                     'update_booking_status_on_chain',
                     'release_escrow',
                     'cancel_escrow'
                   )),

  -- ── Idempotency key ───────────────────────────────────────────────────────
  -- Composed by the application as "<booking_id>:<op_type>:<sequence_counter>".
  -- Prevents the drain loop from executing the same logical op twice.
  idempotency_key  TEXT        NOT NULL,

  -- ── Payload ───────────────────────────────────────────────────────────────
  -- All arguments needed to replay the operation: addresses, amounts, flags.
  -- Stored as JSONB so the drain loop can reconstruct the call without
  -- querying the booking again.
  payload          JSONB       NOT NULL DEFAULT '{}',

  -- ── Status tracking ───────────────────────────────────────────────────────
  status           VARCHAR(20) NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'draining', 'done', 'failed')),

  attempt_count    SMALLINT    NOT NULL DEFAULT 0,
  max_attempts     SMALLINT    NOT NULL DEFAULT 5,
  last_error       TEXT,
  last_attempted_at TIMESTAMPTZ,

  -- Worker identity that claimed this row (for stale-claim detection).
  claimed_by       TEXT,
  claimed_at       TIMESTAMPTZ,

  -- ── Timestamps ────────────────────────────────────────────────────────────
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,

  CONSTRAINT uq_blockchain_pending_ops_key UNIQUE (idempotency_key)
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Primary drain queue: oldest queued ops first.
CREATE INDEX IF NOT EXISTS idx_bpo_queued
  ON blockchain_pending_ops (created_at ASC)
  WHERE status = 'queued';

-- Per-booking lookup: show all pending ops for a booking.
CREATE INDEX IF NOT EXISTS idx_bpo_booking
  ON blockchain_pending_ops (booking_id);

-- Stale-claim detection: find rows claimed a long time ago still in 'draining'.
CREATE INDEX IF NOT EXISTS idx_bpo_stale
  ON blockchain_pending_ops (claimed_at ASC)
  WHERE status = 'draining';

-- Retry queue: failed rows with remaining attempts.
CREATE INDEX IF NOT EXISTS idx_bpo_retryable
  ON blockchain_pending_ops (last_attempted_at ASC)
  WHERE status = 'failed' AND attempt_count < 5;

-- ── Access control ────────────────────────────────────────────────────────────

ALTER TABLE blockchain_pending_ops ENABLE ROW LEVEL SECURITY;

CREATE POLICY bpo_service_role_only ON blockchain_pending_ops
  USING (auth.role() = 'service_role');
