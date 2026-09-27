-- #idempotent-sync: Sync cursors — persist the last-confirmed ledger sequence
-- per entity type so the sync worker can resume from a known position after a
-- restart without re-processing the full ledger history from genesis.
--
-- One row per worker_id + entity_type pair.  The worker_id column lets future
-- multi-instance deployments maintain per-instance cursors (useful for
-- horizontal scaling and leader-election patterns).
--
-- How to resume:
--   SELECT last_ledger_sequence FROM sync_cursors
--   WHERE worker_id = 'primary' AND entity_type = 'booking';
--   -- Start the next poll from last_ledger_sequence + 1
--
-- Lag calculation (used by metrics and the status endpoint):
--   chain_tip_ledger - last_ledger_sequence = lag_ledgers

CREATE TABLE IF NOT EXISTS sync_cursors (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Logical worker identity.  Use 'primary' for a single-instance deployment.
  -- A future multi-instance deployment would use hostname / pod name.
  worker_id           VARCHAR(100) NOT NULL DEFAULT 'primary',

  -- Entity being tracked.
  entity_type         VARCHAR(50)  NOT NULL
                      CHECK (entity_type IN ('booking', 'property', 'review', 'payment')),

  -- The highest ledger sequence for which all events have been fully processed
  -- and their projections committed.  NULL means the cursor has never been
  -- advanced (cold start — process from ledger 1 or the configured start ledger).
  last_ledger_sequence BIGINT,

  -- Wall-clock time when the cursor was last advanced.
  -- Used to detect a stalled worker (cursor not moving).
  last_advanced_at    TIMESTAMPTZ,

  -- Informational: the chain tip at the time of the last advance.
  -- Allows computing lag = chain_tip_at_last_advance - last_ledger_sequence.
  chain_tip_at_last_advance BIGINT,

  -- Timestamps
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_sync_cursors_worker_entity UNIQUE (worker_id, entity_type)
);

-- Fast lookup: the sync worker reads its cursor at the start of each run.
CREATE INDEX IF NOT EXISTS idx_sync_cursors_lookup
  ON sync_cursors (worker_id, entity_type);

-- ── Auto-update updated_at ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_sync_cursors_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_cursors_updated_at ON sync_cursors;
CREATE TRIGGER trg_sync_cursors_updated_at
  BEFORE UPDATE ON sync_cursors
  FOR EACH ROW EXECUTE FUNCTION update_sync_cursors_updated_at();

-- ── Seed primary cursors (cold-start rows) ────────────────────────────────────
-- Inserting placeholder rows ensures the worker always finds a cursor row
-- instead of getting NULL and having to distinguish "not found" from "at zero".
-- last_ledger_sequence = NULL means "start from the beginning".

INSERT INTO sync_cursors (worker_id, entity_type)
VALUES
  ('primary', 'booking'),
  ('primary', 'property'),
  ('primary', 'review'),
  ('primary', 'payment')
ON CONFLICT (worker_id, entity_type) DO NOTHING;

-- ── Access control ────────────────────────────────────────────────────────────

ALTER TABLE sync_cursors ENABLE ROW LEVEL SECURITY;

CREATE POLICY sync_cursors_service_role_only ON sync_cursors
  USING (auth.role() = 'service_role');
