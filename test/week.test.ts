import { describe, expect, it } from 'vitest';
import { computeWeekStart } from '../lib/week';

describe('computeWeekStart', () => {
  it('月曜始まり: 水曜日はその週の月曜日を返す', () => {
    // 2026-08-19 は水曜日
    const wed = new Date('2026-08-19T10:00:00Z');
    expect(computeWeekStart(wed, 1)).toBe('2026-08-17'); // 月曜
  });

  it('月曜始まり: 日曜日は前の月曜日を返す(週をまたがない)', () => {
    // 2026-08-23 は日曜日
    const sun = new Date('2026-08-23T23:59:59Z');
    expect(computeWeekStart(sun, 1)).toBe('2026-08-17');
  });

  it('月曜始まり: 月曜日当日は自分自身を返す', () => {
    const mon = new Date('2026-08-17T00:00:01Z');
    expect(computeWeekStart(mon, 1)).toBe('2026-08-17');
  });

  it('翌週の月曜になるとリセットされる', () => {
    const nextMon = new Date('2026-08-24T00:00:01Z');
    expect(computeWeekStart(nextMon, 1)).toBe('2026-08-24');
  });
});
