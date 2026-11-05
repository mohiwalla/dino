// runs.html: a signed-in player's own runs, newest first, with their best and rank, all time
// and this week. Why a run was flagged stays on the admin page.

import { revealPage } from './curtain';
import { api, type BoardData } from './net/api';
import { bestTag, call, duration, empty, h, heading, loading, pill, px, signIn, speed, stats, table, tabs, time, toast, topBar, watchLink } from './pages';

type Period = 'all' | 'week';

interface MyRun {
  id: string;
  score: number | null;
  status: string;
  mobile: boolean;
  fast: boolean;
  multiplier: number;
  steps: number;
  finishedAt: number | null;
}

const root = document.getElementById('runs') as HTMLElement;
let period: Period = 'all';
let runs: MyRun[] = [];
let weekStart = 0;
let board: BoardData | null = null;

const summary = h('div');
const tabBar = h('div');
const list = h('div');

const inPeriod = (r: MyRun) => period === 'all' || (r.finishedAt ?? 0) >= weekStart;

function draw(): void {
  const shown = runs.filter(inPeriod);
  const ranked = shown.filter((r) => r.status === 'ok' && r.score !== null);
  const best = ranked.reduce<MyRun | null>((b, r) => (b && b.score! >= r.score! ? b : r), null);
  const place = period === 'all' ? board : board?.week;
  const rank = place?.me ? `#${place.me.rank}` : '-';
  const label = period === 'all' ? 'ALL TIME' : 'THIS WEEK';
  summary.replaceChildren(
    stats([
      [`BEST · ${label}`, best ? String(best.score) : '-', best?.finishedAt ? `SET ${new Date(best.finishedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }).toUpperCase()}` : 'NO RANKED RUN YET'],
      [`RANK · ${label}`, rank, place ? `OF ${place.players} PLAYERS` : ''],
      ['RUNS', String(shown.length), shown.length > ranked.length ? `${shown.length - ranked.length} NOT RANKED` : 'ALL RANKED'],
      ['TIME PLAYED', duration(shown.reduce((t, r) => t + r.steps, 0))],
    ]),
  );
  tabBar.replaceChildren(
    tabs<Period>(
      [
        ['all', 'ALL TIME'],
        ['week', 'THIS WEEK'],
      ],
      period,
      (p) => {
        period = p;
        draw();
      },
    ),
  );
  if (shown.length === 0) {
    list.replaceChildren(empty(period === 'week' ? 'NO RUNS THIS WEEK YET' : 'NO RANKED RUNS YET · TURN ON RANKED RUNS IN THE GAME SETTINGS', h('a', { className: 'chip chip-primary', href: '/' }, px('PLAY'))));
    return;
  }
  list.replaceChildren(
    table(
      [{ label: 'SCORE', className: 'num' }, { label: 'STATUS' }, { label: 'SPEED' }, { label: 'LENGTH' }, { label: 'FINISHED' }, { label: '', className: 'actions' }],
      shown.map((r) => [
        h('span', { className: 'cell' }, ...(r === best ? [bestTag()] : []), px(r.score === null ? '-' : String(r.score), 3)),
        pill(r.status),
        `${speed(r)}${r.mobile ? ' 📱' : ''}`,
        duration(r.steps),
        time(r.finishedAt),
        watchLink(r.id),
      ]),
    ),
  );
}

async function start(): Promise<void> {
  root.replaceChildren(loading());
  const me = await api.me().catch(() => null);
  if (!me) {
    root.replaceChildren(topBar(null, 'runs'), signIn('MY RUNS', '/runs'));
    return;
  }
  root.replaceChildren(
    topBar(me, 'runs'),
    heading('MY RUNS', `${me.name.split(' ')[0].toUpperCase()}'S RANKED RUNS · NEWEST FIRST · WATCH ANY OF THEM BACK`),
    summary,
    h('div', { className: 'toolbar' }, tabBar),
    list,
  );
  list.replaceChildren(loading());
  try {
    const [mine, lb] = await Promise.all([call<{ runs: MyRun[]; weekStart: number }>('runs/mine'), api.leaderboard().catch(() => null)]);
    runs = mine.runs;
    weekStart = mine.weekStart;
    board = lb;
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), 'bad');
  }
  draw();
}

// Under the curtain from another page until the runs are in.
void start().finally(revealPage);
