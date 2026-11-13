// Ranked runs: POST /api/runs starts one and hands out its obstacle seed, numbered uploads
// (ticks, pauses, resumes) bring in the input log while it is played, and finish replays it
// (worker/verify.ts) to score it. Each upload is answered once: a resend of the last one gets
// the same answer, so the browser can retry anything that didn't get through.

import { MULTIPLIERS } from '../src/config';
import { CAMERA_MODES } from '../src/types';
import { RUN_PROTOCOL, SIM_VERSION, type UploadKind } from '../src/sim/replay';
import { requireUser, type User } from './auth';
import type { Env } from './env';
import { HttpError, json, randomToken, readJson, sha256 } from './http';
import { boardChanged, boardRank, boards, weekStart } from './board';
import { verifyRun, type Beat } from './verify';

/** Open runs older than this are dead (closed tab, lost connection). */
const RUN_TTL_MS = 2 * 60 * 60 * 1000;
const STARTS_PER_MINUTE = 30;
/** Runs a start may leave open for their finish (the browser sends its last two at most). */
const MAX_FINISHING = 2;
/** How long a run left open for its finish has to send it (the browser gives up after a minute). */
const FINISH_WINDOW_MS = 90_000;
/** Uploads to one run within a second, beyond which it is told to slow down (a retry is fine). */
const UPLOADS_PER_SECOND = 20;
/** Uploads one run may make in all (a tick every 10 s for its two hours is 720). */
const MAX_UPLOADS = 5000;

interface RunRow {
  id: string;
  user_id: string;
  status: string;
  protocol: number;
  seed: number;
  mobile: number;
  after_crash: number;
  fast: number;
  multiplier: number;
  /** The SIM_VERSION it started under: a deploy mid-run must not change how it replays. */
  sim_version: number;
  started_at: number;
  steps: number;
  inputs: string;
  beats: string;
  last_seq: number;
  last_upload: string | null;
  receipt: string | null;
  superseded_at: number | null;
}

/** An upload as the browser sent it (src/net/outbox.ts). */
interface Upload {
  seq: number;
  kind: UploadKind;
  steps: number;
  inputs: number[];
}

function playable(user: User): void {
  if (user.banned) throw new HttpError(403, 'banned from the leaderboard');
}

const OUTDATED = 'the game was updated, reload the page';

/**
 * POST /api/runs {mobile, afterCrash, multiplier, simVersion, protocol, after?} -> {id, seed}.
 * `after` names the player's runs whose finish is still on its way, which the start leaves open.
 */
export async function startRun(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const now = Date.now();
  const user = await requireUser(request, env);
  playable(user);
  if (body.simVersion !== SIM_VERSION || body.protocol !== RUN_PROTOCOL) throw new HttpError(409, OUTDATED);
  const multiplier = body.multiplier ?? 1;
  if (typeof multiplier !== 'number' || !MULTIPLIERS.includes(multiplier)) throw new HttpError(400, 'unknown speed multiplier');
  const after = body.after ?? [];
  if (!Array.isArray(after) || after.length > MAX_FINISHING || !after.every((v) => typeof v === 'string')) {
    throw new HttpError(400, `after must list at most ${MAX_FINISHING} run ids`);
  }
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM runs WHERE user_id = ? AND started_at > ?')
    .bind(user.id, now - 60_000)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= STARTS_PER_MINUTE) throw new HttpError(429, 'too many runs, slow down');

  const id = randomToken(12);
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  const beats: Beat[] = [[now, 0]];
  await env.DB.batch([
    // One run in play per player: starting a new one abandons the last, unless its finish is on its
    // way, and then only until its finish window runs out.
    env.DB.prepare(
      "UPDATE runs SET status = 'abandoned' WHERE user_id = ? AND status = 'open' AND (id NOT IN (SELECT value FROM json_each(?)) OR superseded_at <= ?)",
    ).bind(user.id, JSON.stringify(after), now - FINISH_WINDOW_MS),
    env.DB.prepare("UPDATE runs SET superseded_at = ? WHERE user_id = ? AND status = 'open' AND superseded_at IS NULL AND id IN (SELECT value FROM json_each(?))").bind(
      now,
      user.id,
      JSON.stringify(after),
    ),
    env.DB.prepare(
      `INSERT INTO runs (id, user_id, seed, mobile, after_crash, fast, multiplier, sim_version, protocol, started_at, beats, status)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 'open')`,
    ).bind(id, user.id, seed, body.mobile === true ? 1 : 0, body.afterCrash === true ? 1 : 0, multiplier, SIM_VERSION, RUN_PROTOCOL, now, JSON.stringify(beats)),
  ]);
  return json({ id, seed });
}

