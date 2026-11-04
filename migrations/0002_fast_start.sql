-- "Start fast" runs begin at RUNNER.FAST_START_SPEED; they share the board, tagged.
ALTER TABLE runs ADD COLUMN fast INTEGER NOT NULL DEFAULT 0;
