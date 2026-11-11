import { afterEach, describe, expect, test, setSystemTime } from 'bun:test';
import { SIM } from '../src/config';
import { autopilot } from '../src/sim/autopilot';
import { createInputRecorder, createRunSim, replayRun, SIM_VERSION, type RunSpec } from '../src/sim/replay';
import type { InputFrame } from '../src/types';
import { createTestWorker, type TestWorker } from './worker-api';

const NONE: InputFrame = { jumpPressed: false, jumpHeld: false, duckHeld: false, restartPressed: false };
const PRESS: InputFrame = { ...NONE, jumpPressed: true, jumpHeld: true };
const T0 = 1_800_000_000_000;

/** A run under `spec`'s rules: the autopilot plays for `steps` steps, then it runs into the next obstacle. */
function playRun(spec: RunSpec, steps: number): { inputs: number[]; steps: number; score: number } {
  const sim = createRunSim(spec);
  const recorder = createInputRecorder();
  for (let step = 0; step < 100_000; step++) {
    const input = step === 0 ? PRESS : step < steps ? autopilot(sim.getSnapshot()) : NONE;
    recorder.record(input);
    const crash = sim.step(input).find((e) => e.type === 'crash');
    if (crash?.type === 'crash') return { inputs: recorder.take(), steps: recorder.steps, score: crash.score };
  }
  throw new Error('never crashed');
}

afterEach(() => setSystemTime());

let now = T0;
function tick(ms: number): void {
  now += ms;
  setSystemTime(new Date(now));
}

/**
 * Plays one ranked run through the API: it starts now, runs into the first obstacle (seed 7), and
 * finishes `lateMs` after real time would have it (enough of that sends it for review).
 */
async function ranked(w: TestWorker, token: string, lateMs = 100): Promise<{ id: string; score: number }> {
  const start = await w.call(token, 'POST', '/api/runs', { mobile: false, afterCrash: false, multiplier: 1, simVersion: SIM_VERSION });
  expect(start.status).toBe(200);
  const id = start.body.id as string;
  w.db.query('UPDATE runs SET seed = 7 WHERE id = ?').run(id);
  const run = playRun({ seed: 7, mobile: false, afterCrash: false }, 0);
  tick(run.steps * SIM.STEP_MS + lateMs);
  const finish = await w.call(token, 'POST', `/api/runs/${id}/finish`, { steps: run.steps, inputs: run.inputs });
  expect(finish.status).toBe(200);
  tick(60_000);
  return { id, score: run.score };
}

const status = (w: TestWorker, id: string) => w.db.query('SELECT status, verdict, flags, checks, hidden FROM runs WHERE id = ?').get(id) as Record<string, unknown>;

describe('finishing a run', () => {
  test('a run started before a deploy replays with the rules it was played under', async () => {
    setSystemTime(new Date(T0));
    const w = createTestWorker();
    const token = await w.player('ana');
    const start = await w.call(token, 'POST', '/api/runs', { mobile: false, afterCrash: false, multiplier: 1, simVersion: SIM_VERSION });
    expect(start.status).toBe(200);
    const { id } = start.body as { id: string };
    // The deploy happens mid-run: the row says it started under the previous version. (A fixed
    // seed keeps the run short of the bot checks.)
    const old = SIM_VERSION - 1;
    const seed = 7;
    w.db.query('UPDATE runs SET sim_version = ?, seed = ? WHERE id = ?').run(old, seed, id);
    const spec = { seed, mobile: false, afterCrash: false, simVersion: old };
    const run = playRun(spec, 900);
    // Sanity: the same inputs don't make the same run under today's rules.
    expect(replayRun({ ...spec, simVersion: SIM_VERSION }, run.inputs, run.steps)).not.toEqual({ ok: true, score: run.score });

    setSystemTime(new Date(T0 + run.steps * SIM.STEP_MS + 100));
    const finish = await w.call(token, 'POST', `/api/runs/${id}/finish`, { steps: run.steps, inputs: run.inputs });
    expect(finish.status).toBe(200);
    expect(finish.body.status).toBe('ok');
    expect(finish.body.score).toBe(run.score);
  });
});

