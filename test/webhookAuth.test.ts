import { createHmac } from 'crypto';
import { describe, expect, it } from 'vitest';
import { verifyWebhookHmac } from '../lib/webhookAuth';

const SECRET = 'test-secret';

describe('verifyWebhookHmac', () => {
  it('正しいHMACを検証できる', () => {
    const body = JSON.stringify({ id: 1, foo: 'bar' });
    const hmac = createHmac('sha256', SECRET).update(body).digest('base64');
    expect(verifyWebhookHmac(body, hmac, SECRET)).toBe(true);
  });

  it('ボディが改ざんされた場合はfalse', () => {
    const body = JSON.stringify({ id: 1, foo: 'bar' });
    const hmac = createHmac('sha256', SECRET).update(body).digest('base64');
    const tamperedBody = JSON.stringify({ id: 2, foo: 'bar' });
    expect(verifyWebhookHmac(tamperedBody, hmac, SECRET)).toBe(false);
  });

  it('ヘッダが無い場合はfalse', () => {
    const body = JSON.stringify({ id: 1 });
    expect(verifyWebhookHmac(body, undefined, SECRET)).toBe(false);
  });

  it('異なるシークレットで計算されたHMACはfalse', () => {
    const body = JSON.stringify({ id: 1 });
    const hmac = createHmac('sha256', 'wrong-secret').update(body).digest('base64');
    expect(verifyWebhookHmac(body, hmac, SECRET)).toBe(false);
  });

  it('Bufferのrawボディでも検証できる', () => {
    const body = Buffer.from(JSON.stringify({ id: 1 }), 'utf8');
    const hmac = createHmac('sha256', SECRET).update(body).digest('base64');
    expect(verifyWebhookHmac(body, hmac, SECRET)).toBe(true);
  });
});
