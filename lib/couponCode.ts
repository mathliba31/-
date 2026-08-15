import { randomInt } from 'crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 紛らわしい文字(I/O/0/1)を除外

export function generateCouponCode(): string {
  let suffix = '';
  for (let i = 0; i < 8; i++) {
    suffix += ALPHABET[randomInt(ALPHABET.length)];
  }
  return `GACHA-${suffix}`;
}