describe('evidence', () => {
  test('deleting stats takes runs off the board and the player\'s list, but admins keep them', async () => {
    tick(0);
    const w = createTestWorker();
    const ana = await w.player('ana');
    const admin = await w.player('root', { admin: true });
    const good = await ranked(w, ana);
    const flagged = await ranked(w, ana, 10_000);
    expect(status(w, good.id).status).toBe('ok');
    expect(status(w, flagged.id).status).toBe('review');
    expect((await w.call(ana, 'GET', '/api/leaderboard')).body.entries).toHaveLength(1);

    expect((await w.call(ana, 'POST', '/api/runs/delete', {})).status).toBe(200);
    expect((await w.call(ana, 'GET', '/api/leaderboard')).body.entries).toEqual([]);
    expect((await w.call(ana, 'GET', '/api/runs/mine')).body.runs).toEqual([]);
    expect((await w.call(ana, 'GET', `/api/runs/${good.id}`)).status).toBe(404);

    const review = (await w.call(admin, 'GET', '/api/admin/runs?status=review')).body.runs as { id: string; hidden: number }[];
    expect(review.map((r) => [r.id, r.hidden])).toEqual([[flagged.id, 1]]);
    expect((await w.call(admin, 'GET', '/api/admin/runs?status=all')).body.runs).toHaveLength(2);
    expect((await w.call(admin, 'GET', `/api/runs/${flagged.id}`)).status).toBe(200);
  });

  test('deleting stats does not reset the start rate limit', async () => {
    tick(0);
    const w = createTestWorker();
    const ana = await w.player('ana');
    const start = () => w.call(ana, 'POST', '/api/runs', { mobile: false, afterCrash: false, multiplier: 1, simVersion: SIM_VERSION });
    for (let i = 0; i < 30; i++) expect((await start()).status).toBe(200);
    expect((await start()).status).toBe(429);
    await w.call(ana, 'POST', '/api/runs/delete', {});
    expect((await start()).status).toBe(429);
  });

  test('a finished run keeps what the checks said, and the numbers behind it', async () => {
    tick(0);
    const w = createTestWorker();
    const ana = await w.player('ana');
    const { id } = await ranked(w, ana, 10_000);
    const row = status(w, id);
    expect(row).toMatchObject({ status: 'review', verdict: 'review' });
    const checks = JSON.parse(row.checks as string);
    expect(checks.lagMs).toBeGreaterThan(9_900);
    expect(checks).toMatchObject({ pauses: 0, jumps: 0, autopilotJumps: 0 });
  });

  test('admin decisions are recorded, and the checks\' verdict stays', async () => {
    tick(0);
    const w = createTestWorker();
    const ana = await w.player('ana');
    const admin = await w.player('root', { admin: true });
    const { id } = await ranked(w, ana, 10_000);
    expect((await w.call(admin, 'POST', `/api/admin/runs/${id}`, { status: 'ok' })).status).toBe(200);
    tick(1000);
    expect((await w.call(admin, 'POST', `/api/admin/runs/${id}`, { status: 'void' })).status).toBe(200);
    expect(status(w, id)).toMatchObject({ status: 'void', verdict: 'review' });
    const reviews = w.db.query('SELECT admin_id, from_status, to_status FROM run_reviews WHERE run_id = ? ORDER BY at').all(id);
    expect(reviews).toEqual([
      { admin_id: 'user-root', from_status: 'review', to_status: 'ok' },
      { admin_id: 'user-root', from_status: 'ok', to_status: 'void' },
    ]);

    // A run with no trusted score can't be approved, and nothing is recorded.
    w.db.query("UPDATE runs SET status = 'rejected', score = NULL WHERE id = ?").run(id);
    expect((await w.call(admin, 'POST', `/api/admin/runs/${id}`, { status: 'ok' })).status).toBe(404);
    expect(w.db.query('SELECT COUNT(*) AS n FROM run_reviews').get()).toEqual({ n: 2 });
    // Only admins.
    expect((await w.call(ana, 'POST', `/api/admin/runs/${id}`, { status: 'ok' })).status).toBe(403);
  });
});
