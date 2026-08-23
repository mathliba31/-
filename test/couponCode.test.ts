import { describe, expect, it } from 'vitest';
import { generateCouponCode } from '../lib/couponCode';

describe('generateCouponCode', () => {
  it('GACHA-接頭辞と8文字のランダム部分を持つ', () => {
    const code = generateCouponCode();
    expect(code).toMatch(/^GACHA-[A-Z0-9]{8}$/);
  });

  it('紛らわしい文字(I/O/0/1)を含まない', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateCouponCode();
      const suffix = code.slice('GACHA-'.length);
      expect(suffix).not.toMatch(/[IO01]/);
    }
  });

  it('連続生成しても十分にばらける', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateCouponCode()));
    expect(codes.size).toBe(200);
  });
});
