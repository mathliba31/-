import { createHmac } from 'crypto';
import { describe, expect, it } from 'vitest';
import { verifyAppProxySignature, getLoggedInCustomerId } from '../lib/appProxyAuth';

const SECRET = 'test-secret';

function sign(params: Record<string, string | string[]>): string {
  const keys = Object.keys(params).sort();
  const message = keys
    .map((key) => {
      const value = params[key];
      const joined = Array.isArray(value) ? value.join(',') : value;
      return `${key}=${joined}`;
    })
    .join('');
  return createHmac('sha256', SECRET).update(message, 'utf8').digest('hex');
}

describe('verifyAppProxySignature', () => {
  it('正しい署名を検証できる', () => {
    const params = {
      shop: 'xxxx.myshopify.com',
      path_prefix: '/apps/gacha',
      logged_in_customer_id: '123456789',
      timestamp: '1700000000',
    };
    const signature = sign(params);

    expect(verifyAppProxySignature({ ...params, signature }, SECRET)).toBe(true);
  });

  it('署名が無い場合はfalse', () => {
    const params = { shop: 'xxxx.myshopify.com' };
    expect(verifyAppProxySignature(params, SECRET)).toBe(false);
  });

  it('パラメータが改ざんされた場合はfalse', () => {
    const params = {
      shop: 'xxxx.myshopify.com',
      logged_in_customer_id: '123456789',
    };
    const signature = sign(params);

    expect(
      verifyAppProxySignature({ ...params, logged_in_customer_id: '999999999', signature }, SECRET),
    ).toBe(false);
  });

  it('署名が他の秘密鍵で計算された場合はfalse', () => {
    const params = { shop: 'xxxx.myshopify.com' };
    const keys = Object.keys(params).sort();
    const message = keys.map((k) => `${k}=${(params as Record<string, string>)[k]}`).join('');
    const wrongSignature = createHmac('sha256', 'wrong-secret').update(message, 'utf8').digest('hex');

    expect(verifyAppProxySignature({ ...params, signature: wrongSignature }, SECRET)).toBe(false);
  });

  it('同じキーが複数ある場合はカンマ結合して検証する', () => {
    const params = { ids: ['1', '2', '3'] };
    const signature = sign(params);
    expect(verifyAppProxySignature({ ...params, signature }, SECRET)).toBe(true);
  });

  it('キーの順序に依存しない(内部でソートする)', () => {
    const params = { b: '2', a: '1', c: '3' };
    const signature = sign(params);
    // オブジェクトのプロパティ順を変えても結果は同じになるはず
    expect(verifyAppProxySignature({ c: '3', a: '1', b: '2', signature }, SECRET)).toBe(true);
  });
});

describe('getLoggedInCustomerId', () => {
  it('値が存在すればそのまま返す', () => {
    expect(getLoggedInCustomerId({ logged_in_customer_id: '123' })).toBe('123');
  });

  it('空文字の場合はnullを返す(未ログイン)', () => {
    expect(getLoggedInCustomerId({ logged_in_customer_id: '' })).toBeNull();
  });

  it('パラメータが無い場合はnullを返す', () => {
    expect(getLoggedInCustomerId({})).toBeNull();
  });

  it('配列の場合はnullを返す(不正な入力)', () => {
    expect(getLoggedInCustomerId({ logged_in_customer_id: ['123', '456'] })).toBeNull();
  });
});
