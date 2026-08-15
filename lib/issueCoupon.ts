import type { SupabaseClient } from '@supabase/supabase-js';
import { createDiscountCodeForPrize } from './shopifyAdmin';
import type { CouponInfo, PrizeInfo } from './types';

async function getCouponValidDays(supabase: SupabaseClient): Promise<number> {
  const { data, error } = await supabase.from('settings').select('value').eq('key', 'coupon_valid_days').single();
  if (error || !data) {
    return 14;
  }
  const value = Number(data.value);
  return Number.isFinite(value) && value > 0 ? value : 14;
}

/**
 * 抽選成立済み(draws挿入済み)だがクーポン未発行のケースに対して、
 * Shopifyでクーポンを発行し coupons テーブルへ記録する。
 * POST /api/proxy/draw の通常フローと POST /api/admin/reissue の両方から使う。
 *
 * draws.id はユニークなので、既に発行済みなら coupons.draw_id の一意制約により
 * 重複挿入は起きない(呼び出し前に coupons を確認してこの関数を呼ばないのが基本だが、
 * 競合が起きても安全なようにしている)。
 */
export async function issueCouponForDraw(params: {
  supabase: SupabaseClient;
  drawId: string;
  shopifyCustomerId: string;
  prize: PrizeInfo;
}): Promise<CouponInfo> {
  const { supabase, drawId, shopifyCustomerId, prize } = params;

  const validDays = await getCouponValidDays(supabase);
  const expiresAt = new Date(Date.now() + validDays * 24 * 60 * 60 * 1000);

  const { code, shopifyDiscountId } = await createDiscountCodeForPrize({
    prize,
    shopifyCustomerId,
    expiresAt,
  });

  const { data, error } = await supabase
    .from('coupons')
    .insert({
      draw_id: drawId,
      shopify_customer_id: shopifyCustomerId,
      code,
      shopify_discount_id: shopifyDiscountId,
      status: 'issued',
      expires_at: expiresAt.toISOString(),
    })
    .select('code, shopify_discount_id, expires_at')
    .single();

  if (error) {
    // draw_id の一意制約違反 = 別リクエストが先に発行済み。既存行を返す。
    const { data: existing, error: fetchError } = await supabase
      .from('coupons')
      .select('code, shopify_discount_id, expires_at')
      .eq('draw_id', drawId)
      .single();
    if (fetchError || !existing) {
      throw new Error(`クーポンのDB保存に失敗しました: ${error.message}`);
    }
    return {
      code: existing.code,
      shopifyDiscountId: existing.shopify_discount_id,
      expiresAt: existing.expires_at,
    };
  }

  return {
    code: data.code,
    shopifyDiscountId: data.shopify_discount_id,
    expiresAt: data.expires_at,
  };
}
