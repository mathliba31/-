import type { IncomingMessage } from 'http';

// Webhook HMAC検証には生のリクエストボディが必要なため、
// 該当エンドポイントでは `export const config = { api: { bodyParser: false } } を設定し、
// このユーティリティで自前に読み取る。
export function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
