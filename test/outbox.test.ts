import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { ApiError, type FinishResult } from '../src/net/api';
import { createOutbox, retryable, type Upload } from '../src/net/outbox';

const VERDICT: FinishResult = { status: 'ok', score: 120, previousBest: null, rank: 1 };

/** An outbox whose sends answer from `answers` in turn (an Error is thrown); waits are noted, not slept. */
function harness(answers: (FinishResult | null | Error)[] = []) {
  const sent: [string, Upload][] = [];
  const waits: number[] = [];
  const refused: unknown[] = [];
  const outbox = createOutbox({
    send: async (id, upload) => {
      sent.push([id, upload]);
      const answer = answers.shift() ?? (upload.kind === 'finish' ? VERDICT : null);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    onRefused: (err) => refused.push(err),
    sleep: async (ms) => void waits.push(ms),
  });
  return { outbox, sent, waits, refused };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => setSystemTime());

describe('outbox', () => {
  test('holds uploads until the run has its id, then sends them numbered and in order', async () => {
    const { outbox, sent } = harness();
    outbox.push('pause', 3, [0, 3, 1, 2]);
    outbox.push('resume', 3, []);
    await settle();
    expect(sent).toEqual([]);
    outbox.start('run1');
    outbox.push('tick', 600, [10, 0]);
    outbox.push('finish', 700, [650, 3], { hi: 0 } as never);
    expect(await outbox.finished()).toEqual(VERDICT);
    expect(sent.map(([id, u]) => [id, u.seq, u.kind, u.steps])).toEqual([
      ['run1', 1, 'pause', 3],
      ['run1', 2, 'resume', 3],
      ['run1', 3, 'tick', 600],
      ['run1', 4, 'finish', 700],
    ]);
  });

  test('sends a failed upload again, unchanged, with growing waits', async () => {
    const { outbox, sent, waits } = harness([new TypeError('Failed to fetch'), new ApiError(429, 'slow down'), new ApiError(503, 'busy'), null]);
    outbox.start('run1');
    outbox.push('tick', 600, [10, 0]);
    outbox.push('finish', 700, [], { hi: 0 } as never);
    expect(await outbox.finished()).toEqual(VERDICT);
    expect(sent.map(([, u]) => u.seq)).toEqual([1, 1, 1, 1, 2]);
    expect(sent[0][1]).toBe(sent[3][1]);
    expect(waits).toEqual([500, 1000, 2000]);
  });

  test('stops when the server refuses an upload for good', async () => {
    const { outbox, sent, refused } = harness([new ApiError(400, 'resume without a pause')]);
    outbox.start('run1');
    outbox.push('resume', 3, []);
    outbox.push('finish', 700, [], { hi: 0 } as never);
    expect(await outbox.finished()).toBeNull();
    expect(sent).toHaveLength(1);
    expect(refused).toEqual([new ApiError(400, 'resume without a pause')]);
  });

  test('gives up on a finish that does not get through within a minute', async () => {
    let now = 1_800_000_000_000;
    setSystemTime(new Date(now));
    let tries = 0;
    const outbox = createOutbox({
      send: async () => {
        tries++;
        throw new TypeError('Failed to fetch');
      },
      onRefused: () => undefined,
      // Each wait moves the clock on by itself.
      sleep: async (ms) => {
        now += ms;
        setSystemTime(new Date(now));
      },
    });
    outbox.start('run1');
    outbox.push('finish', 700, [], { hi: 0 } as never);
    expect(await outbox.finished()).toBeNull();
    // Tries at 0, 0.5, 1.5, 3.5, 7.5 s, then every 8 s; the one at 63.5 s is the last.
    expect(tries).toBe(12);
  });

  test('retries only what may go through', () => {
    for (const err of [new TypeError('Failed to fetch'), new DOMException('timed out', 'TimeoutError'), new ApiError(0, 'no leaderboard server'), new ApiError(409, 'x'), new ApiError(429, 'x'), new ApiError(500, 'x')]) {
      expect(retryable(err)).toBe(true);
    }
    for (const status of [400, 401, 403, 404, 410]) expect(retryable(new ApiError(status, 'x'))).toBe(false);
  });
});
