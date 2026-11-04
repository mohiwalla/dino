// Ranked play: signs the player's runs up with the leaderboard server, records their input,
// streams it up while they play, and turns the server's verdict into what the HUD shows.
//
// Every run asks the server for an obstacle seed the moment it starts. The seed has to arrive
// before the first obstacle spawns (STEPS.CLEAR, 3 s in); a run that started without one just
// isn't ranked. While a ranked run is going the browser "beats" every BEAT_MS, and on pause
// and resume, so the server can hold the step count against its own clock (worker/verify.ts).

import { STORAGE_KEYS } from '../config';
import { mulberry32 } from '../sim/rng';
import { createInputRecorder, SIM_VERSION, type InputRecorder } from '../sim/replay';
import { STEPS } from '../sim/steps';
import type { BoardEntry, BoardView, GameEvent, GameSim, InputFrame } from '../types';
import { api, ApiError, type Account, type BoardData, type FinishResult } from './api';

const BEAT_MS = 10_000;
const BOARD_ROWS = 10;
const FINISH_TRIES = 3;

export interface RankedOptions {
  /** The sim being played (main.ts swaps it for replays). */
  sim: () => GameSim;
  mobile: boolean;
  /** Why runs can't be ranked right now (autopilot, ?seed=, a replay), or null if they can. */
  blocker: () => string | null;
  onView: (view: BoardView) => void;
}

export interface Ranked {
  /** Every step that advanced the sim, with the input it was given and the events it emitted. */
  stepped(input: InputFrame, events: readonly GameEvent[]): void;
  paused(): void;
  resumed(): void;
  /** Something made the current run unfair (debug view, autopilot): it stops counting. */
  forfeit(reason: string): void;
  readonly account: Account | null;
}

interface Run {
  recorder: InputRecorder;
  afterCrash: boolean;
  state: 'starting' | 'ranked' | 'unranked' | 'finished';
  id: string | null;
  /** Inputs taken from the recorder but not yet accepted by the server. */
  unsent: number[];
  sending: Promise<void> | null;
  beatAgain: boolean;
  timer: number;
}

interface Cached {
  account: Account | null;
  board: BoardData | null;
}

function readCache(): Cached | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.board);
    return raw ? (JSON.parse(raw) as Cached) : null;
  } catch {
    return null;
  }
}

