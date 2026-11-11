// The leaderboard Worker against an in-memory SQLite database with the real migrations, for
// tests that go through the HTTP API (worker/index.ts). Time comes from Date.now(), so tests
// move the clock with bun:test's setSystemTime.

import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import worker from '../worker/index';
import type { Env } from '../worker/env';
import { sha256 } from '../worker/http';

const ORIGIN = 'https://dino.test';
const MIGRATIONS = join(import.meta.dir, '..', 'migrations');

/** The slice of D1's API the Worker uses, over bun:sqlite. */
function d1(db: Database): D1Database {
  const statement = (sql: string, params: unknown[] = []) => {
    const exec = () => ({ meta: { changes: db.query(sql).run(...(params as never[])).changes } });
    return {
      bind: (...values: unknown[]) => statement(sql, values),
      first: async () => db.query(sql).get(...(params as never[])) ?? null,
      all: async () => ({ results: db.query(sql).all(...(params as never[])) }),
      run: async () => exec(),
      exec,
    };
  };
  return {
    prepare: (sql: string) => statement(sql),
    // Like D1, all or nothing: a failing statement throws out of the transaction, which rolls back.
    batch: async (statements: ReturnType<typeof statement>[]) => db.transaction(() => statements.map((s) => s.exec()))(),
  } as unknown as D1Database;
}

export interface TestWorker {
  db: Database;
  /** Signs a player up and in; returns their session token. */
  player(name: string, opts?: { admin?: boolean }): Promise<string>;
  /** Calls the API as the player with this token; resolves to the status and the JSON body. */
  call(token: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
}

export function createTestWorker(): TestWorker {
  const db = new Database(':memory:');
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  const env = { DB: d1(db), ORIGINS: ORIGIN, ADMIN_EMAILS: 'admin@dino.test' } as Env;
  return {
    db,
    async player(name, opts = {}) {
      const id = `user-${name}`;
      const email = opts.admin ? 'admin@dino.test' : `${name}@dino.test`;
      db.query('INSERT INTO users (id, name, email, created_at) VALUES (?, ?, ?, ?)').run(id, name, email, Date.now());
      const token = `token-${name}`;
      const sid = [...(await sha256(token))].map((b) => b.toString(16).padStart(2, '0')).join('');
      db.query('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(sid, id, Date.now() + 86400_000 * 365);
      return token;
    },
    async call(token, method, path, body) {
      const request = new Request(ORIGIN + path, {
        method,
        headers: { cookie: `__Host-dino-session=${token}`, origin: ORIGIN, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const res = await worker.fetch(request, env, {} as ExecutionContext);
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    },
  };
}
