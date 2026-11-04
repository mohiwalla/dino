// The leaderboard (each player's best verified run) and the admin tools around it.

import { requireUser } from './auth';
import type { Env } from './env';
import { HttpError, json, readJson } from './http';

const BOARD_SIZE = 50;

interface BoardRow {
  user_id: string;
  name: string;
  score: number;
  mobile: number;
  run_id: string;
  finished_at: number;
}

/** Each unbanned player's best ok run, best first; ties go to whoever got there first. */
const BEST_RUNS = `
  SELECT user_id, name, score, mobile, run_id, finished_at FROM (
    SELECT r.user_id, u.name, r.score, r.mobile, r.id AS run_id, r.finished_at,
           ROW_NUMBER() OVER (PARTITION BY r.user_id ORDER BY r.score DESC, r.finished_at ASC) AS n
    FROM runs r JOIN users u ON u.id = r.user_id
    WHERE r.status = 'ok' AND u.banned = 0
  ) WHERE n = 1
  ORDER BY score DESC, finished_at ASC`;

async function bestRuns(env: Env): Promise<BoardRow[]> {
  return (await env.DB.prepare(BEST_RUNS).all<BoardRow>()).results;
}

/** The player's 1-based place on the board, or null if they have no verified run. */
export async function boardRank(env: Env, userId: string): Promise<number | null> {
  const i = (await bestRuns(env)).findIndex((r) => r.user_id === userId);
  return i < 0 ? null : i + 1;
}

/** GET /api/leaderboard -> {entries: [{rank, name, score, mobile, runId, me}], me: {rank, score} | null, players} */
export async function leaderboard(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const rows = await bestRuns(env);
  const mine = rows.findIndex((r) => r.user_id === user.id);
  const entry = (r: BoardRow, i: number) => ({
    rank: i + 1,
    name: r.name,
    score: r.score,
    mobile: r.mobile === 1,
    runId: r.run_id,
    me: r.user_id === user.id,
  });
  return json({
    entries: rows.slice(0, BOARD_SIZE).map(entry),
    me: mine < 0 ? null : { rank: mine + 1, score: rows[mine].score },
    players: rows.length,
  });
}

async function requireAdmin(request: Request, env: Env): Promise<void> {
  const user = await requireUser(request, env);
  if (!user.admin) throw new HttpError(403, 'admins only');
}

/** GET /api/admin/runs?status=review|ok|rejected|void|all */
export async function adminRuns(request: Request, env: Env, url: URL): Promise<Response> {
  await requireAdmin(request, env);
  const status = url.searchParams.get('status') ?? 'review';
  const where = status === 'all' ? "r.status NOT IN ('open', 'abandoned')" : 'r.status = ?';
  const query = env.DB.prepare(
    `SELECT r.id, u.name, u.email, r.score, r.status, r.flags, r.mobile, r.steps, r.started_at, r.finished_at
     FROM runs r JOIN users u ON u.id = r.user_id WHERE ${where} ORDER BY r.finished_at DESC LIMIT 200`,
  );
  return json({ runs: (await (status === 'all' ? query : query.bind(status)).all()).results });
}

/** POST /api/admin/runs/:id {status: 'ok' | 'void'} */
export async function adminSetRun(request: Request, env: Env, id: string): Promise<Response> {
  await requireAdmin(request, env);
  const { status } = await readJson(request);
  if (status !== 'ok' && status !== 'void') throw new HttpError(400, "status must be 'ok' or 'void'");
  // A rejected run has no trusted score, so it cannot be approved.
  const updated = await env.DB.prepare("UPDATE runs SET status = ? WHERE id = ? AND status IN ('ok', 'review', 'void') AND score IS NOT NULL")
    .bind(status, id)
    .run();
  if (updated.meta.changes !== 1) throw new HttpError(404, 'no such scored run');
  return json({ ok: true });
}

/** GET /api/admin/users */
export async function adminUsers(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const users = await env.DB.prepare(
    `SELECT u.id, u.name, u.email, u.banned, u.created_at,
            (SELECT MAX(score) FROM runs WHERE user_id = u.id AND status = 'ok') AS best,
            (SELECT COUNT(*) FROM runs WHERE user_id = u.id AND status != 'abandoned') AS runs
     FROM users u ORDER BY u.name`,
  ).all();
  return json({ users: users.results });
}

/** POST /api/admin/users/:id {banned: boolean} */
export async function adminSetUser(request: Request, env: Env, id: string): Promise<Response> {
  await requireAdmin(request, env);
  const { banned } = await readJson(request);
  if (typeof banned !== 'boolean') throw new HttpError(400, 'banned must be true or false');
  const updated = await env.DB.prepare('UPDATE users SET banned = ? WHERE id = ?').bind(banned ? 1 : 0, id).run();
  if (updated.meta.changes !== 1) throw new HttpError(404, 'no such user');
  return json({ ok: true });
}
