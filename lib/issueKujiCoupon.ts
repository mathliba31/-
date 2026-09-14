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
 * 一番くじの抽選(kuji_draws挿入済み。通常抽選・節目賞どちらも)だがクーポン未発行の
 * ものに対して、Shopifyでクーポンを発行し kuji_coupons テーブルへ記録する。
 * ガチャ側の issueCouponForDraw と同じ構造(テーブル名のみ異なる)。
 */
export async function issueKujiCouponForDraw(params: {
  supabase: SupabaseClient;
  kujiDrawId: string;
  shopifyCustomerId: string;
  prize: PrizeInfo;
}): Promise<CouponInfo> {
  const { supabase, kujiDrawId, shopifyCustomerId, prize } = params;

  const validDays = await getCouponValidDays(supabase);
  const expiresAt = new Date(Date.now() + validDays * 24 * 60 * 60 * 1000);

  const { code, shopifyDiscountId } = await createDiscountCodeForPrize({
    prize,
    shopifyCustomerId,
    expiresAt,
  });

  const { data, error } = await supabase
    .from('kuji_coupons')
    .insert({
      kuji_draw_id: kujiDrawId,
      shopify_customer_id: shopifyCustomerId,
      code,
      shopify_discount_id: shopifyDiscountId,
      status: 'issued',
      expires_at: expiresAt.toISOString(),
    })
    .select('code, shopify_discount_id, expires_at')
    .single();

  if (error) {
    // kuji_draw_id の一意制約違反 = 別リクエストが先に発行済み。既存行を返す。
    const { data: existing, error: fetchError } = await supabase
      .from('kuji_coupons')
      .select('code, shopify_discount_id, expires_at')
      .eq('kuji_draw_id', kujiDrawId)
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
