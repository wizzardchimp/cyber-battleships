-- Editable question sets. Defaults are written once at boot and are never
-- overwritten by a redeploy, so facilitator edits survive code pushes.

CREATE TABLE IF NOT EXISTS question_sets (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  questions   jsonb NOT NULL,
  is_custom   boolean NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL
);
