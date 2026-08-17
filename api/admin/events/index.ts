import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../../../lib/supabaseAdmin';
import { requireSessionToken } from '../../../lib/shopifySessionAuth';
import { parseEventInput } from '../../../lib/campaignEventInput';

/**
 * campaign_events(天井のON/OFF・N回数・Flowセグメント配信用のイベント期間)を
 * 埋め込み管理画面(api/admin-ui.ts)から操作するためのAPI。
 * Shopify App Bridgeのセッショントークンで認証する(Bearer)。
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    requireSessionToken(req);
  } catch (err) {
    return res.status(401).json({ error: 'unauthorized', message: err instanceof Error ? err.message : 'unknown' });
  }

  const supabase = getSupabaseAdmin();

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('campaign_events')
      .select('id, key, name, starts_at, ends_at, pity_threshold, is_active, created_at')
      .order('starts_at', { ascending: false });
    if (error) {
      return res.status(500).json({ error: 'internal_error', message: error.message });
    }
    return res.status(200).json({ events: data ?? [] });
  }

  if (req.method === 'POST') {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const parsed = parseEventInput(body);
    if ('error' in parsed) {
      return res.status(400).json({ error: parsed.error });
    }

    const { data, error } = await supabase.from('campaign_events').insert(parsed.value).select().single();
    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'key_already_exists' });
      }
      return res.status(500).json({ error: 'internal_error', message: error.message });
    }
    return res.status(201).json({ event: data });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'method_not_allowed' });
}
