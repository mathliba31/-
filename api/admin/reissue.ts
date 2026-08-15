import type { VercelRequest, VercelResponse } from '@vercel/node';
import { timingSafeEqual } from 'crypto';
import { env } from '../../lib/env';
import { getSupabaseAdmin } from '../../lib/supabaseAdmin';
import { issueCouponForDraw } from '../../lib/issueCoupon';
import type { DiscountType, PrizeInfo } from '../../lib/types';

const BATCH_LIMIT = 20;

function isAuthorized(req: VercelRequest): boolean {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  if (!token) return false;

  const expected = Buffer.from(env.adminApiSecret, 'utf8');
  const actual = Buffer.from(token, 'utf8');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

interface DrawWithPrize {
  id: string;
  shopify_customer_id: string;
  prize_id: number;
  prizes: {
    name: string;
    shopify_variant_id: string;
    discount_type: DiscountType;
    discount_value: number;
    list_price: number;
  } | null;
  coupons: { id: number }[];
}

/**
 * 抽選(draws)は成立しているがクーポン発行(coupons)に失敗して未発行のままの行を
 * 検出し、Shopifyでのクーポン発行を再試行する。
 * POST /api/proxy/draw は同じ idempotency_key の再送で自己修復するが、
 * クライアントが二度と再送してこないケースをこの管理APIで拾う。
 *
 * body: { draw_id?: string } — 指定時はその抽選のみ対象。未指定時は未発行分をまとめて処理。
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const body = (req.body ?? {}) as { draw_id?: unknown };
  const drawId = typeof body.draw_id === 'string' ? body.draw_id : undefined;

  const supabase = getSupabaseAdmin();

  let query = supabase
    .from('draws')
    .select('id, shopify_customer_id, prize_id, prizes(name, shopify_variant_id, discount_type, discount_value, list_price), coupons(id)')
    .order('created_at', { ascending: true })
    .limit(BATCH_LIMIT);

  if (drawId) {
    query = query.eq('id', drawId);
  }

  const { data, error } = await query;
  if (error) {
    console.error('reissue: draws query error', error);
    return res.status(500).json({ error: 'internal_error' });
  }

  const targets = ((data ?? []) as unknown as DrawWithPrize[]).filter((d) => d.coupons.length === 0);

  const results = [];
  for (const draw of targets) {
    if (!draw.prizes) {
      results.push({ draw_id: draw.id, status: 'skipped', reason: 'prize_not_found' });
      continue;
    }
    const prize: PrizeInfo = {
      id: draw.prize_id,
      name: draw.prizes.name,
      shopifyVariantId: draw.prizes.shopify_variant_id,
      discountType: draw.prizes.discount_type,
      discountValue: draw.prizes.discount_value,
      listPrice: draw.prizes.list_price,
    };
    try {
      const coupon = await issueCouponForDraw({
        supabase,
        drawId: draw.id,
        shopifyCustomerId: draw.shopify_customer_id,
        prize,
      });
      results.push({ draw_id: draw.id, status: 'issued', code: coupon.code });
    } catch (err) {
      console.error('reissue: coupon issuance failed', draw.id, err);
      results.push({ draw_id: draw.id, status: 'failed', error: err instanceof Error ? err.message : 'unknown' });
    }
  }

  return res.status(200).json({ processed: results.length, results });
}