/** The player's run, open or not. */
async function playersRun(env: Env, user: User, id: string): Promise<RunRow> {
  const run = await env.DB.prepare(
    `SELECT id, user_id, status, protocol, seed, mobile, after_crash, fast, multiplier, sim_version, started_at, steps, inputs, beats, last_seq, last_upload, receipt,
            superseded_at
     FROM runs WHERE id = ?`,
  )
    .bind(id)
    .first<RunRow>();
  if (!run || run.user_id !== user.id) throw new HttpError(404, 'no such open run');
  return run;
}

function parseUpload(body: Record<string, unknown>, finish: boolean): Upload {
  const { seq, kind, steps, inputs } = body;
  // A tab still running the game from before uploads were numbered.
  if (seq === undefined) throw new HttpError(409, OUTDATED);
  if (!Number.isInteger(seq) || (seq as number) < 1) throw new HttpError(400, 'seq must be a positive integer');
  const kinds: readonly unknown[] = finish ? ['finish'] : ['tick', 'pause', 'resume'];
  if (!kinds.includes(kind)) throw new HttpError(400, `kind must be ${kinds.join(' or ')}`);
  if (!Number.isInteger(steps)) throw new HttpError(400, 'steps must be an integer');
  if (!Array.isArray(inputs) || !inputs.every((v) => Number.isInteger(v))) throw new HttpError(400, 'inputs must be integers');
  return { seq: seq as number, kind: kind as UploadKind, steps: steps as number, inputs: inputs as number[] };
}

/**
 * Whether `up` repeats the run's last accepted upload (a resend after its answer was lost), which
 * is answered again rather than applied twice. Anything else must be the next upload in line.
 */
function isRepeat(run: RunRow, up: Upload, hash: string): boolean {
  if (up.seq === run.last_seq) {
    if (hash !== run.last_upload) throw new HttpError(400, 'a different upload with the same seq was already accepted');
    return true;
  }
  if (up.seq !== run.last_seq + 1) throw new HttpError(400, `expected upload ${run.last_seq + 1}, got ${up.seq}`);
  return false;
}

function checkOpen(run: RunRow, now: number): void {
  if (run.status !== 'open') throw new HttpError(404, 'no such open run');
  // Runs started before the protocol changed can't be finished by this server.
  if (run.protocol !== RUN_PROTOCOL) throw new HttpError(409, OUTDATED);
  if (now - run.started_at > RUN_TTL_MS) throw new HttpError(410, 'run expired');
  if (run.superseded_at !== null && now - run.superseded_at > FINISH_WINDOW_MS) throw new HttpError(410, 'run expired');
}

/**
 * Adds an upload's steps and input chunk to the run, with a beat at the server's clock. A paused
 * run takes only its resume, at the step it paused on; steps never go backwards. A run a later one
 * superseded was over by then, so its beats are clocked no later: playing on fails the timing check.
 */
function extend(run: RunRow, up: Upload, now: number): { steps: number; inputs: number[]; beats: Beat[] } {
  const beats = JSON.parse(run.beats) as Beat[];
  if (beats.length > MAX_UPLOADS) throw new HttpError(400, 'too many uploads for one run');
  if (beats.filter(([t]) => t > now - 1000).length >= UPLOADS_PER_SECOND) throw new HttpError(429, 'too many uploads, slow down');
  const paused = beats[beats.length - 1][2] === 'pause';
  if (paused && up.kind !== 'resume') throw new HttpError(400, `${up.kind} while paused`);
  if (!paused && up.kind === 'resume') throw new HttpError(400, 'resume without a pause');
  if (paused && up.steps !== run.steps) throw new HttpError(400, 'steps moved during a pause');
  if (up.steps < run.steps) throw new HttpError(400, 'steps must not go backwards');
  beats.push([run.superseded_at === null ? now : Math.min(now, run.superseded_at), up.steps, up.kind]);
  return { steps: up.steps, inputs: (JSON.parse(run.inputs) as number[]).concat(up.inputs), beats };
}

