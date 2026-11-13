-- The leaderboards as last built (worker/board.ts), so a board request reads this one row instead
-- of every verified run. `version` goes up whenever something changes what they show; they are
-- rebuilt once it has moved past `built`, or a new week has begun since `week_start`.
CREATE TABLE board (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  built INTEGER NOT NULL,
  week_start INTEGER NOT NULL,
  data TEXT
);
INSERT INTO board (id, version, built, week_start) VALUES (1, 1, 0, 0);

-- A player's best run in one step (worker/runs.ts bestScore), and whether a finished run is their
-- best this week without reading all their runs (finishRun).
CREATE INDEX runs_best ON runs (user_id, status, hidden, score DESC, finished_at);
