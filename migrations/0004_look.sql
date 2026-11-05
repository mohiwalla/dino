-- How a run looked and sounded to its player (RunLook: their settings and the random crash
-- clip, line and move), for its replay; and whether it was a new best they celebrated.
ALTER TABLE runs ADD COLUMN look TEXT;
ALTER TABLE runs ADD COLUMN cheered INTEGER NOT NULL DEFAULT 0;
