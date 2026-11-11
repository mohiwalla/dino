-- The upload protocol a run started under (RUN_PROTOCOL, src/sim/replay.ts). 1: unnumbered beats,
-- a pause read from two beats at the same step. 2: numbered uploads that say what they are.
ALTER TABLE runs ADD COLUMN protocol INTEGER NOT NULL DEFAULT 1;
-- The last upload accepted (its number and a hash of it), so a resend is answered rather than
-- refused; and the finish's answer, so a resent finish gets it again.
ALTER TABLE runs ADD COLUMN last_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN last_upload TEXT;
ALTER TABLE runs ADD COLUMN receipt TEXT;
