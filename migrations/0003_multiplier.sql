-- The game speed multiplier a run was played at (Settings.multiplier); it shares the board, tagged.
ALTER TABLE runs ADD COLUMN multiplier REAL NOT NULL DEFAULT 1;
