// admin.html: review flagged runs, void or approve runs, ban players. Admins are listed in
// ADMIN_EMAILS (wrangler.jsonc); the server checks every call, this page is only a front end.

import { revealPage } from './curtain';
import { api } from './net/api';
import { actionButton, call, confirmAction, duration, empty, h, heading, loading, panel, pill, px, pxWords, signIn, speed, stats, table, tabs, time, toast, topBar, watchLink } from './pages';

type Tab = 'review' | 'all' | 'users';

interface AdminRun {
  id: string;
  name: string;
  email: string;
  score: number | null;
  status: string;
  /** What the checks decided, before any admin decision (null for runs from before it was kept). */
  verdict: string | null;
  /** The player deleted their stats: off the board and their list, still here. */
  hidden: number;
  flags: string | null;
  mobile: number;
  fast: number;
  multiplier: number;
  steps: number;
  started_at: number;
  finished_at: number | null;
}

interface AdminUser {
  id: string;
  name: string;
  email: string;
  banned: number;
  best: number | null;
  runs: number;
}

const root = document.getElementById('admin') as HTMLElement;
let tab: Tab = 'review';
let query = '';
let review: AdminRun[] = [];
let all: AdminRun[] | null = null;
let users: AdminUser[] = [];

const summary = h('div');
const tabBar = h('div');
const list = h('div');
const search = h('input', { type: 'search', className: 'search', placeholder: 'Search players', ariaLabel: 'Search players' });
search.spellcheck = false;
search.addEventListener('input', () => {
  query = search.value.trim().toLowerCase();
  draw();
});

const matches = (p: { name: string; email: string }) => !query || p.name.toLowerCase().includes(query) || p.email.toLowerCase().includes(query);

const player = (p: { name: string; email: string }) => h('div', { className: 'player' }, px(p.name.toUpperCase()), h('span', { className: 'note' }, px(p.email)));

function runsTable(runs: AdminRun[]): HTMLElement {
  const shown = runs.filter(matches);
  if (shown.length === 0) return empty(query ? 'NO RUNS FROM PLAYERS MATCHING THAT SEARCH' : tab === 'review' ? 'NOTHING TO REVIEW · ALL CLEAR' : 'NO RUNS YET');
  return table(
    [{ label: 'PLAYER' }, { label: 'SCORE', className: 'num' }, { label: 'STATUS' }, { label: 'WHY FLAGGED' }, { label: 'RUN' }, { label: 'FINISHED' }, { label: '', className: 'actions' }],
    shown.map((r) => {
      const actions = h('div', { className: 'cell' }, watchLink(r.id, true));
      if (r.score !== null && r.status !== 'ok' && r.status !== 'rejected') actions.append(actionButton('APPROVE', () => setRun(r, 'ok')));
      if (r.score !== null && r.status !== 'void' && r.status !== 'rejected') {
        actions.append(
          actionButton(
            'VOID',
            async () => {
              if (await confirmAction(`VOID ${r.name.toUpperCase()}'S ${r.score}?`, 'THE RUN COMES OFF THE BOARD. YOU CAN APPROVE IT AGAIN LATER.', 'VOID RUN')) await setRun(r, 'void');
            },
            true,
          ),
        );
      }
      return [
        player(r),
        r.score === null ? '-' : String(r.score),
        status(r),
        r.flags ? h('span', { className: 'why' }, pxWords(r.flags.toUpperCase())) : '',
        h('span', { className: 'cell' }, px(duration(r.steps)), h('span', { className: 'note' }, px(`${speed(r)}${r.mobile ? ' 📱' : ''}`))),
        time(r.finished_at),
        actions,
      ];
    }),
  );
}

/** The run's status, with what the checks said if an admin has since changed it, and whether the player deleted it. */
function status(r: AdminRun): HTMLElement {
  const notes: string[] = [];
  if (r.verdict && r.verdict !== r.status) notes.push(`CHECKS: ${r.verdict === 'ok' ? 'PASSED' : r.verdict.toUpperCase()}`);
  if (r.hidden) notes.push('DELETED BY PLAYER');
  return h('span', { className: 'cell' }, pill(r.status), ...notes.map((n) => h('span', { className: 'note' }, px(n))));
}

