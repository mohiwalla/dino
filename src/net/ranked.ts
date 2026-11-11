// Ranked play: signs the player's runs up with the leaderboard server, records their input,
// streams it up while they play, and turns the server's verdict into what the HUD shows.
//
// Every run asks the server for an obstacle seed the moment it starts. The seed has to arrive
// before the first obstacle spawns (STEPS.CLEAR, 1.2 s in); a run that started without one just
// isn't ranked. While a ranked run is going the browser uploads a tick every BEAT_MS, and one on
// each pause and resume, so the server can hold the step count against its own clock
// (worker/verify.ts). Uploads go out in order through an outbox (./outbox.ts), which keeps a
// pause made before the seed arrived and retries uploads that didn't get through.

import { STORAGE_KEYS } from '../config';
import { mulberry32 } from '../sim/rng';
import { createInputRecorder, RUN_PROTOCOL, SIM_VERSION, type InputRecorder, type UploadKind } from '../sim/replay';
import { STEPS } from '../sim/steps';
import type { BoardEntry, BoardView, GameEvent, GameSim, InputFrame, RunLook } from '../types';
import { api, ApiError, type Account, type BoardData, type BoardList } from './api';
import { createOutbox, type Outbox } from './outbox';

const BEAT_MS = 10_000;
const BOARD_ROWS = 10;
/** ?stale: this tab claims the previous game version, to see what a tab left open over an update gets. */
const STALE = new URLSearchParams(location.search).has('stale');
/** ?winners: show last week's winners banner now (with this board's top 3 if last week had none). */
const PREVIEW_WINNERS = new URLSearchParams(location.search).has('winners');

export interface RankedOptions {
  /** The sim being played (main.ts swaps it for replays). */
  sim: () => GameSim;
  mobile: boolean;
  /** The game speed multiplier (read when each run starts; main.ts plays the run at the same one). */
  multiplier: () => number;
  /** False while runs can't be ranked (ranking off, autopilot, ?seed=, a replay). */
  rankable: () => boolean;
  /** A run passed the checks and the player's best puts them at `rank` on the board. */
  onRank: (rank: number) => void;
  /** The server (not the cached account) says the player is an admin. */
  onAdmin: () => void;
  onView: (view: BoardView) => void;
  /** How the run looked and sounded, read as it's submitted (after the crash has been shown). */
  look: () => RunLook;
}

export interface Ranked {
  /** Every step that advanced the sim, with the input it was given and the events it emitted. */
  stepped(input: InputFrame, events: readonly GameEvent[]): void;
  paused(): void;
  resumed(): void;
  /** Something made the current run unfair (debug view, autopilot) or ranking was turned off: it stops counting. */
  forfeit(): void;
  signOut(): Promise<void>;
  /** The run that just crashed was ranked, so its celebration waits for the server's rank. */
  readonly lastRunRanked: boolean;
  /** Deletes all the player's runs, taking them off the board; they stay signed in. Resolves to whether it worked. */
  deleteStats(): Promise<boolean>;
  readonly account: Account | null;
}

