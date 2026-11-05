// Ranked runs: POST /api/runs starts one and hands out its obstacle seed, beats upload the
// input log while it is played, and finish replays it (worker/verify.ts) to score it.

import { MULTIPLIERS } from '../src/config';
import { CAMERA_MODES } from '../src/types';
import { SIM_VERSION } from '../src/sim/replay';
import { requireUser, type User } from './auth';
import type { Env } from './env';
import { HttpError, json, randomToken, readJson } from './http';
import { boardRank, weekStart } from './board';
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
  fast: number;
  multiplier: number;
  started_at: number;
  steps: number;
  inputs: string;
  beats: string;
}

function playable(user: User): void {
  if (user.banned) throw new HttpError(403, 'banned from the leaderboard');
}

/** POST /api/runs {mobile, afterCrash, multiplier, simVersion} -> {id, seed} */
export async function startRun(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  playable(user);
  const body = await readJson(request);
  if (body.simVersion !== SIM_VERSION) throw new HttpError(409, 'the game was updated, reload the page');
  const multiplier = body.multiplier ?? 1;
  if (typeof multiplier !== 'number' || !MULTIPLIERS.includes(multiplier)) throw new HttpError(400, 'unknown speed multiplier');
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
      `INSERT INTO runs (id, user_id, seed, mobile, after_crash, fast, multiplier, sim_version, started_at, beats, status)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'open')`,
    ).bind(id, user.id, seed, body.mobile === true ? 1 : 0, body.afterCrash === true ? 1 : 0, multiplier, SIM_VERSION, now, JSON.stringify(beats)),
  ]);
  return json({ id, seed });
}

