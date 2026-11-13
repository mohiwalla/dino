-- When a later run started while this one's finish was still on its way (POST /api/runs `after`).
-- From then on the run only drains what it had queued: its uploads are clocked no later than this,
-- and it closes FINISH_WINDOW_MS after it. Set once; a later start can't move it.
ALTER TABLE runs ADD COLUMN superseded_at INTEGER;
