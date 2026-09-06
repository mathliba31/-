import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../../lib/supabaseAdmin';
import { issueCouponForDraw } from '../../lib/issueCoupon';
import { isAdminAuthorized } from '../../lib/adminAuth';
import type { DiscountType, PrizeInfo } from '../../lib/types';

const BATCH_LIMIT = 20;

interface MissingCouponDraw {
  draw_id: string;
  shopify_customer_id: string;
  prize_id: number;
  prize_name: string;
  shopify_variant_id: string;
  discount_type: DiscountType;
  discount_value: number;
  list_price: number;
}

/**
 * 抽選(draws)は成立しているがクーポン発行(coupons)に失敗して未発行のままの行を
 * 検出し、Shopifyでのクーポン発行を再試行する。
 * POST /api/proxy/draw は同じ idempotency_key の再送で自己修復するが、
 * クライアントが二度と再送してこないケースをこの管理APIで拾う。
 *
 * body: { draw_id?: string } — 指定時はその抽選のみ対象。未指定時は未発行分をまとめて処理。
 *
 * 未発行分の検出はDB側(find_draws_missing_coupon)で行う。以前はアプリ側で
 * 「作成日時が古い順にBATCH_LIMIT件取得してからJSでクーポン未発行分を絞り込む」実装に
 * なっており、drawsがBATCH_LIMIT件を超えると常に空配列になっていた
 * (古い行は通常のフローで既にクーポン発行済みのため)。
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  if (!isAdminAuthorized(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const body = (req.body ?? {}) as { draw_id?: unknown };
  const drawId = typeof body.draw_id === 'string' ? body.draw_id : null;

  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase.rpc('find_draws_missing_coupon', {
    p_draw_id: drawId,
    p_limit: BATCH_LIMIT,
  });
  if (error) {
    console.error('reissue: find_draws_missing_coupon error', error);
    return res.status(500).json({ error: 'internal_error' });
  }

  const targets = (data ?? []) as MissingCouponDraw[];

  const results = [];
  for (const draw of targets) {
    const prize: PrizeInfo = {
      id: draw.prize_id,
      name: draw.prize_name,
      shopifyVariantId: draw.shopify_variant_id,
      discountType: draw.discount_type,
      discountValue: draw.discount_value,
      listPrice: draw.list_price,
    };
    try {
      const coupon = await issueCouponForDraw({
        supabase,
        drawId: draw.draw_id,
        shopifyCustomerId: draw.shopify_customer_id,
        prize,
      });
      results.push({ draw_id: draw.draw_id, status: 'issued', code: coupon.code });
    } catch (err) {
      console.error('reissue: coupon issuance failed', draw.draw_id, err);
      results.push({ draw_id: draw.draw_id, status: 'failed', error: err instanceof Error ? err.message : 'unknown' });
    }
  }

  return res.status(200).json({ processed: results.length, results });
}
