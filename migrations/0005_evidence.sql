-- "Delete my stats" hides a player's runs from the board and their own list; admins still see
-- them, so a flagged run can't be erased before it is reviewed (and the start rate limit, which
-- counts rows, can't be reset).
ALTER TABLE runs ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
-- What the verifier decided (ok | review | rejected) and the numbers it decided on (RunChecks,
-- worker/verify.ts), kept apart from status, which admins change. Null for runs from before.
ALTER TABLE runs ADD COLUMN verdict TEXT;
ALTER TABLE runs ADD COLUMN checks TEXT;

-- Every admin decision on a run: who, when, and from which status to which.
CREATE TABLE run_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  admin_id TEXT NOT NULL REFERENCES users(id),
  at INTEGER NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL
);

CREATE INDEX run_reviews_by_run ON run_reviews (run_id, at);
