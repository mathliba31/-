import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../../../lib/supabaseAdmin';
import { requireSessionToken } from '../../../lib/shopifySessionAuth';
import { parseEventInput } from '../../../lib/campaignEventInput';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    requireSessionToken(req);
  } catch (err) {
    return res.status(401).json({ error: 'unauthorized', message: err instanceof Error ? err.message : 'unknown' });
  }

  const id = Number(req.query.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'invalid_id' });
  }

  const supabase = getSupabaseAdmin();

  if (req.method === 'PATCH') {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const keys = Object.keys(body);

    let update: Record<string, unknown>;
    if (keys.length === 1 && keys[0] === 'is_active') {
      if (typeof body.is_active !== 'boolean') {
        return res.status(400).json({ error: 'invalid_is_active' });
      }
      update = { is_active: body.is_active };
    } else {
      const parsed = parseEventInput(body);
      if ('error' in parsed) {
        return res.status(400).json({ error: parsed.error });
      }
      update = parsed.value as unknown as Record<string, unknown>;
    }

    const { data, error } = await supabase.from('campaign_events').update(update).eq('id', id).select().maybeSingle();
    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'key_already_exists' });
      }
      return res.status(500).json({ error: 'internal_error', message: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: 'not_found' });
    }
    return res.status(200).json({ event: data });
  }

  if (req.method === 'DELETE') {
    const { error } = await supabase.from('campaign_events').delete().eq('id', id);
    if (error) {
      return res.status(500).json({ error: 'internal_error', message: error.message });
    }
    return res.status(204).end();
  }

  res.setHeader('Allow', 'PATCH, DELETE');
  return res.status(405).json({ error: 'method_not_allowed' });
}
