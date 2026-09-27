-- #idempotent-sync: Ledger event inbox — write-before-process pattern.
--
-- Every ledger event (blockchain state change) is written to this table BEFORE
-- the corresponding projection (booking, review, payment, notification) is
-- applied.  The canonical event_key makes the inbox unconditionally idempotent:
-- inserting a duplicate key is a no-op, so replaying, restarting, or
-- reorg-rewinding the sync worker never duplicates side effects.
--
-- Lifecycle of a row:
--   pending     → the event was written but processing has not started yet.
--   processing  → a worker claimed the row (used to detect crashed workers).
--   processed   → the projection was applied successfully.
--   failed      → the last attempt threw an unrecoverable error.
--   dead        → exceeded MAX_RETRY_ATTEMPTS; moved to the dead-letter set.
--
-- Canonical event_key format:
--   "<entity_type>:<contract_id>:<ledger_sequence>:<tx_hash>"
--
--   Examples:
--     "booking:CBOOKI…:47821345:abcdef…"
--     "property:CPROPI…:47821345:abcdef…"
--
-- The event_key has a UNIQUE constraint so the standard INSERT … ON CONFLICT
-- DO NOTHING pattern is sufficient for idempotent ingest.

CREATE TABLE IF NOT EXISTS ledger_event_inbox (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ── Canonical deduplication key ─────────────────────────────────────────
  -- "<entity_type>:<contract_id>:<ledger_sequence>:<tx_hash>"
  -- Unique across the table — duplicate events are silently discarded.
  event_key         TEXT        NOT NULL,

  -- ── Event classification ─────────────────────────────────────────────────
  entity_type       VARCHAR(50) NOT NULL
                    CHECK (entity_type IN ('booking', 'property', 'review', 'payment')),
  entity_id         TEXT        NOT NULL,   -- on-chain entity ID (u64 stringified)
  contract_id       TEXT        NOT NULL,

  -- ── Ledger provenance ────────────────────────────────────────────────────
  -- ledger_sequence is the Stellar ledger number from which this event came.
  -- Used by the cursor service to track the high-water mark.
  ledger_sequence   BIGINT      NOT NULL,
  tx_hash           TEXT,

  -- ── Raw payload ──────────────────────────────────────────────────────────
  -- The full event data as received from the Soroban RPC / polling snapshot.
  -- Stored so projections can be replayed without re-fetching from the chain.
  payload           JSONB       NOT NULL DEFAULT '{}',

  -- ── Processing state ─────────────────────────────────────────────────────
  status            VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'processed', 'failed', 'dead')),

  -- Worker that claimed this row (process ID / hostname for observability).
  claimed_by        TEXT,
  claimed_at        TIMESTAMPTZ,

  -- ── Retry tracking ───────────────────────────────────────────────────────
  attempt_count     SMALLINT    NOT NULL DEFAULT 0,
  max_attempts      SMALLINT    NOT NULL DEFAULT 5,
  last_error        TEXT,
  last_attempted_at TIMESTAMPTZ,

  -- ── Timestamps ───────────────────────────────────────────────────────────
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at      TIMESTAMPTZ,

  CONSTRAINT uq_ledger_event_inbox_key UNIQUE (event_key)
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Primary work queue: fetch pending events ordered by ledger sequence.
CREATE INDEX IF NOT EXISTS idx_lei_pending
  ON ledger_event_inbox (ledger_sequence ASC)
  WHERE status = 'pending';

-- Retry queue: failed rows that have not yet hit the default max_attempts (5).
-- Partial index WHERE clauses must use constants, not column-to-column
-- comparisons.  5 matches DEFAULT_MAX_ATTEMPTS in ledgerEventInbox.service.ts.
CREATE INDEX IF NOT EXISTS idx_lei_retryable
  ON ledger_event_inbox (last_attempted_at ASC)
  WHERE status = 'failed' AND attempt_count < 5;

-- Dead-letter view: rows promoted to dead status for operator inspection.
CREATE INDEX IF NOT EXISTS idx_lei_dead
  ON ledger_event_inbox (created_at DESC)
  WHERE status = 'dead';

-- Per-entity lookup (e.g. show all events for booking X).
CREATE INDEX IF NOT EXISTS idx_lei_entity
  ON ledger_event_inbox (entity_type, entity_id);

-- Stale-claim detection: find rows claimed long ago but still in 'processing'.
CREATE INDEX IF NOT EXISTS idx_lei_stale_claims
  ON ledger_event_inbox (claimed_at ASC)
  WHERE status = 'processing';

-- ── Access control ────────────────────────────────────────────────────────────

-- The sync worker runs as service_role; normal users must never touch this table.
ALTER TABLE ledger_event_inbox ENABLE ROW LEVEL SECURITY;

CREATE POLICY lei_service_role_only ON ledger_event_inbox
  USING (auth.role() = 'service_role');
