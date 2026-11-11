import { afterEach, describe, expect, test, setSystemTime } from 'bun:test';
import { SIM } from '../src/config';
import { autopilot } from '../src/sim/autopilot';
import { createInputRecorder, createRunSim, replayRun, SIM_VERSION, type RunSpec } from '../src/sim/replay';
import type { InputFrame } from '../src/types';
import { createTestWorker } from './worker-api';

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