interface Run {
  recorder: InputRecorder;
  afterCrash: boolean;
  state: 'starting' | 'ranked' | 'unranked' | 'finished';
  id: string | null;
  outbox: Outbox;
  /** Paused (ticks wait for the resume). */
  paused: boolean;
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

export function createRanked(opts: RankedOptions): Ranked {
  let account: Account | null = null;
  let reachable = false;
  let board: BoardData | null = null;
  let run: Run | null = null;
  let note = '';
  let live = '';
  let newBest: BoardView['newBest'] = null;
  let statsDeleted: BoardView['statsDeleted'] = null;
  let lastRunRanked = false;
  /** The server said this tab's game is out of date (it was updated since the page loaded). */
  let outdated = false;
  /** The last finish upload; the next run's start waits for it, so it can't abandon that run. */
  let finishing: Promise<unknown> = Promise.resolve();

  /** A board's top rows, plus the player's own row at the end if they are further down. */
  function rows(list: BoardList | undefined): BoardEntry[] {
    const entries: BoardEntry[] = (list?.entries ?? []).slice(0, BOARD_ROWS).map((e) => ({
      rank: e.rank,
      name: e.name,
      score: e.score,
      mobile: e.mobile,
      fast: e.fast,
      multiplier: e.multiplier,
      me: e.me,
    }));
    if (list?.me && list.me.rank > BOARD_ROWS) {
      entries.push({ rank: list.me.rank, name: account?.name ?? '', score: list.me.score, mobile: false, fast: false, multiplier: 1, me: true });
    }
    return entries;
  }

  function publish(): void {
    const entries = rows(board ?? undefined);
    const week = rows(board?.week);
    const winners = board?.announce || (PREVIEW_WINNERS && board?.lastWeek?.length) ? (board?.lastWeek ?? []) : PREVIEW_WINNERS ? (board?.entries ?? []).slice(0, 3) : [];
    const lastWeek = rows({ entries: winners, me: null, players: 0 }).map((e) => ({ ...e, me: false }));
    let shownNote = outdated ? 'GAME UPDATED - RELOAD THE PAGE' : note;
    if (!shownNote && account?.banned) shownNote = 'BANNED FROM THE BOARD';
    else if (!shownNote && reachable && !account) shownNote = 'SIGN IN TO JOIN THE TEAM BOARD';
    else if (!shownNote && account && entries.length === 0) shownNote = 'NO RANKED RUNS YET';
    opts.onView({ account: !reachable ? 'off' : account ? 'signedIn' : 'signedOut', name: account?.name ?? null, email: account?.email ?? null, entries, week, lastWeek, note: shownNote, live, newBest, statsDeleted });
  }

  async function refresh(): Promise<void> {
    try {
      // Both at once; the board just fails (401) when signed out.
      const [me, data] = await Promise.all([api.me(), api.leaderboard().catch(() => null)]);
      account = me;
      board = me ? data : null;
      reachable = true;
      if (me?.admin) opts.onAdmin();
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

  /** The run stops counting; the HUD just drops its RANKED line. */
  function unranked(r: Run): void {
    if (r.state === 'finished') return;
    r.state = 'unranked';
    clearInterval(r.timer);
    r.outbox.stop();
    if (r === run) {
      live = '';
      publish();
    }
  }

  /** Queues an upload of what was recorded up to now (it goes out once the run has its id). */
  function upload(r: Run, kind: UploadKind): void {
    r.outbox.push(kind, r.recorder.steps, r.recorder.take(), kind === 'finish' ? opts.look() : undefined);
  }

  async function finish(r: Run): Promise<void> {
    /** Where the player stood before this run, to tell a rank up. */
    const before = board?.me?.rank ?? null;
    note = 'CHECKING RUN';
    publish();
    upload(r, 'finish');
    const result = await r.outbox.finished();
    if (!result) note = 'COULD NOT SUBMIT RUN';
    else if (result.status === 'review') note = 'RUN SENT FOR REVIEW';
    else if (result.status === 'rejected') note = 'RUN FAILED THE CHECKS';
    else if (result.previousBest === null || (result.score ?? 0) > result.previousBest) note = `NEW BEST! RANK ${result.rank}`;
    else note = `YOUR BEST IS RANK ${result.rank}`;
    if (result?.status === 'ok' && result.rank !== null) {
      opts.onRank(result.rank);
      // A new best is cheered whether or not it moves the rank (staying #1 with a higher score counts).
      if (before === null || result.previousBest === null || (result.score ?? 0) > result.previousBest || result.rank < before) newBest = { from: before, to: result.rank };
    }
    await refresh();
    newBest = null;
  }

  function begin(afterCrash: boolean, first: InputFrame): void {
    opts.sim().setObstacleRandom(null);
    const multiplier = opts.multiplier();
    const outbox = createOutbox({
      send: (id, u) => (u.kind === 'finish' ? api.finish(id, u) : api.beat(id, u).then(() => null)),
      onRefused: () => unranked(r),
    });
    const r: Run = { recorder: createInputRecorder(), afterCrash, state: 'starting', id: null, outbox, paused: false, timer: 0 };
    r.recorder.record(first);
    run = r;
    note = '';
    live = '';
    if (!account || account.banned || !opts.rankable()) {
      unranked(r);
      return;
    }
    finishing
      .then(() => api.startRun({ mobile: opts.mobile, afterCrash, multiplier, simVersion: STALE ? SIM_VERSION - 1 : SIM_VERSION, protocol: RUN_PROTOCOL }))
      .then(({ id, seed }) => {
        if (r.state !== 'starting') return;
        const sim = opts.sim();
        const s = sim.getSnapshot();
        if (s.phase === 'crashed' || s.runFrames > STEPS.CLEAR || s.obstacles.length > 0) {
          unranked(r);
          return;
        }
        sim.setObstacleRandom(mulberry32(seed));
        r.id = id;
        r.state = 'ranked';
        // Sends a pause made while the seed was on its way, then everything after.
        r.outbox.start(id);
        r.timer = window.setInterval(() => {
          if (r.state === 'ranked' && !r.paused) upload(r, 'tick');
        }, BEAT_MS);
        live = 'RANKED';
        publish();
      })
      .catch((err: unknown) => {
        unranked(r);
        // The game was updated since this tab loaded: runs can't be ranked until it reloads.
        if (err instanceof ApiError && err.status === 409) {
          outdated = true;
          live = 'RELOAD TO RANK';
          publish();
        }
      });
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
        lastRunRanked = ranked;
        clearInterval(run.timer);
        run.state = 'finished';
        live = '';
        // A microtask later, once this frame has shown the crash and picked its clip, line and move.
        const r = run;
        if (ranked) finishing = Promise.resolve().then(() => finish(r));
        else publish();
      }
    },
    // Noted even before the seed arrives (the outbox holds them till then), so a pause in the
    // run's first moments isn't counted as play.
    paused() {
      if (!run || (run.state !== 'starting' && run.state !== 'ranked') || run.paused) return;
      run.paused = true;
      upload(run, 'pause');
    },
    resumed() {
      if (!run || (run.state !== 'starting' && run.state !== 'ranked') || !run.paused) return;
      run.paused = false;
      upload(run, 'resume');
    },
    forfeit() {
      if (run && (run.state === 'starting' || run.state === 'ranked')) unranked(run);
    },
    async signOut() {
      if (run && (run.state === 'starting' || run.state === 'ranked')) unranked(run);
      await api.logout().catch(() => undefined);
      note = '';
      await refresh();
    },
    async deleteStats() {
      if (run && (run.state === 'starting' || run.state === 'ranked')) unranked(run);
      const deleted = await api.deleteRuns().then(
        () => true,
        () => false,
      );
      note = deleted ? 'STATS DELETED' : 'COULD NOT DELETE STATS';
      statsDeleted = deleted ? {} : null;
      await refresh();
      statsDeleted = null;
      return deleted;
    },
    get account() {
      return account;
    },
    get lastRunRanked() {
      return lastRunRanked;
    },
  };
}
