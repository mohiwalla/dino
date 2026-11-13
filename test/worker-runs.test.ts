import { afterEach, describe, expect, test, setSystemTime } from 'bun:test';
import { SIM } from '../src/config';
import { autopilot } from '../src/sim/autopilot';
import { createInputRecorder, createRunSim, replayRun, RUN_PROTOCOL, SIM_VERSION, type RunSpec } from '../src/sim/replay';
import type { InputFrame } from '../src/types';
import { createTestWorker, type TestWorker } from './worker-api';

const NONE: InputFrame = { jumpPressed: false, jumpHeld: false, duckHeld: false, restartPressed: false };
const PRESS: InputFrame = { ...NONE, jumpPressed: true, jumpHeld: true };
const T0 = 1_800_000_000_000;
const START = { mobile: false, afterCrash: false, multiplier: 1, simVersion: SIM_VERSION, protocol: RUN_PROTOCOL };

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
  const start = await w.call(token, 'POST', '/api/runs', START);
  expect(start.status).toBe(200);
  const id = start.body.id as string;
  w.db.query('UPDATE runs SET seed = 7 WHERE id = ?').run(id);
  const run = playRun({ seed: 7, mobile: false, afterCrash: false }, 0);
  tick(run.steps * SIM.STEP_MS + lateMs);
  const finish = await w.call(token, 'POST', `/api/runs/${id}/finish`, { seq: 1, kind: 'finish', steps: run.steps, inputs: run.inputs });
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
    const start = await w.call(token, 'POST', '/api/runs', START);
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
    const finish = await w.call(token, 'POST', `/api/runs/${id}/finish`, { seq: 1, kind: 'finish', steps: run.steps, inputs: run.inputs });
    expect(finish.status).toBe(200);
    expect(finish.body.status).toBe('ok');
    expect(finish.body.score).toBe(run.score);
  });
  test('a start leaves the runs it names open for their finish, and abandons the rest', async () => {
    setSystemTime(new Date(T0));
    const w = createTestWorker();
    const token = await w.player('ana');
    const first = await w.call(token, 'POST', '/api/runs', START);
    const id = first.body.id as string;
    w.db.query('UPDATE runs SET seed = 7 WHERE id = ?').run(id);
    const run = playRun({ seed: 7, mobile: false, afterCrash: false }, 0);
    tick(run.steps * SIM.STEP_MS + 100);
    // The player restarts while the first run's finish is still on its way.
    const next = await w.call(token, 'POST', '/api/runs', { ...START, afterCrash: true, after: [id] });
    expect(next.status).toBe(200);
    expect(status(w, id).status).toBe('open');
    const finish = await w.call(token, 'POST', `/api/runs/${id}/finish`, { seq: 1, kind: 'finish', steps: run.steps, inputs: run.inputs });
    expect(finish.body.status).toBe('ok');
    // A start that doesn't name the run in play abandons it, as before.
    const third = await w.call(token, 'POST', '/api/runs', { ...START, afterCrash: true });
    expect(third.status).toBe(200);
    expect(status(w, next.body.id as string).status).toBe('abandoned');
    const tooMany = await w.call(token, 'POST', '/api/runs', { ...START, after: ['a', 'b', 'c'] });
    expect(tooMany.status).toBe(400);
  });

  test('a run left open for its finish can\'t be played on, and closes when its window runs out', async () => {
    setSystemTime(new Date(T0));
    const w = createTestWorker();
    const token = await w.player('ana');
    // Held back (say, paused) while another run starts, then played after all.
    const held = (await w.call(token, 'POST', '/api/runs', START)).body.id as string;
    w.db.query('UPDATE runs SET seed = 7 WHERE id = ?').run(held);
    await w.call(token, 'POST', '/api/runs', { ...START, after: [held] });
    const run = playRun({ seed: 7, mobile: false, afterCrash: false }, 900);
    tick(run.steps * SIM.STEP_MS + 100);
    const late = await w.call(token, 'POST', `/api/runs/${held}/finish`, { seq: 1, kind: 'finish', steps: run.steps, inputs: run.inputs });
    expect(late.body.status).toBe('rejected');
    expect(status(w, held).flags).toMatch(/^played \d+s in 0s of real time/);

    // Naming a run again doesn't renew its window: past it the finish is refused and the next start abandons it.
    const kept = (await w.call(token, 'POST', '/api/runs', START)).body.id as string;
    await w.call(token, 'POST', '/api/runs', { ...START, after: [kept] });
    tick(60_000);
    await w.call(token, 'POST', '/api/runs', { ...START, after: [kept] });
    expect(status(w, kept).status).toBe('open');
    tick(31_000);
    const expired = await w.call(token, 'POST', `/api/runs/${kept}/finish`, { seq: 1, kind: 'finish', steps: 0, inputs: [] });
    expect(expired.status).toBe(410);
    await w.call(token, 'POST', '/api/runs', { ...START, after: [kept] });
    expect(status(w, kept).status).toBe('abandoned');
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
    const start = () => w.call(ana, 'POST', '/api/runs', START);
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

describe('the board', () => {
  const version = (w: TestWorker) => (w.db.query('SELECT version FROM board').get() as { version: number }).version;
  type Entry = { name: string; score: number };
  const scores = async (w: TestWorker, token: string) => {
    const res = await w.call(token, 'GET', '/api/leaderboard');
    expect(res.status).toBe(200);
    const b = res.body as { entries: Entry[]; week: { entries: Entry[] }; lastWeek: Entry[] };
    const names = (list: Entry[]) => list.map((e) => `${e.name} ${e.score}`);
    return { all: names(b.entries), week: names(b.week.entries), lastWeek: names(b.lastWeek) };
  };

  test('is built once, and rebuilt when something changes what it shows', async () => {
    tick(0);
    const w = createTestWorker();
    const ana = await w.player('ana');
    const bob = await w.player('bob');
    const admin = await w.player('root', { admin: true });
    const first = await ranked(w, ana);
    expect((await scores(w, ana)).all).toEqual([`ana ${first.score}`]);

    // Served from the cache: a change behind the Worker's back doesn't show.
    w.db.query('UPDATE runs SET score = 99999 WHERE id = ?').run(first.id);
    expect((await scores(w, ana)).all).toEqual([`ana ${first.score}`]);
    w.db.query('UPDATE runs SET score = ? WHERE id = ?').run(first.score, first.id);

    // A run that doesn't beat the player's best this week changes nothing.
    const v = version(w);
    await ranked(w, ana);
    expect(version(w)).toBe(v);
    // A player's first run does, and their rank comes from the rebuilt board.
    const bobs = await ranked(w, bob, 50);
    expect(version(w)).toBe(v + 1);
    expect((await scores(w, bob)).all).toHaveLength(2);
    expect(JSON.parse((w.db.query('SELECT receipt FROM runs WHERE id = ?').get(bobs.id) as { receipt: string }).receipt).rank).not.toBeNull();

    // A ban, and an admin voiding a run.
    expect((await w.call(admin, 'POST', '/api/admin/users/user-bob', { banned: true })).status).toBe(200);
    expect((await scores(w, ana)).all).toEqual([`ana ${first.score}`]);
    await w.call(admin, 'POST', '/api/admin/users/user-bob', { banned: false });
    expect((await scores(w, ana)).all).toHaveLength(2);
    w.db.query("UPDATE runs SET status = 'void' WHERE user_id = 'user-ana' AND id != ?").run(first.id);
    expect((await w.call(admin, 'POST', `/api/admin/runs/${first.id}`, { status: 'void' })).status).toBe(200);
    expect((await scores(w, ana)).all).toEqual([`bob ${bobs.score}`]);
    // With her best voided, a run no better than it is her best again, and shows.
    const again = await ranked(w, ana);
    expect((await scores(w, ana)).all).toContain(`ana ${again.score}`);

    // A new week: this week's board starts empty, and last week's winners are the old week's.
    tick(8 * 24 * 60 * 60 * 1000);
    expect((await scores(w, ana)).week).toEqual([]);
    expect((await scores(w, ana)).lastWeek).toHaveLength(2);
  });
});

/** The change points of `inputs` at steps in [from, to): what one upload carries. */
const chunk = (inputs: number[], from: number, to: number) => inputs.flatMap((v, i) => (i % 2 === 0 && v >= from && v < to ? [v, inputs[i + 1]] : []));

/** Starts a run on seed 7 at the current time; returns its id and the run the autopilot plays on it. */
async function started(w: TestWorker, token: string) {
  const start = await w.call(token, 'POST', '/api/runs', START);
  expect(start.status).toBe(200);
  const id = start.body.id as string;
  w.db.query('UPDATE runs SET seed = 7 WHERE id = ?').run(id);
  return { id, run: playRun({ seed: 7, mobile: false, afterCrash: false }, 0) };
}

const beats = (w: TestWorker, id: string) => JSON.parse((w.db.query('SELECT beats FROM runs WHERE id = ?').get(id) as { beats: string }).beats);

describe('uploads', () => {
  test('a pause before the seed arrives is not counted as play', async () => {
    tick(0);
    const w = createTestWorker();
    const ana = await w.player('ana');
    const { id, run } = await started(w, ana);
    // Paused 3 steps in; the pause goes up once the seed is back, and the resume 9 s later.
    tick(300);
    expect((await w.call(ana, 'POST', `/api/runs/${id}/beat`, { seq: 1, kind: 'pause', steps: 3, inputs: chunk(run.inputs, 0, 3) })).status).toBe(200);
    tick(8700);
    expect((await w.call(ana, 'POST', `/api/runs/${id}/beat`, { seq: 2, kind: 'resume', steps: 3, inputs: [] })).status).toBe(200);
    tick((run.steps - 3) * SIM.STEP_MS + 100);
    const finish = await w.call(ana, 'POST', `/api/runs/${id}/finish`, { seq: 3, kind: 'finish', steps: run.steps, inputs: chunk(run.inputs, 3, run.steps) });
    expect(finish.body).toMatchObject({ status: 'ok', score: run.score });
    expect(JSON.parse(status(w, id).checks as string)).toMatchObject({ pauses: 1 });
  });

  test('a resent upload gets the same answer and is not applied twice', async () => {
    tick(0);
    const w = createTestWorker();
    const ana = await w.player('ana');
    const { id, run } = await started(w, ana);
    tick(1000);
    const first = { seq: 1, kind: 'tick', steps: 60, inputs: chunk(run.inputs, 0, 60) };
    expect((await w.call(ana, 'POST', `/api/runs/${id}/beat`, first)).status).toBe(200);
    tick(500);
    expect((await w.call(ana, 'POST', `/api/runs/${id}/beat`, first)).status).toBe(200);
    expect(beats(w, id)).toHaveLength(2);
    expect(w.db.query('SELECT inputs FROM runs WHERE id = ?').get(id)).toEqual({ inputs: JSON.stringify(first.inputs) });
    // The same number with something else in it, or a number out of line, is refused.
    expect((await w.call(ana, 'POST', `/api/runs/${id}/beat`, { ...first, steps: 61 })).status).toBe(400);
    expect((await w.call(ana, 'POST', `/api/runs/${id}/beat`, { ...first, seq: 3 })).status).toBe(400);
  });

  test('two copies of an upload racing each other are applied once', async () => {
    tick(0);
    const w = createTestWorker();
    const ana = await w.player('ana');
    const { id, run } = await started(w, ana);
    tick(1000);
    const up = { seq: 1, kind: 'tick', steps: 60, inputs: chunk(run.inputs, 0, 60) };
    const answers = await Promise.all([w.call(ana, 'POST', `/api/runs/${id}/beat`, up), w.call(ana, 'POST', `/api/runs/${id}/beat`, up)]);
    expect(answers.map((a) => a.status)).toContain(200);
    expect(beats(w, id)).toHaveLength(2);
    // Whichever lost (409) reads as a repeat when sent again.
    expect((await w.call(ana, 'POST', `/api/runs/${id}/beat`, up)).status).toBe(200);
  });

  test('a resent finish gets its verdict again, and a finish right after a tick goes through', async () => {
    tick(0);
    const w = createTestWorker();
    const ana = await w.player('ana');
    const { id, run } = await started(w, ana);
    tick(run.steps * SIM.STEP_MS);
    expect((await w.call(ana, 'POST', `/api/runs/${id}/beat`, { seq: 1, kind: 'tick', steps: run.steps - 1, inputs: chunk(run.inputs, 0, run.steps - 1) })).status).toBe(200);
    tick(100);
    const up = { seq: 2, kind: 'finish', steps: run.steps, inputs: chunk(run.inputs, run.steps - 1, run.steps) };
    const finish = await w.call(ana, 'POST', `/api/runs/${id}/finish`, up);
    expect(finish).toMatchObject({ status: 200, body: { status: 'ok', score: run.score } });
    tick(5000);
    expect(await w.call(ana, 'POST', `/api/runs/${id}/finish`, up)).toEqual(finish);
    expect(beats(w, id)).toHaveLength(3);
  });

  test('pauses pair up with resumes at the same step', async () => {
    tick(0);
    const w = createTestWorker();
    const ana = await w.player('ana');
    const { id } = await started(w, ana);
    const send = (seq: number, kind: string, steps: number) => w.call(ana, 'POST', `/api/runs/${id}/${kind === 'finish' ? 'finish' : 'beat'}`, { seq, kind, steps, inputs: [] });
    tick(1000);
    expect((await send(1, 'resume', 0)).status).toBe(400);
    expect((await send(1, 'pause', 0)).status).toBe(200);
    tick(3000);
    expect((await send(2, 'tick', 0)).status).toBe(400);
    expect((await send(2, 'pause', 0)).status).toBe(400);
    expect((await send(2, 'finish', 0)).status).toBe(400);
    expect((await send(2, 'resume', 5)).status).toBe(400);
    expect((await send(2, 'resume', 0)).status).toBe(200);
  });

  test('a run started before the upload protocol changed is told to reload', async () => {
    tick(0);
    const w = createTestWorker();
    const ana = await w.player('ana');
    const { protocol: _, ...legacy } = START;
    expect(await w.call(ana, 'POST', '/api/runs', legacy)).toMatchObject({ status: 409, body: { error: 'the game was updated, reload the page' } });
    const { id } = await started(w, ana);
    w.db.query('UPDATE runs SET protocol = 1 WHERE id = ?').run(id);
    tick(1000);
    expect((await w.call(ana, 'POST', `/api/runs/${id}/beat`, { seq: 1, kind: 'tick', steps: 60, inputs: [0, 3] })).status).toBe(409);
    // A tab from before sends unnumbered uploads.
    expect((await w.call(ana, 'POST', `/api/runs/${id}/beat`, { steps: 60, inputs: [0, 3] })).body).toEqual({ error: 'the game was updated, reload the page' });
  });
});