async function hashOf(body: Record<string, unknown>): Promise<string> {
  return [...(await sha256(JSON.stringify(body)))].map((b) => b.toString(16).padStart(2, '0')).join('');
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
    place: l.place === 2 || l.place === 3 ? l.place : 1,
    fx: Number.isInteger(l.fx) ? (l.fx as number) >>> 0 : 0,
    clip: clipPath(l.clip),
    line: text(l.line, 60),
    move: text(l.move, 20),
  });
}

/**
 * POST /api/runs/:id/beat {seq, kind: tick | pause | resume, steps, inputs} -- a tick every few
 * seconds, and one on each pause and resume. The clock is read once the body is in, before any
 * database work, so neither a slow upload nor a slow query counts as play.
 */
export async function beat(request: Request, env: Env, id: string): Promise<Response> {
  const body = await readJson(request);
  const now = Date.now();
  const user = await requireUser(request, env);
  const up = parseUpload(body, false);
  const run = await playersRun(env, user, id);
  const hash = await hashOf(body);
  if (isRepeat(run, up, hash)) return json({ ok: true });
  checkOpen(run, now);
  const next = extend(run, up, now);
  const updated = await env.DB.prepare(
    "UPDATE runs SET steps = ?, inputs = ?, beats = ?, last_seq = ?, last_upload = ? WHERE id = ? AND status = 'open' AND last_seq = ?",
  )
    .bind(next.steps, JSON.stringify(next.inputs), JSON.stringify(next.beats), up.seq, hash, id, run.last_seq)
    .run();
  // Another upload got in first (a resend racing its original): sending again sorts it out.
  if (updated.meta.changes !== 1) throw new HttpError(409, 'run changed, send again');
  return json({ ok: true });
}