function writeCache(value: Cached): void {
  try {
    localStorage.setItem(STORAGE_KEYS.board, JSON.stringify(value));
  } catch {
    // Storage disabled: the board just loads from the server each time.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createRanked(opts: RankedOptions): Ranked {
  let account: Account | null = null;
  let reachable = false;
  let board: BoardData | null = null;
  let run: Run | null = null;
  let note = '';
  let live = '';
  /** The last finish upload; the next run's start waits for it, so it can't abandon that run. */
  let finishing: Promise<unknown> = Promise.resolve();

  function publish(): void {
    const entries: BoardEntry[] = (board?.entries ?? []).slice(0, BOARD_ROWS).map((e) => ({
      rank: e.rank,
      name: e.name,
      score: e.score,
      mobile: e.mobile,
      me: e.me,
    }));
    if (board?.me && board.me.rank > BOARD_ROWS) {
      entries.push({ rank: board.me.rank, name: account?.name ?? '', score: board.me.score, mobile: false, me: true });
    }
    let shownNote = note;
    if (!shownNote && account?.banned) shownNote = 'BANNED FROM THE BOARD';
    else if (!shownNote && reachable && !account) shownNote = 'SIGN IN TO JOIN THE TEAM BOARD';
    else if (!shownNote && account && entries.length === 0) shownNote = 'NO RANKED RUNS YET';
    opts.onView({ account: !reachable ? 'off' : account ? 'signedIn' : 'signedOut', entries, note: shownNote, live });
  }

  async function refresh(): Promise<void> {
    try {
      // Both at once; the board just fails (401) when signed out.
      const [me, data] = await Promise.all([api.me(), api.leaderboard().catch(() => null)]);
      account = me;
      board = me ? data : null;
      reachable = true;
      writeCache({ account, board });
    } catch {
      // Offline, or a plain static host without the server: no leaderboard UI at all.
      reachable = account !== null;
    }
    publish();
  }

  // Show the last known board at once; refresh() replaces it when the server answers.
  const cached = readCache();
  if (cached) {
    account = cached.account;
    board = cached.board;
    reachable = true;
    publish();
  }

  function unranked(r: Run, reason: string): void {
    if (r.state === 'finished') return;
    r.state = 'unranked';
    clearInterval(r.timer);
    if (r === run) {
      live = reason ? `UNRANKED · ${reason}` : '';
      publish();
    }
  }

  /** Uploads what was recorded since the last upload; `final` closes the run. */
  async function send(r: Run, final: boolean): Promise<FinishResult | null> {
    r.unsent = r.unsent.concat(r.recorder.take());
    const body = { steps: r.recorder.steps, inputs: r.unsent };
    const sent = r.unsent.length;
    const result = final ? await api.finish(r.id!, body) : (await api.beat(r.id!, body), null);
    r.unsent = r.unsent.slice(sent);
    return result;
  }

  function beat(r: Run): void {
    if (r.state !== 'ranked') return;
    if (r.sending) {
      r.beatAgain = true;
      return;
    }
    r.sending = send(r, false)
      .then(() => undefined)
      .catch((err: unknown) => {
        // Network trouble and rate limits: the inputs stay queued for the next beat.
        if (err instanceof ApiError && err.status >= 400 && err.status !== 429) unranked(r, 'SERVER SAID NO');
      })
      .finally(() => {
        r.sending = null;
        if (r.beatAgain) {
          r.beatAgain = false;
          beat(r);
        }
      });
  }

  async function finish(r: Run): Promise<void> {
    while (r.sending) await r.sending;
    note = 'CHECKING RUN';
    publish();
    let result: FinishResult | null = null;
    for (let i = 0; i < FINISH_TRIES && !result; i++) {
      try {
        result = await send(r, true);
      } catch (err) {
        if (err instanceof ApiError && err.status >= 400) break;
        await sleep(1000 * (i + 1));
      }
    }
    if (!result) note = 'COULD NOT SUBMIT RUN';
    else if (result.status === 'review') note = 'RUN SENT FOR REVIEW';
    else if (result.status === 'rejected') note = 'RUN FAILED THE CHECKS';
    else if (result.previousBest === null || (result.score ?? 0) > result.previousBest) note = `NEW BEST! RANK ${result.rank}`;
    else note = `YOUR BEST IS RANK ${result.rank}`;
    await refresh();
  }

  function begin(afterCrash: boolean, first: InputFrame): void {
    opts.sim().setObstacleRandom(null);
    const r: Run = { recorder: createInputRecorder(), afterCrash, state: 'starting', id: null, unsent: [], sending: null, beatAgain: false, timer: 0 };
    r.recorder.record(first);
    run = r;
    note = '';
    live = '';
    const blocker = opts.blocker();
    if (!account || account.banned || blocker) {
      unranked(r, account && !account.banned ? (blocker ?? '') : '');
      return;
    }
    finishing
      .then(() => api.startRun({ mobile: opts.mobile, afterCrash, simVersion: SIM_VERSION }))
      .then(({ id, seed }) => {
        if (r.state !== 'starting') return;
        const sim = opts.sim();
        const s = sim.getSnapshot();
        if (s.phase === 'crashed' || s.runFrames > STEPS.CLEAR || s.obstacles.length > 0) {
          unranked(r, 'SERVER TOO SLOW');
          return;
        }
        sim.setObstacleRandom(mulberry32(seed));
        r.id = id;
        r.state = 'ranked';
        r.timer = window.setInterval(() => beat(r), BEAT_MS);
        live = 'RANKED';
        publish();
      })
      .catch((err: unknown) => unranked(r, err instanceof ApiError && err.status === 409 ? 'RELOAD THE PAGE' : 'OFFLINE'));
    publish();
  }

  void refresh();
  window.addEventListener('online', () => void refresh());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!run || run.state !== 'ranked')) void refresh();
  });

  return {
    stepped(input, events) {
      let started = false;
      for (const e of events) {
        if (e.type === 'start' || e.type === 'restart') {
          begin(e.type === 'restart', input);
          started = true;
        }
      }
      if (!run || run.state === 'finished') return;
      if (!started) run.recorder.record(input);
      if (events.some((e) => e.type === 'crash')) {
        const ranked = run.state === 'ranked';
        clearInterval(run.timer);
        run.state = 'finished';
        live = '';
        if (ranked) finishing = finish(run);
        else publish();
      }
    },
    paused() {
      if (run) beat(run);
    },
    resumed() {
      if (run) beat(run);
    },
    forfeit(reason) {
      if (run && (run.state === 'starting' || run.state === 'ranked')) unranked(run, reason);
    },
    get account() {
      return account;
    },
  };
}
