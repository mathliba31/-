import type { SupabaseClient } from '@supabase/supabase-js';
import { setCustomerMetafields } from './shopifyAdmin';

const NAMESPACE = 'gacha';

interface ActiveCampaignEvent {
  key: string;
  starts_at: string;
  ends_at: string;
}

/**
 * ガチャの累計抽選回数と、現在有効なイベント期間中の抽選回数を
 * 顧客メタフィールド(namespace: "gacha")へ反映する。
 * Shopify Flowでのセグメント配信を主目的としており、以下のキーを書き込む:
 *   - gacha.lifetime_draw_count      (number_integer)  全期間の累計回数
 *   - gacha.current_event_key        (single_line_text_field) 現在有効なイベントのkey(無ければ空文字)
 *   - gacha.current_event_draw_count (number_integer)  そのイベント期間中の回数(イベントが無ければ0)
 *
 * 失敗しても抽選結果・クーポン発行そのものには影響させない(呼び出し側でtry/catchすること)。
 */
export async function syncGachaMetafields(supabase: SupabaseClient, shopifyCustomerId: string): Promise<void> {
  const { count: lifetimeCount, error: lifetimeError } = await supabase
    .from('draws')
    .select('id', { count: 'exact', head: true })
    .eq('shopify_customer_id', shopifyCustomerId);

  if (lifetimeError) {
    throw new Error(`累計回数の取得に失敗しました: ${lifetimeError.message}`);
  }

  const { data: activeEventRows, error: activeEventError } = await supabase.rpc('get_active_campaign_event');
  if (activeEventError) {
    throw new Error(`有効イベントの取得に失敗しました: ${activeEventError.message}`);
  }
  const activeEvent = (activeEventRows as ActiveCampaignEvent[] | null)?.[0] ?? null;

  let currentEventKey = '';
  let currentEventDrawCount = 0;

  if (activeEvent) {
    currentEventKey = activeEvent.key;

    const { count: eventCount, error: eventCountError } = await supabase
      .from('draws')
      .select('id', { count: 'exact', head: true })
      .eq('shopify_customer_id', shopifyCustomerId)
      .gte('created_at', activeEvent.starts_at)
      .lte('created_at', activeEvent.ends_at);

    if (eventCountError) {
      throw new Error(`イベント期間中の回数取得に失敗しました: ${eventCountError.message}`);
    }
    currentEventDrawCount = eventCount ?? 0;
  }

  await setCustomerMetafields({
    shopifyCustomerId,
    metafields: [
      { namespace: NAMESPACE, key: 'lifetime_draw_count', type: 'number_integer', value: String(lifetimeCount ?? 0) },
      { namespace: NAMESPACE, key: 'current_event_key', type: 'single_line_text_field', value: currentEventKey },
      {
        namespace: NAMESPACE,
        key: 'current_event_draw_count',
        type: 'number_integer',
        value: String(currentEventDrawCount),
      },
    ],
  });
}
