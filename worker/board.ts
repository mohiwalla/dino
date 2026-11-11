// The leaderboard (each player's best verified run) and the admin tools around it.

import { requireUser, type User } from './auth';
import type { Env } from './env';
import { HttpError, json, readJson } from './http';

const BOARD_SIZE = 50;

interface BoardRow {
  user_id: string;
  name: string;
  score: number;
  mobile: number;
  fast: number;
  multiplier: number;
  run_id: string;
  finished_at: number;
}

/** Each unbanned player's best ok run (not deleted) finished in [from, to), best first; ties go to whoever got there first. */
const BEST_RUNS = `
  SELECT user_id, name, score, mobile, fast, multiplier, run_id, finished_at FROM (
    SELECT r.user_id, u.name, r.score, r.mobile, r.fast, r.multiplier, r.id AS run_id, r.finished_at,
           ROW_NUMBER() OVER (PARTITION BY r.user_id ORDER BY r.score DESC, r.finished_at ASC) AS n
    FROM runs r JOIN users u ON u.id = r.user_id
    WHERE r.status = 'ok' AND r.hidden = 0 AND u.banned = 0 AND r.finished_at >= ? AND r.finished_at < ?
  ) WHERE n = 1
  ORDER BY score DESC, finished_at ASC`;

async function bestRuns(env: Env, from = 0, to = Number.MAX_SAFE_INTEGER): Promise<BoardRow[]> {
  return (await env.DB.prepare(BEST_RUNS).bind(from, to).all<BoardRow>()).results;
}

/** Weeks run Monday 00:00 to Sunday 23:59, India time (UTC+5:30, no daylight saving). */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
/** Last week's winners are announced for the first days of the new week. */
const ANNOUNCE_MS = 3 * DAY_MS;

/** When the week holding `now` began (Monday 00:00 IST), in epoch ms. */
export function weekStart(now: number): number {
  const local = now + IST_OFFSET_MS;
  const midnight = Math.floor(local / DAY_MS) * DAY_MS;
  const sinceMonday = (new Date(midnight).getUTCDay() + 6) % 7;
  return midnight - sinceMonday * DAY_MS - IST_OFFSET_MS;
}

/** The player's 1-based place on the board, or null if they have no verified run. */
export async function boardRank(env: Env, userId: string): Promise<number | null> {
  const i = (await bestRuns(env)).findIndex((r) => r.user_id === userId);
  return i < 0 ? null : i + 1;
}

/**
 * GET /api/leaderboard -> {entries, me, players} for all time, the same for this week under `week`,
 * last week's top 3 under `lastWeek`, and `announce` while last week's winners are news.
 * entries: [{rank, name, score, mobile, fast, multiplier, runId, me}], me: {rank, score} | null.
 */
export async function leaderboard(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const now = Date.now();
  const start = weekStart(now);
  const [rows, week, last] = await Promise.all([bestRuns(env), bestRuns(env, start), bestRuns(env, start - WEEK_MS, start)]);
  const board = (list: BoardRow[]) => {
    const mine = list.findIndex((r) => r.user_id === user.id);
    return { entries: list.slice(0, BOARD_SIZE).map(entry), me: mine < 0 ? null : { rank: mine + 1, score: list[mine].score }, players: list.length };
  };
  const entry = (r: BoardRow, i: number) => ({
    rank: i + 1,
    name: r.name,
    score: r.score,
    mobile: r.mobile === 1,
    fast: r.fast === 1,
    multiplier: r.multiplier,
    runId: r.run_id,
    me: r.user_id === user.id,
  });
  return json({
    ...board(rows),
    week: board(week),
    lastWeek: last.slice(0, 3).map(entry),
    announce: now - start < ANNOUNCE_MS && last.length > 0,
  });
}

async function requireAdmin(request: Request, env: Env): Promise<User> {
  const user = await requireUser(request, env);
  if (!user.admin) throw new HttpError(403, 'admins only');
  return user;
}

/** Runs per page of the admin lists. */
export const ADMIN_PAGE_SIZE = 50;

/**
 * GET /api/admin/runs?status=review|ok|rejected|void|all&page=1&q= -> {runs, total, page, pageSize}:
 * finished runs newest first, a page at a time; `q` keeps players whose name or email contains it.
 */
export async function adminRuns(request: Request, env: Env, url: URL): Promise<Response> {
  await requireAdmin(request, env);
  const status = url.searchParams.get('status') ?? 'review';
  const page = Math.max(1, Math.floor(Number(url.searchParams.get('page')) || 1));
  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  const where = [status === 'all' ? "r.status NOT IN ('open', 'abandoned')" : 'r.status = ?'];
  const binds: unknown[] = status === 'all' ? [] : [status];
  if (q) {
    // LIKE's own wildcards in the search are taken literally.
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push("(LOWER(u.name) LIKE ? ESCAPE '\\' OR LOWER(u.email) LIKE ? ESCAPE '\\')");
    binds.push(like, like);
  }
  const from = `FROM runs r JOIN users u ON u.id = r.user_id WHERE ${where.join(' AND ')}`;
  const [rows, count] = await Promise.all([
    env.DB.prepare(
      `SELECT r.id, u.name, u.email, r.score, r.status, r.verdict, r.hidden, r.flags, r.mobile, r.fast, r.multiplier, r.steps, r.started_at, r.finished_at
       ${from} ORDER BY r.finished_at DESC, r.id LIMIT ? OFFSET ?`,
    )
      .bind(...binds, ADMIN_PAGE_SIZE, (page - 1) * ADMIN_PAGE_SIZE)
      .all(),
    env.DB.prepare(`SELECT COUNT(*) AS n ${from}`)
      .bind(...binds)
      .first<{ n: number }>(),
  ]);
  return json({ runs: rows.results, total: count?.n ?? 0, page, pageSize: ADMIN_PAGE_SIZE });
}

/** POST /api/admin/runs/:id {status: 'ok' | 'void'}, noted in run_reviews. */
export async function adminSetRun(request: Request, env: Env, id: string): Promise<Response> {
  const admin = await requireAdmin(request, env);
  const { status } = await readJson(request);
  if (status !== 'ok' && status !== 'void') throw new HttpError(400, "status must be 'ok' or 'void'");
  // A rejected run has no trusted score, so it cannot be approved. The review row is written
  // first, in the same transaction, so it records the status the run had before.
  const changeable = "id = ? AND status IN ('ok', 'review', 'void') AND score IS NOT NULL";
  const [, updated] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO run_reviews (run_id, admin_id, at, from_status, to_status) SELECT id, ?, ?, status, ? FROM runs WHERE ${changeable}`).bind(
      admin.id,
      Date.now(),
      status,
      id,
    ),
    env.DB.prepare(`UPDATE runs SET status = ? WHERE ${changeable}`).bind(status, id),
  ]);
  if (updated.meta.changes !== 1) throw new HttpError(404, 'no such scored run');
  return json({ ok: true });
}

/** GET /api/admin/users */
export async function adminUsers(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const users = await env.DB.prepare(
    `SELECT u.id, u.name, u.email, u.banned, u.created_at,
            (SELECT MAX(score) FROM runs WHERE user_id = u.id AND status = 'ok' AND hidden = 0) AS best,
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
