import type { VercelRequest, VercelResponse } from '@vercel/node';
import { env } from '../../lib/env';
import { getSupabaseAdmin } from '../../lib/supabaseAdmin';
import { isAdminAuthorized } from '../../lib/adminAuth';
import { fetchGachaCollectionProducts } from '../../lib/shopifySync';

/**
 * Shopifyの「ガチャ景品」コレクション + 商品メタフィールド(namespace: gacha)を
 * prizesテーブルへ同期する。運用者はShopify管理画面(商品編集・コレクション編集)だけを
 * 触れば済むようにするための管理API。
 *
 * - コレクションに存在し、gacha.weight が設定されている商品を upsert する
 * - 以前は同期対象だったが今回のコレクションに含まれなくなった商品は is_active=false にする
 *   (過去の抽選ログとの整合性のため削除はしない)
 *
 * Authorization: Bearer <ADMIN_API_SECRET> が必要。
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  if (!isAdminAuthorized(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  let synced;
  try {
    synced = await fetchGachaCollectionProducts(env.shopifyGachaCollectionHandle);
  } catch (err) {
    console.error('sync-prizes: fetch failed', err);
    return res.status(502).json({
      error: 'shopify_fetch_failed',
      message: err instanceof Error ? err.message : 'unknown',
    });
  }

  const supabase = getSupabaseAdmin();

  let upsertedCount = 0;
  const failures: Array<{ variant_id: string; message: string }> = [];

  for (const prize of synced.prizes) {
    const { error } = await supabase.from('prizes').upsert(
      {
        shopify_variant_id: prize.variantId,
        name: prize.name,
        weight: prize.weight,
        discount_type: prize.discountType,
        discount_value: prize.discountValue,
        list_price: prize.listPrice,
        unit_cost: prize.unitCost,
        stock_limit: prize.stockLimit,
        is_guaranteed_pool: prize.isGuaranteedPool,
        is_active: true,
      },
      { onConflict: 'shopify_variant_id' },
    );

    if (error) {
      console.error('sync-prizes: upsert failed', prize.variantId, error);
      failures.push({ variant_id: prize.variantId, message: error.message });
    } else {
      upsertedCount++;
    }
  }

  let deactivatedCount = 0;
  const syncedVariantIds = synced.prizes.map((p) => p.variantId);
  if (syncedVariantIds.length > 0) {
    const { data: deactivated, error: deactivateError } = await supabase
      .from('prizes')
      .update({ is_active: false })
      .not('shopify_variant_id', 'in', `(${syncedVariantIds.join(',')})`)
      .eq('is_active', true)
      .select('id');

    if (deactivateError) {
      console.error('sync-prizes: deactivate failed', deactivateError);
    } else {
      deactivatedCount = deactivated?.length ?? 0;
    }
  }

  return res.status(200).json({
    upserted: upsertedCount,
    deactivated: deactivatedCount,
    skipped: synced.skipped,
    failures,
  });
}