function usersTable(): HTMLElement {
  const shown = users.filter(matches);
  if (shown.length === 0) return empty(query ? 'NO PLAYERS MATCH THAT SEARCH' : 'NO PLAYERS YET');
  return table(
    [{ label: 'PLAYER' }, { label: 'BEST', className: 'num' }, { label: 'RUNS', className: 'num' }, { label: 'STATUS' }, { label: '', className: 'actions' }],
    shown.map((u) => [
      player(u),
      u.best === null ? '-' : String(u.best),
      String(u.runs),
      u.banned ? pill('banned') : h('span', { className: 'muted' }, px('ACTIVE')),
      h(
        'div',
        { className: 'cell' },
        u.banned
          ? actionButton('UNBAN', () => setUser(u, false))
          : actionButton(
              'BAN',
              async () => {
                if (await confirmAction(`BAN ${u.name.toUpperCase()}?`, 'THEIR RUNS LEAVE THE BOARD AND THEY CAN NO LONGER PLAY RANKED. YOU CAN UNBAN THEM LATER.', 'BAN PLAYER')) await setUser(u, true);
              },
              true,
            ),
      ),
    ]),
  );
}

async function setRun(r: AdminRun, status: 'ok' | 'void'): Promise<void> {
  await call(`admin/runs/${encodeURIComponent(r.id)}`, { status });
  toast(status === 'ok' ? `Approved ${r.name}'s ${r.score}` : `Voided ${r.name}'s ${r.score}`);
  await load();
}

async function setUser(u: AdminUser, banned: boolean): Promise<void> {
  await call(`admin/users/${encodeURIComponent(u.id)}`, { banned });
  toast(banned ? `Banned ${u.name}` : `Unbanned ${u.name}`);
  await load();
}

/** Redraws from what's loaded; searching only calls this, so the box keeps its focus. */
function draw(): void {
  const banned = users.filter((u) => u.banned).length;
  summary.replaceChildren(
    stats([
      ['IN REVIEW', String(review.length), review.length ? 'WAITING ON YOU' : 'ALL CLEAR'],
      ['PLAYERS', String(users.length), `${users.filter((u) => u.runs > 0).length} HAVE PLAYED`],
      ['BANNED', String(banned)],
    ]),
  );
  tabBar.replaceChildren(
    tabs<Tab>(
      [
        ['review', 'IN REVIEW', review.length],
        ['all', 'ALL RUNS'],
        ['users', 'PLAYERS'],
      ],
      tab,
      (t) => {
        tab = t;
        void load();
      },
    ),
  );
  if (tab === 'all' && all === null) list.replaceChildren(loading());
  else list.replaceChildren(tab === 'users' ? usersTable() : runsTable(tab === 'review' ? review : (all ?? [])));
}

async function load(): Promise<void> {
  draw();
  try {
    [review, users, all] = await Promise.all([
      call<{ runs: AdminRun[] }>('admin/runs?status=review').then((r) => r.runs),
      call<{ users: AdminUser[] }>('admin/users').then((r) => r.users),
      tab === 'all' ? call<{ runs: AdminRun[] }>('admin/runs?status=all').then((r) => r.runs) : Promise.resolve(all),
    ]);
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), 'bad');
  }
  draw();
}

async function start(): Promise<void> {
  root.replaceChildren(loading());
  const me = await api.me().catch(() => null);
  if (!me) {
    root.replaceChildren(topBar(null, 'admin'), signIn('ADMIN', '/admin'));
    return;
  }
  if (!me.admin) {
    root.replaceChildren(topBar(me, 'admin'), panel('ADMINS ONLY', `${me.email.toUpperCase()} IS NOT AN ADMIN.`, h('a', { className: 'chip chip-primary', href: '/runs' }, px('MY RUNS'))));
    return;
  }
  root.replaceChildren(
    topBar(me, 'admin'),
    heading('ADMIN', 'CHECK FLAGGED RUNS · VOID SCORES · BAN PLAYERS'),
    summary,
    h('div', { className: 'toolbar' }, tabBar, search),
    list,
  );
  await load();
}

// Under the curtain from another page until the lists are in.
void start().finally(revealPage);
