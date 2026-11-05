// admin.html: review flagged runs, void or approve runs, ban players. Admins are listed in
// ADMIN_EMAILS (wrangler.jsonc); the server checks every call, this page is only a front end.

import './admin.css';
import { api, ApiError } from './net/api';

type Tab = 'review' | 'all' | 'users';

interface AdminRun {
  id: string;
  name: string;
  email: string;
  score: number | null;
  status: string;
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

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
  return data;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function when(ms: number | null): string {
  return ms === null ? '' : new Date(ms).toLocaleString();
}

function duration(steps: number): string {
  const s = Math.round(steps / 60);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function action(label: string, run: () => Promise<unknown>): HTMLButtonElement {
  const button = h('button', { type: 'button', textContent: label });
  button.addEventListener('click', () => {
    button.disabled = true;
    run()
      .then(render)
      .catch((err: unknown) => {
        button.disabled = false;
        alert(err instanceof Error ? err.message : String(err));
      });
  });
  return button;
}

function runsTable(runs: AdminRun[]): HTMLElement {
  if (runs.length === 0) return h('p', { className: 'empty', textContent: tab === 'review' ? 'Nothing to review.' : 'No runs yet.' });
  const body = runs.map((r) => {
    const actions = h('td', { className: 'actions' }, h('a', { href: `/?replay=${encodeURIComponent(r.id)}`, target: '_blank', textContent: 'Watch' }));
    if (r.score !== null && r.status !== 'ok') actions.append(action('Approve', () => call(`admin/runs/${r.id}`, { status: 'ok' })));
    if (r.score !== null && r.status !== 'void') actions.append(action('Void', () => call(`admin/runs/${r.id}`, { status: 'void' })));
    return h(
      'tr',
      {},
      h('td', {}, h('strong', { textContent: r.name }), h('br'), h('small', { textContent: r.email })),
      h('td', { className: 'num', textContent: r.score === null ? '–' : String(r.score) }),
      h('td', {}, h('span', { className: `status status-${r.status}`, textContent: r.status })),
      h('td', { className: 'flags', textContent: r.flags ?? '' }),
      h('td', { textContent: `${duration(r.steps)}${r.multiplier !== 1 ? ` · ${r.multiplier}x speed` : ''}${r.fast ? ' · fast start' : ''}${r.mobile ? ' · mobile' : ''}` }),
      h('td', { textContent: when(r.finished_at) }),
      actions,
    );
  });
  const head = ['Player', 'Score', 'Status', 'Why', 'Length', 'Finished', ''].map((t) => h('th', { textContent: t }));
  return h('div', { className: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ...head)), h('tbody', {}, ...body)));
}

function usersTable(users: AdminUser[]): HTMLElement {
  const body = users.map((u) =>
    h(
      'tr',
      {},
      h('td', {}, h('strong', { textContent: u.name }), h('br'), h('small', { textContent: u.email })),
      h('td', { className: 'num', textContent: u.best === null ? '–' : String(u.best) }),
      h('td', { className: 'num', textContent: String(u.runs) }),
      h(
        'td',
        { className: 'actions' },
        u.banned ? h('span', { className: 'status status-rejected', textContent: 'banned' }) : '',
        action(u.banned ? 'Unban' : 'Ban', () => call(`admin/users/${encodeURIComponent(u.id)}`, { banned: !u.banned })),
      ),
    ),
  );
  const head = ['Player', 'Best', 'Runs', ''].map((t) => h('th', { textContent: t }));
  return h('div', { className: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ...head)), h('tbody', {}, ...body)));
}

async function render(): Promise<void> {
  const me = await api.me().catch(() => null);
  if (!me?.admin) {
    root.replaceChildren(
      h('h1', { textContent: 'Dino 3D admin' }),
      me
        ? h('p', { textContent: `${me.email} is not an admin.` })
        : h('p', {}, h('a', { href: api.loginUrl('/admin'), textContent: 'Sign in with Microsoft' }), ' to continue.'),
    );
    return;
  }
  const tabs = h(
    'nav',
    {},
    ...(['review', 'all', 'users'] as const).map((t) => {
      const b = h('button', { type: 'button', textContent: t === 'review' ? 'In review' : t === 'all' ? 'All runs' : 'Players' });
      b.setAttribute('aria-pressed', String(t === tab));
      b.addEventListener('click', () => {
        tab = t;
        void render();
      });
      return b;
    }),
  );
  const content =
    tab === 'users'
      ? usersTable((await call<{ users: AdminUser[] }>('admin/users')).users)
      : runsTable((await call<{ runs: AdminRun[] }>(`admin/runs?status=${tab}`)).runs);
  root.replaceChildren(h('h1', {}, 'Dino 3D admin ', h('a', { href: '/', textContent: 'Back to the game' })), tabs, content);
}

void render();
