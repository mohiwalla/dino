// Ranked runs: POST /api/runs starts one and hands out its obstacle seed, beats upload the
// input log while it is played, and finish replays it (worker/verify.ts) to score it.

import { SIM_VERSION } from '../src/sim/replay';
import { requireUser, type User } from './auth';
import type { Env } from './env';
import { HttpError, json, randomToken, readJson } from './http';
import { boardRank } from './board';
import { verifyRun, type Beat } from './verify';

/** Open runs older than this are dead (closed tab, lost connection). */
const RUN_TTL_MS = 2 * 60 * 60 * 1000;
const STARTS_PER_MINUTE = 30;
/** Beats closer together than this are refused. */
const MIN_BEAT_GAP_MS = 150;

interface OpenRun {
  id: string;
  user_id: string;
  seed: number;
  mobile: number;
  after_crash: number;
  started_at: number;
  steps: number;
  inputs: string;
  beats: string;
}

function playable(user: User): void {
  if (user.banned) throw new HttpError(403, 'banned from the leaderboard');
}

/** POST /api/runs {mobile, afterCrash, simVersion} -> {id, seed} */
export async function startRun(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  playable(user);
  const body = await readJson(request);
  if (body.simVersion !== SIM_VERSION) throw new HttpError(409, 'the game was updated, reload the page');
  const now = Date.now();
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM runs WHERE user_id = ? AND started_at > ?')
    .bind(user.id, now - 60_000)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= STARTS_PER_MINUTE) throw new HttpError(429, 'too many runs, slow down');

  const id = randomToken(12);
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  const beats: Beat[] = [[now, 0]];
  await env.DB.batch([
    // One open run per player: starting a new one abandons the last.
    env.DB.prepare("UPDATE runs SET status = 'abandoned' WHERE user_id = ? AND status = 'open'").bind(user.id),
    env.DB.prepare(
      `INSERT INTO runs (id, user_id, seed, mobile, after_crash, sim_version, started_at, beats, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
    ).bind(id, user.id, seed, body.mobile === true ? 1 : 0, body.afterCrash === true ? 1 : 0, SIM_VERSION, now, JSON.stringify(beats)),
  ]);
  return json({ id, seed });
}

async function openRun(env: Env, user: User, id: string): Promise<OpenRun> {
  const run = await env.DB.prepare(
    "SELECT id, user_id, seed, mobile, after_crash, started_at, steps, inputs, beats FROM runs WHERE id = ? AND status = 'open'",
  )
    .bind(id)
    .first<OpenRun>();
  if (!run || run.user_id !== user.id) throw new HttpError(404, 'no such open run');
  if (Date.now() - run.started_at > RUN_TTL_MS) throw new HttpError(410, 'run expired');
  return run;
}

/** Adds an upload's steps and input chunk to the run, with a beat at the server's clock. */
function extend(run: OpenRun, body: Record<string, unknown>, now: number): { steps: number; inputs: number[]; beats: Beat[] } {
  const steps = body.steps;
  const chunk = body.inputs;
  if (!Number.isInteger(steps) || (steps as number) < run.steps) throw new HttpError(400, 'steps must not go backwards');
  if (!Array.isArray(chunk) || !chunk.every((v) => Number.isInteger(v))) throw new HttpError(400, 'inputs must be integers');
  const beats = JSON.parse(run.beats) as Beat[];
  if (now - beats[beats.length - 1][0] < MIN_BEAT_GAP_MS) throw new HttpError(429, 'too many beats');
  beats.push([now, steps as number]);
  return { steps: steps as number, inputs: (JSON.parse(run.inputs) as number[]).concat(chunk as number[]), beats };
}

/** POST /api/runs/:id/beat {steps, inputs} -- every few seconds, and on pause and resume. */
export async function beat(request: Request, env: Env, id: string): Promise<Response> {
  const user = await requireUser(request, env);
  const run = await openRun(env, user, id);
  const next = extend(run, await readJson(request), Date.now());
  const updated = await env.DB.prepare("UPDATE runs SET steps = ?, inputs = ?, beats = ? WHERE id = ? AND status = 'open' AND steps = ?")
    .bind(next.steps, JSON.stringify(next.inputs), JSON.stringify(next.beats), id, run.steps)
    .run();
  if (updated.meta.changes !== 1) throw new HttpError(409, 'run changed, beat dropped');
  return json({ ok: true });
}

/** POST /api/runs/:id/finish {steps, inputs} -> {status, score, rank, best, previousBest} */
export async function finishRun(request: Request, env: Env, id: string): Promise<Response> {
  const user = await requireUser(request, env);
  playable(user);
  const run = await openRun(env, user, id);
  const now = Date.now();
  const next = extend(run, await readJson(request), now);
  const previousBest = await bestScore(env, user.id);
  const verdict = verifyRun({
    seed: run.seed,
    mobile: run.mobile === 1,
    afterCrash: run.after_crash === 1,
    steps: next.steps,
    inputs: next.inputs,
    beats: next.beats,
  });
  const score = verdict.status === 'rejected' ? null : verdict.score;
  const flags = verdict.status === 'ok' ? null : verdict.flags.join('; ');
  const updated = await env.DB.prepare(
    `UPDATE runs SET steps = ?, inputs = ?, beats = ?, finished_at = ?, score = ?, status = ?, flags = ?
     WHERE id = ? AND status = 'open' AND steps = ?`,
  )
    .bind(next.steps, JSON.stringify(next.inputs), JSON.stringify(next.beats), now, score, verdict.status, flags, id, run.steps)
    .run();
  if (updated.meta.changes !== 1) throw new HttpError(409, 'run already finished');
  if (verdict.status !== 'ok') console.log(`run ${id} by ${user.email}: ${verdict.status} (${flags})`);
  return json({
    status: verdict.status,
    score,
    previousBest,
    rank: verdict.status === 'ok' ? await boardRank(env, user.id) : null,
  });
}

async function bestScore(env: Env, userId: string): Promise<number | null> {
  const row = await env.DB.prepare("SELECT MAX(score) AS best FROM runs WHERE user_id = ? AND status = 'ok'").bind(userId).first<{ best: number | null }>();
  return row?.best ?? null;
}

/** GET /api/runs/:id -- a finished run, for ?replay=. Runs still under review: admins only. */
export async function getRun(request: Request, env: Env, id: string): Promise<Response> {
  const user = await requireUser(request, env);
  const run = await env.DB.prepare(
    `SELECT r.id, r.seed, r.mobile, r.after_crash, r.steps, r.inputs, r.score, r.status, r.user_id, u.name
     FROM runs r JOIN users u ON u.id = r.user_id WHERE r.id = ?`,
  )
    .bind(id)
    .first<{ id: string; seed: number; mobile: number; after_crash: number; steps: number; inputs: string; score: number | null; status: string; user_id: string; name: string }>();
  const visible = run && run.status !== 'open' && run.status !== 'abandoned' && (run.status === 'ok' || user.admin || run.user_id === user.id);
  if (!run || !visible) throw new HttpError(404, 'no such run');
  return json({
    id: run.id,
    name: run.name,
    score: run.score,
    status: run.status,
    seed: run.seed,
    mobile: run.mobile === 1,
    afterCrash: run.after_crash === 1,
    steps: run.steps,
    inputs: JSON.parse(run.inputs),
  });
}
