import { describe, expect, test } from 'bun:test';
import { weekStart } from '../worker/board';

describe('weekly board', () => {
  test('a week starts Monday 00:00 India time', () => {
    const monday = Date.parse('2026-11-01T18:30:00Z'); // Mon 2 Nov, 00:00 IST
    expect(weekStart(Date.parse('2026-11-05T15:30:00Z'))).toBe(monday); // Thu 21:00 IST
    expect(weekStart(monday)).toBe(monday);
    expect(weekStart(monday - 1)).toBe(monday - 7 * 24 * 60 * 60 * 1000); // Sun 23:59:59.999 IST
    expect(weekStart(Date.parse('2026-11-08T18:29:59Z'))).toBe(monday); // Sun 23:59:59 IST, same week
  });
});
