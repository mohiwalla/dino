// The leaderboard server's HTTP API (worker/), same origin as the game.

import type { RunLook } from '../types';

export interface Account {
  name: string;
  email: string;
  admin: boolean;
  banned: boolean;
}

export interface BoardEntryData {
  rank: number;
  name: string;
  score: number;
  mobile: boolean;
  fast: boolean;
  multiplier: number;
  runId: string;
  me: boolean;
}

export interface BoardList {
  entries: BoardEntryData[];
  me: { rank: number; score: number } | null;
  players: number;
}

/** All time at the top level, this week (Monday to Sunday, India time) under `week`. */
export interface BoardData extends BoardList {
  week?: BoardList;
  /** Last week's top 3, and whether they are still news (the first days of the week). */
  lastWeek?: BoardEntryData[];
  announce?: boolean;
}

export interface FinishResult {
  status: 'ok' | 'review' | 'rejected';
  score: number | null;
  previousBest: number | null;
  rank: number | null;
}

export interface StoredRun {
  id: string;
  name: string;
  score: number | null;
  seed: number;
  mobile: boolean;
  afterCrash: boolean;
  fast: boolean;
  multiplier: number;
  simVersion: number;
  steps: number;
  inputs: number[];
  /** How the run looked and sounded to its player; null for runs from before it was saved. */
  look: RunLook | null;
  /** The player cheered this run as a new best. */
  cheered: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  // A static host without the server answers /api/* with the game's HTML (or a 404 page).
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) throw new ApiError(0, 'no leaderboard server');
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
  return data;
}

export const api = {
  me: () => call<{ user: Account | null }>('me').then((r) => r.user),
  leaderboard: () => call<BoardData>('leaderboard'),
  startRun: (body: { mobile: boolean; afterCrash: boolean; multiplier: number; simVersion: number }) => call<{ id: string; seed: number }>('runs', body),
  beat: (id: string, body: { steps: number; inputs: number[] }) => call<{ ok: true }>(`runs/${id}/beat`, body),
  finish: (id: string, body: { steps: number; inputs: number[]; look: RunLook }) => call<FinishResult>(`runs/${id}/finish`, body),
  run: (id: string) => call<StoredRun>(`runs/${encodeURIComponent(id)}`),
  logout: () => call<{ ok: true }>('auth/logout', {}),
  deleteRuns: () => call<{ ok: true }>('runs/delete', {}),
  loginUrl: (next: string) => `/api/auth/login?next=${encodeURIComponent(next)}`,
};
