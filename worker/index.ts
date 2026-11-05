// The leaderboard server: a Cloudflare Worker in front of the game's static build. /api/* is
// handled here, everything else is served from dist/ (see wrangler.jsonc).

import { allowedOrigins, callback, currentUser, devLogin, login, logout } from './auth';
import { adminRuns, adminSetRun, adminSetUser, adminUsers, leaderboard } from './board';
import type { Env } from './env';
import { HttpError, json } from './http';
import { beat, deleteRuns, finishRun, getRun, myRuns, startRun } from './runs';

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  const { method } = request;
  const path = url.pathname;
  // Cookies are SameSite=Lax; checking Origin on top keeps every write same-origin.
  if (method !== 'GET' && !allowedOrigins(env).includes(request.headers.get('origin') ?? '')) throw new HttpError(403, 'cross-origin request');

  if (method === 'GET' && path === '/api/auth/login') return login(url, env);
  if (method === 'GET' && path === '/api/auth/callback') return callback(url, env);
  if (method === 'GET' && path === '/api/auth/dev') return devLogin(url, env);
  if (method === 'POST' && path === '/api/auth/logout') return logout(request, env);
  if (method === 'GET' && path === '/api/me') {
    const user = await currentUser(request, env);
    return json({ user: user && { name: user.name, email: user.email, admin: user.admin, banned: user.banned } });
  }
  if (method === 'GET' && path === '/api/leaderboard') return leaderboard(request, env);
  if (method === 'POST' && path === '/api/runs') return startRun(request, env);
  if (method === 'POST' && path === '/api/runs/delete') return deleteRuns(request, env);
  if (method === 'GET' && path === '/api/runs/mine') return myRuns(request, env);
  if (method === 'GET' && path === '/api/admin/runs') return adminRuns(request, env, url);
  if (method === 'GET' && path === '/api/admin/users') return adminUsers(request, env);

  let m = /^\/api\/runs\/([\w-]+)(\/beat|\/finish)?$/.exec(path);
  if (m) {
    if (method === 'GET' && !m[2]) return getRun(request, env, m[1]);
    if (method === 'POST' && m[2] === '/beat') return beat(request, env, m[1]);
    if (method === 'POST' && m[2] === '/finish') return finishRun(request, env, m[1]);
  }
  m = /^\/api\/admin\/(runs|users)\/([\w.@-]+)$/.exec(path);
  if (m && method === 'POST') return m[1] === 'runs' ? adminSetRun(request, env, m[2]) : adminSetUser(request, env, m[2]);
  throw new HttpError(404, 'not found');
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await route(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: 'internal error' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