async function openRun(env: Env, user: User, id: string): Promise<OpenRun> {
  const run = await env.DB.prepare(
    "SELECT id, user_id, seed, mobile, after_crash, fast, multiplier, started_at, steps, inputs, beats FROM runs WHERE id = ? AND status = 'open'",
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

const MAX_LOOK_CHANGES = 2000;

/** A crash clip is one of the game's own files: its path (a full URL is cut down to one), or '' for none. */
function clipPath(v: unknown): string {
  if (typeof v !== 'string' || v.length > 300) return '';
  let path = v;
  try {
    if (!v.startsWith('/')) path = new URL(v).pathname;
  } catch {
    return '';
  }
  return /^\/[\w./-]{1,200}$/.test(path) ? path : '';
}

/** One LookState's fields (src/types.ts) that are present and well-formed; the rest are dropped. */
function cleanState(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object') return {};
  const l = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (l.mode === 'regular' || l.mode === 'funny') out.mode = l.mode;
  for (const key of ['farts', 'nsfw', 'dayNight', 'dark'] as const) if (typeof l[key] === 'boolean') out[key] = l[key];
  const c = l.camera as Record<string, unknown> | null;
  if (c && typeof c === 'object' && (CAMERA_MODES as readonly unknown[]).includes(c.mode) && typeof c.custom === 'boolean' && Number.isFinite(c.yaw) && Number.isFinite(c.pitch)) {
    out.camera = { mode: c.mode, custom: c.custom, yaw: c.yaw, pitch: c.pitch };
  }
  return out;
}

/**
 * The run's RunLook (src/types.ts), cleaned: only known fields, of the right types and sizes.
 * It is cosmetic (the replay shows it), so a bad one is dropped rather than failing the run.
 */
function cleanLook(look: unknown, steps: number): string | null {
  if (!look || typeof look !== 'object') return null;
  const l = look as Record<string, unknown>;
  const start = { mode: 'regular', farts: false, nsfw: false, dayNight: true, dark: false, camera: { mode: CAMERA_MODES[0], custom: false, yaw: 0, pitch: 0 }, ...cleanState(l) };
  const text = (v: unknown, max: number): string => (typeof v === 'string' && v.length <= max ? v : '');
  const changes = (Array.isArray(l.changes) ? l.changes : [])
    .slice(0, MAX_LOOK_CHANGES)
    .filter((c): c is [number, unknown] => Array.isArray(c) && Number.isInteger(c[0]) && c[0] >= 0 && c[0] <= steps)
    .map(([step, change]) => [step, cleanState(change)])
    .filter(([, change]) => Object.keys(change as object).length > 0);
  return JSON.stringify({
    ...start,
    changes,
    hi: Number.isInteger(l.hi) && (l.hi as number) >= 0 ? l.hi : 0,
    crown: l.crown === true,
    fx: Number.isInteger(l.fx) ? (l.fx as number) >>> 0 : 0,
    clip: clipPath(l.clip),
    line: text(l.line, 60),
    move: text(l.move, 20),
  });
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

/** POST /api/runs/:id/finish {steps, inputs, look?} -> {status, score, rank, best, previousBest} */
export async function finishRun(request: Request, env: Env, id: string): Promise<Response> {
  const user = await requireUser(request, env);
  playable(user);
  const run = await openRun(env, user, id);
  const now = Date.now();
  const body = await readJson(request);
  const next = extend(run, body, now);
  const previousBest = await bestScore(env, user.id);
  const verdict = verifyRun({
    seed: run.seed,
    mobile: run.mobile === 1,
    afterCrash: run.after_crash === 1,
    fast: run.fast === 1,
    multiplier: run.multiplier,
    steps: next.steps,
    inputs: next.inputs,
    beats: next.beats,
  });
  const score = verdict.status === 'rejected' ? null : verdict.score;
  const flags = verdict.status === 'ok' ? null : verdict.flags.join('; ');
  // The game cheers a ranked run that beats the player's best (or is their first); its replay does too.
  const cheered = verdict.status === 'ok' && (previousBest === null || (score ?? 0) > previousBest);
  const updated = await env.DB.prepare(
    `UPDATE runs SET steps = ?, inputs = ?, beats = ?, finished_at = ?, score = ?, status = ?, flags = ?, look = ?, cheered = ?
     WHERE id = ? AND status = 'open' AND steps = ?`,
  )
    .bind(next.steps, JSON.stringify(next.inputs), JSON.stringify(next.beats), now, score, verdict.status, flags, cleanLook(body.look, next.steps), cheered ? 1 : 0, id, run.steps)
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

/**
 * POST /api/runs/delete: every run the player has made, so they leave the board; the account
 * stays. Banned players can't, so their flagged runs stay for review.
 */
export async function deleteRuns(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  playable(user);
  await env.DB.prepare('DELETE FROM runs WHERE user_id = ?').bind(user.id).run();
  return json({ ok: true });
}

async function bestScore(env: Env, userId: string): Promise<number | null> {
  const row = await env.DB.prepare("SELECT MAX(score) AS best FROM runs WHERE user_id = ? AND status = 'ok'").bind(userId).first<{ best: number | null }>();
  return row?.best ?? null;
}

/**
 * GET /api/runs/mine -> {runs: [{id, score, status, mobile, fast, multiplier, steps, finishedAt}], weekStart}:
 * the player's own finished runs, newest first (the last 500). Why a run was flagged stays admin-only.
 */
export async function myRuns(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const rows = await env.DB.prepare(
    `SELECT id, score, status, mobile, fast, multiplier, steps, finished_at FROM runs
     WHERE user_id = ? AND status NOT IN ('open', 'abandoned') ORDER BY finished_at DESC LIMIT 500`,
  )
    .bind(user.id)
    .all<{ id: string; score: number | null; status: string; mobile: number; fast: number; multiplier: number; steps: number; finished_at: number }>();
  return json({
    runs: rows.results.map((r) => ({
      id: r.id,
      score: r.score,
      status: r.status,
      mobile: r.mobile === 1,
      fast: r.fast === 1,
      multiplier: r.multiplier,
      steps: r.steps,
      finishedAt: r.finished_at,
    })),
    weekStart: weekStart(Date.now()),
  });
}

/** GET /api/runs/:id -- a finished run, for ?replay=. Runs still under review: admins only. */
export async function getRun(request: Request, env: Env, id: string): Promise<Response> {
  const user = await requireUser(request, env);
  const run = await env.DB.prepare(
    `SELECT r.id, r.seed, r.mobile, r.after_crash, r.fast, r.multiplier, r.sim_version, r.steps, r.inputs, r.score, r.status, r.user_id, r.look, r.cheered, u.name
     FROM runs r JOIN users u ON u.id = r.user_id WHERE r.id = ?`,
  )
    .bind(id)
    .first<{ id: string; seed: number; mobile: number; after_crash: number; fast: number; multiplier: number; sim_version: number; steps: number; inputs: string; score: number | null; status: string; user_id: string; look: string | null; cheered: number; name: string }>();
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
    fast: run.fast === 1,
    multiplier: run.multiplier,
    simVersion: run.sim_version,
    steps: run.steps,
    inputs: JSON.parse(run.inputs),
    look: run.look === null ? null : JSON.parse(run.look),
    cheered: run.cheered === 1,
  });
}
