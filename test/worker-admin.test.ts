import { describe, expect, test } from 'bun:test';
import { createTestWorker, type TestWorker } from './worker-api';

/** Adds `n` finished runs for the player, one a second, the newest last. */
function seed(w: TestWorker, player: string, n: number, status = 'ok'): void {
  for (let i = 0; i < n; i++) {
    w.db
      .query(`INSERT INTO runs (id, user_id, seed, mobile, after_crash, sim_version, started_at, finished_at, steps, beats, score, status) VALUES (?, ?, 1, 0, 0, 3, ?, ?, 60, '[]', ?, ?)`)
      .run(`${player}-${i}`, `user-${player}`, 1000 + i * 1000, 1000 + i * 1000, i, status);
  }
}

describe('admin run lists', () => {
  test('come a page at a time, newest first, with the total', async () => {
    const w = createTestWorker();
    const admin = await w.player('root', { admin: true });
    await w.player('ana');
    seed(w, 'ana', 120);
    const page = async (p: number) => (await w.call(admin, 'GET', `/api/admin/runs?status=all&page=${p}`)).body as { runs: { id: string }[]; total: number; page: number; pageSize: number };
    const first = await page(1);
    expect(first).toMatchObject({ total: 120, page: 1, pageSize: 50 });
    expect(first.runs).toHaveLength(50);
    expect(first.runs[0].id).toBe('ana-119');
    const last = await page(3);
    expect(last.runs.map((r) => r.id)).toEqual(Array.from({ length: 20 }, (_, i) => `ana-${19 - i}`));
    // Every run is reachable: the old list stopped at the newest 200.
    expect((await page(4)).runs).toEqual([]);
  });

  test('search every run by player name or email, taking % and _ literally', async () => {
    const w = createTestWorker();
    const admin = await w.player('root', { admin: true });
    await w.player('ana');
    await w.player('bo_b');
    seed(w, 'ana', 70);
    seed(w, 'bo_b', 3, 'review');
    const search = async (q: string, status = 'all') => (await w.call(admin, 'GET', `/api/admin/runs?status=${status}&q=${encodeURIComponent(q)}`)).body as { runs: { id: string }[]; total: number };
    expect((await search('ANA')).total).toBe(70);
    expect((await search('bo_b@dino')).total).toBe(3);
    expect((await search('o_b', 'review')).total).toBe(3);
    // A literal underscore doesn't match any character, and % isn't a wildcard.
    expect((await search('a_a')).total).toBe(0);
    expect((await search('%')).total).toBe(0);
    expect((await search('bob')).total).toBe(0);
  });
});
