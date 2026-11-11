// A ranked run's uploads, in order. Each one is captured the moment it happens (the steps and the
// inputs recorded by then) and numbered, then sent one at a time; a failure that may pass (no
// connection, a timeout, a busy or rate-limited server) is retried with the very same upload, so
// the server can tell a resend from a new one. Uploads wait until the run has its server id.

import type { UploadKind } from '../sim/replay';
import type { RunLook } from '../types';
import { ApiError, type FinishResult } from './api';

export interface Upload {
  seq: number;
  kind: UploadKind;
  steps: number;
  inputs: number[];
  /** Only on the finish. */
  look?: RunLook;
}

export interface OutboxOptions {
  /** Sends one upload; a finish resolves to the server's verdict. */
  send(id: string, upload: Upload): Promise<FinishResult | null>;
  /** The server refused an upload for good: the run stops counting. */
  onRefused(err: unknown): void;
  /** Waits before a retry (tests replace it). */
  sleep?: (ms: number) => Promise<void>;
}

export interface Outbox {
  push(kind: UploadKind, steps: number, inputs: number[], look?: RunLook): void;
  /** The run has its id: send what is queued, and everything after. */
  start(id: string): void;
  /** Resolves once the finish is accepted, to its verdict; null if it never got through. */
  finished(): Promise<FinishResult | null>;
  stop(): void;
}

const FIRST_RETRY_MS = 500;
const MAX_RETRY_MS = 8000;
/** A finish that hasn't got through after this long is given up on. */
const FINISH_GIVE_UP_MS = 60_000;

/** Whether a failed upload may go through if sent again. */
export function retryable(err: unknown): boolean {
  if (!(err instanceof ApiError)) return true; // no connection, or the request timed out
  // 0: an HTML error page in front of the server; 409: the run changed under it (the resend then reads as a repeat).
  return err.status === 0 || err.status === 409 || err.status === 429 || err.status >= 500;
}

export function createOutbox(opts: OutboxOptions): Outbox {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const queue: Upload[] = [];
  let seq = 0;
  let id: string | null = null;
  let stopped = false;
  let sending = false;
  let finishedAt = 0;
  let settle: (result: FinishResult | null) => void = () => undefined;
  const result = new Promise<FinishResult | null>((resolve) => (settle = resolve));

  function stop(): void {
    stopped = true;
    queue.length = 0;
    settle(null);
  }

  async function flush(): Promise<void> {
    if (sending || id === null) return;
    sending = true;
    let wait = FIRST_RETRY_MS;
    while (!stopped && queue.length > 0) {
      const upload = queue[0];
      try {
        const answer = await opts.send(id, upload);
        if (stopped) break;
        queue.shift();
        wait = FIRST_RETRY_MS;
        if (upload.kind === 'finish') settle(answer);
      } catch (err) {
        if (stopped) break;
        if (!retryable(err)) {
          stop();
          opts.onRefused(err);
          break;
        }
        if (finishedAt > 0 && Date.now() - finishedAt > FINISH_GIVE_UP_MS) {
          stop();
          break;
        }
        await sleep(wait);
        wait = Math.min(wait * 2, MAX_RETRY_MS);
      }
    }
    sending = false;
  }

  return {
    push(kind, steps, inputs, look) {
      if (stopped) return;
      queue.push({ seq: ++seq, kind, steps, inputs, ...(look ? { look } : {}) });
      if (kind === 'finish') finishedAt = Date.now();
      void flush();
    },
    start(runId) {
      id = runId;
      void flush();
    },
    finished: () => result,
    stop,
  };
}
