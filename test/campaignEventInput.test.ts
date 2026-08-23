import { describe, expect, it } from 'vitest';
import { parseEventInput } from '../lib/campaignEventInput';

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    key: 'summer_2026',
    name: 'サマーガチャ2026',
    starts_at: '2026-08-01T00:00:00+09:00',
    ends_at: '2026-08-31T23:59:59+09:00',
    pity_threshold: 10,
    is_active: true,
    ...overrides,
  };
}

describe('parseEventInput', () => {
  it('正しい入力を受理する', () => {
    const result = parseEventInput(validInput());
    expect('value' in result).toBe(true);
    if ('value' in result) {
      expect(result.value.key).toBe('summer_2026');
      expect(result.value.pity_threshold).toBe(10);
      expect(result.value.is_active).toBe(true);
    }
  });

  it('pity_thresholdが未指定ならnullになる', () => {
    const result = parseEventInput(validInput({ pity_threshold: undefined }));
    expect('value' in result).toBe(true);
    if ('value' in result) {
      expect(result.value.pity_threshold).toBeNull();
    }
  });

  it('pity_thresholdが空文字ならnullになる', () => {
    const result = parseEventInput(validInput({ pity_threshold: '' }));
    expect('value' in result).toBe(true);
    if ('value' in result) {
      expect(result.value.pity_threshold).toBeNull();
    }
  });

  it('is_activeが未指定ならtrueになる', () => {
    const result = parseEventInput(validInput({ is_active: undefined }));
    expect('value' in result).toBe(true);
    if ('value' in result) {
      expect(result.value.is_active).toBe(true);
    }
  });

  it('keyに大文字や記号が含まれると invalid_key', () => {
    const result = parseEventInput(validInput({ key: 'Summer 2026!' }));
    expect(result).toEqual({ error: 'invalid_key' });
  });

  it('keyが空文字なら invalid_key', () => {
    const result = parseEventInput(validInput({ key: '' }));
    expect(result).toEqual({ error: 'invalid_key' });
  });

  it('nameが空文字なら invalid_name', () => {
    const result = parseEventInput(validInput({ name: '   ' }));
    expect(result).toEqual({ error: 'invalid_name' });
  });

  it('starts_atが不正な日付なら invalid_starts_at', () => {
    const result = parseEventInput(validInput({ starts_at: 'not-a-date' }));
    expect(result).toEqual({ error: 'invalid_starts_at' });
  });

  it('ends_atが不正な日付なら invalid_ends_at', () => {
    const result = parseEventInput(validInput({ ends_at: 'not-a-date' }));
    expect(result).toEqual({ error: 'invalid_ends_at' });
  });

  it('ends_atがstarts_at以前なら ends_at_must_be_after_starts_at', () => {
    const result = parseEventInput(
      validInput({ starts_at: '2026-08-31T00:00:00+09:00', ends_at: '2026-08-01T00:00:00+09:00' }),
    );
    expect(result).toEqual({ error: 'ends_at_must_be_after_starts_at' });
  });

  it('ends_atがstarts_atと同時刻でも ends_at_must_be_after_starts_at', () => {
    const result = parseEventInput(
      validInput({ starts_at: '2026-08-01T00:00:00+09:00', ends_at: '2026-08-01T00:00:00+09:00' }),
    );
    expect(result).toEqual({ error: 'ends_at_must_be_after_starts_at' });
  });

  it('pity_thresholdが0以下なら invalid_pity_threshold', () => {
    const result = parseEventInput(validInput({ pity_threshold: 0 }));
    expect(result).toEqual({ error: 'invalid_pity_threshold' });
  });

  it('pity_thresholdが整数でなければ invalid_pity_threshold', () => {
    const result = parseEventInput(validInput({ pity_threshold: 3.5 }));
    expect(result).toEqual({ error: 'invalid_pity_threshold' });
  });
});