/** POST /api/runs/:id/finish {seq, kind: finish, steps, inputs, look?} -> {status, score, rank, previousBest} */
export async function finishRun(request: Request, env: Env, id: string): Promise<Response> {
  const body = await readJson(request);
  const now = Date.now();
  const user = await requireUser(request, env);
  playable(user);
  const up = parseUpload(body, true);
  const run = await playersRun(env, user, id);
  const hash = await hashOf(body);
  if (isRepeat(run, up, hash)) {
    if (run.receipt === null) throw new HttpError(409, 'still checking the run, send again');
    return json(JSON.parse(run.receipt));
  }
  checkOpen(run, now);
  const next = extend(run, up, now);
  const previousBest = await bestScore(env, user.id);
  const verdict = verifyRun({
    seed: run.seed,
    mobile: run.mobile === 1,
    afterCrash: run.after_crash === 1,
    fast: run.fast === 1,
    multiplier: run.multiplier,
    simVersion: run.sim_version,
    steps: next.steps,
    inputs: next.inputs,
    beats: next.beats,
  });
  const score = verdict.status === 'rejected' ? null : verdict.score;
  const flags = verdict.status === 'ok' ? null : verdict.flags.join('; ');
  // The game cheers a ranked run that beats the player's best (or is their first); its replay does too.
  const cheered = verdict.status === 'ok' && (previousBest === null || (score ?? 0) > previousBest);
  const [updated] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE runs SET steps = ?, inputs = ?, beats = ?, finished_at = ?, score = ?, status = ?, verdict = ?, flags = ?, checks = ?, look = ?, cheered = ?,
         last_seq = ?, last_upload = ?
       WHERE id = ? AND status = 'open' AND last_seq = ?`,
    ).bind(
      next.steps,
      JSON.stringify(next.inputs),
      JSON.stringify(next.beats),
      now,
      score,
      verdict.status,
      verdict.status,
      flags,
      JSON.stringify(verdict.checks),
      cleanLook(body.look, next.steps),
      cheered ? 1 : 0,
      up.seq,
      hash,
      id,
      run.last_seq,
    ),
    // In the same transaction, so no board can be built from the run without the change showing:
    // the boards change if the run, now ok, is the player's best this week (which a new all-time
    // best also is). Ties go to whoever finished first, as on the board.
    env.DB.prepare(
      `UPDATE board SET version = version + 1 WHERE id = 1
         AND EXISTS (SELECT 1 FROM runs WHERE id = ? AND status = 'ok' AND hidden = 0 AND last_upload = ?)
         AND NOT EXISTS (SELECT 1 FROM runs WHERE user_id = ? AND id != ? AND status = 'ok' AND hidden = 0 AND finished_at >= ?
                           AND (score > ? OR (score = ? AND finished_at <= ?)))`,
    ).bind(id, hash, user.id, id, weekStart(now), score, score, now),
  ]);
  if (updated.meta.changes !== 1) throw new HttpError(409, 'run changed, send again');
  if (verdict.status !== 'ok') console.log(`run ${id} by ${user.email}: ${verdict.status} (${flags})`);
  const receipt = {
    status: verdict.status,
    score,
    previousBest,
    rank: verdict.status === 'ok' ? boardRank(await boards(env), user.id) : null,
  };
  // Kept for a resend of this finish whose answer was lost.
  await env.DB.prepare('UPDATE runs SET receipt = ? WHERE id = ?').bind(JSON.stringify(receipt), id).run();
  return json(receipt);
}

/**
 * POST /api/runs/delete: hides every run the player has made, so they leave the board and start
 * their stats afresh; the account stays. Admins still see the runs (and their reviews go on), so a
 * flagged run can't be deleted out of the way. Banned players can't.
 */
export async function deleteRuns(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  playable(user);
  await env.DB.batch([env.DB.prepare('UPDATE runs SET hidden = 1 WHERE user_id = ?').bind(user.id), boardChanged(env)]);
  return json({ ok: true });
}

/** The player's best verified run, if any (one step down the runs_best index). */
async function bestScore(env: Env, userId: string): Promise<number | null> {
  const row = await env.DB.prepare("SELECT score FROM runs WHERE user_id = ? AND status = 'ok' AND hidden = 0 ORDER BY score DESC LIMIT 1")
    .bind(userId)
    .first<{ score: number }>();
  return row?.score ?? null;
}

/**
 * GET /api/runs/mine -> {runs: [{id, score, status, mobile, fast, multiplier, steps, finishedAt}], weekStart}:
 * the player's own finished runs, newest first: the last 10,000, since the page works its stats out
 * from them (it shows them a page at a time). Why a run was flagged stays admin-only.
 */
export async function myRuns(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const rows = await env.DB.prepare(
    `SELECT id, score, status, mobile, fast, multiplier, steps, finished_at FROM runs
     WHERE user_id = ? AND status NOT IN ('open', 'abandoned') AND hidden = 0 ORDER BY finished_at DESC LIMIT 10000`,
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

/** GET /api/runs/:id -- a finished run, for ?replay=. Runs still under review: admins and their player. Deleted runs: admins only. */
export async function getRun(request: Request, env: Env, id: string): Promise<Response> {
  const user = await requireUser(request, env);
  const run = await env.DB.prepare(
    `SELECT r.id, r.seed, r.mobile, r.after_crash, r.fast, r.multiplier, r.sim_version, r.steps, r.inputs, r.score, r.status, r.hidden, r.user_id, r.look, r.cheered, u.name
     FROM runs r JOIN users u ON u.id = r.user_id WHERE r.id = ?`,
  )
    .bind(id)
    .first<{ id: string; seed: number; mobile: number; after_crash: number; fast: number; multiplier: number; sim_version: number; steps: number; inputs: string; score: number | null; status: string; hidden: number; user_id: string; look: string | null; cheered: number; name: string }>();
  const visible = run && run.status !== 'open' && run.status !== 'abandoned' && (user.admin || (run.hidden === 0 && (run.status === 'ok' || run.user_id === user.id)));
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
