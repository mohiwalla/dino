// Sign-in with Microsoft Entra ID (single-tenant: only the configured tenant's accounts get in).
// Authorization code flow with PKCE, done here on the server; the browser only ever holds an
// HttpOnly session cookie.

import { boardChanged } from './board';
import type { Env } from './env';
import { base64url, base64urlDecode, cookie, HttpError, json, randomToken, sha256 } from './http';

const SESSION_COOKIE = '__Host-dino-session';
const SESSION_DAYS = 30;
const LOGIN_STATE_MS = 10 * 60 * 1000;

export interface User {
  id: string;
  name: string;
  email: string;
  banned: boolean;
  admin: boolean;
}

function authority(env: Env): string {
  return `https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}`;
}

export function allowedOrigins(env: Env): string[] {
  return env.ORIGINS.split(',').map((o) => o.trim());
}

/** The configured origin the request came in on (the first one if it matches none). */
function siteOrigin(url: URL, env: Env): string {
  const origins = allowedOrigins(env);
  return origins.includes(url.origin) ? url.origin : origins[0];
}

function redirectUri(url: URL, env: Env): string {
  return `${siteOrigin(url, env)}/api/auth/callback`;
}

/** Only same-site page paths; anything else goes back to the game. */
function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/api/') ? next : '/';
}

function isAdmin(env: Env, email: string): boolean {
  return env.ADMIN_EMAILS.split(',').some((e) => e.trim().toLowerCase() === email.toLowerCase());
}

async function sessionId(token: string): Promise<string> {
  return [...(await sha256(token))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function currentUser(request: Request, env: Env): Promise<User | null> {
  const token = cookie(request, SESSION_COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.name, u.email, u.banned FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > ?`,
  )
    .bind(await sessionId(token), Date.now())
    .first<{ id: string; name: string; email: string; banned: number }>();
  if (!row) return null;
  return { id: row.id, name: row.name, email: row.email, banned: row.banned === 1, admin: isAdmin(env, row.email) };
}

export async function requireUser(request: Request, env: Env): Promise<User> {
  const user = await currentUser(request, env);
  if (!user) throw new HttpError(401, 'sign in first');
  return user;
}

async function startSession(url: URL, env: Env, userId: string, next: string): Promise<Response> {
  const token = randomToken();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').bind(
      await sessionId(token),
      userId,
      now + SESSION_DAYS * 86400_000,
    ),
  ]);
  return new Response(null, {
    status: 302,
    headers: {
      location: siteOrigin(url, env) + next,
      'set-cookie': `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`,
    },
  });
}

async function upsertUser(env: Env, id: string, name: string, email: string): Promise<void> {
  const renamed = await env.DB.prepare('SELECT 1 FROM users WHERE id = ? AND name != ?').bind(id, name).first();
  await env.DB.prepare(
    `INSERT INTO users (id, name, email, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, email = excluded.email`,
  )
    .bind(id, name, email, Date.now())
    .run();
  // The boards show names.
  if (renamed) await boardChanged(env).run();
}

/** GET /api/auth/login?next=/path: off to Microsoft. */
export async function login(url: URL, env: Env): Promise<Response> {
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM login_states WHERE expires_at < ?').bind(now),
    env.DB.prepare('INSERT INTO login_states (state, verifier, nonce, next, expires_at) VALUES (?, ?, ?, ?, ?)').bind(
      state,
      verifier,
      nonce,
      safeNext(url.searchParams.get('next')),
      now + LOGIN_STATE_MS,
    ),
  ]);
  const authorize = new URL(`${authority(env)}/oauth2/v2.0/authorize`);
  authorize.search = new URLSearchParams({
    client_id: env.ENTRA_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri(url, env),
    response_mode: 'query',
    scope: 'openid profile email',
    state,
    nonce,
    code_challenge: base64url(await sha256(verifier)),
    code_challenge_method: 'S256',
  }).toString();
  return Response.redirect(authorize.toString(), 302);
}

interface IdClaims {
  iss?: string;
  aud?: string;
  tid?: string;
  oid?: string;
  nonce?: string;
  exp?: number;
  name?: string;
  preferred_username?: string;
  email?: string;
}

/** GET /api/auth/callback: Microsoft sends the browser back here with a code. */
export async function callback(url: URL, env: Env): Promise<Response> {
  const error = url.searchParams.get('error');
  if (error) throw new HttpError(400, `sign-in failed: ${url.searchParams.get('error_description') ?? error}`);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) throw new HttpError(400, 'missing code or state');
  const pending = await env.DB.prepare('DELETE FROM login_states WHERE state = ? AND expires_at > ? RETURNING verifier, nonce, next')
    .bind(state, Date.now())
    .first<{ verifier: string; nonce: string; next: string }>();
  if (!pending) throw new HttpError(400, 'sign-in expired, try again');

  const tokenResponse = await fetch(`${authority(env)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.ENTRA_CLIENT_ID,
      client_secret: env.ENTRA_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(url, env),
      code_verifier: pending.verifier,
    }),
  });
  const tokens = (await tokenResponse.json()) as { id_token?: string; error_description?: string };
  if (!tokenResponse.ok || !tokens.id_token) throw new HttpError(502, `sign-in failed: ${tokens.error_description ?? tokenResponse.status}`);

  // The ID token came straight from Microsoft's token endpoint over TLS, authenticated with our
  // client secret, so its signature does not need checking (OIDC Core 3.1.3.7); its claims do.
  const claims = JSON.parse(new TextDecoder().decode(base64urlDecode(tokens.id_token.split('.')[1]))) as IdClaims;
  const valid =
    claims.iss === `${authority(env)}/v2.0` &&
    claims.aud === env.ENTRA_CLIENT_ID &&
    claims.tid === env.ENTRA_TENANT_ID &&
    claims.nonce === pending.nonce &&
    typeof claims.exp === 'number' &&
    claims.exp * 1000 > Date.now() &&
    typeof claims.oid === 'string';
  if (!valid) throw new HttpError(403, 'this account cannot sign in here');

  const email = claims.email ?? claims.preferred_username ?? '';
  await upsertUser(env, claims.oid!, claims.name || email || 'Player', email);
  return startSession(url, env, claims.oid!, pending.next);
}

/** GET /api/auth/dev?name=Alice: local testing only, see Env.DEV_LOGIN. */
export async function devLogin(url: URL, env: Env): Promise<Response> {
  if (env.DEV_LOGIN !== '1' || !allowedOrigins(env).every((o) => o.startsWith('http://localhost'))) throw new HttpError(404, 'not found');
  const name = url.searchParams.get('name') || 'Dev Player';
  const email = url.searchParams.get('email') || `${name.toLowerCase().replace(/\W+/g, '.')}@dev.local`;
  const id = `dev-${email}`;
  await upsertUser(env, id, name, email);
  return startSession(url, env, id, safeNext(url.searchParams.get('next')));
}

const CLEAR_SESSION = `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

/** POST /api/auth/logout */
export async function logout(request: Request, env: Env): Promise<Response> {
  const token = cookie(request, SESSION_COOKIE);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(await sessionId(token)).run();
  return json({ ok: true }, 200, { 'set-cookie': CLEAR_SESSION });
}
