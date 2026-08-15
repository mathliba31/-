-- 抽選本体を1トランザクションで実行するストアド関数。
-- Vercel Functions からは supabase.rpc('draw_gacha', ...) で呼び出す。
--
-- 設計メモ:
--   - Shopifyへのクーポン発行(仕様書 5-4 手順5)はこの関数の外(アプリ側)で行う。
--     ここでコミットされるのは「抽選成立」までであり、クーポン発行の成否に関わらず
--     チケットは返却しない(二重消費防止)。クーポンが未発行のdrawはアプリ側が
--     検出して再発行する。
--   - idempotency_key で既存の抽選が見つかった場合はそのまま同じ結果を返す
--     (二重実行防止)。この場合 already_existed = true を返すので、
--     呼び出し側は「クーポンが既に発行済みか」を別途 coupons テーブルで確認すること。
--   - 重み付き抽選は「-ln(random())/weight の最小値」を使う一発クエリで行う
--     (指数分布の最小値レース。選ばれる確率が重みに正確に比例する)。

create or replace function draw_gacha(
  p_customer_id text,
  p_idempotency_key text
)
returns table (
  draw_id             uuid,
  prize_id            bigint,
  prize_name          text,
  shopify_variant_id  text,
  discount_type       text,
  discount_value      integer,
  list_price          integer,
  is_guaranteed       boolean,
  ticket_balance      integer,
  weekly_count        integer,
  weekly_threshold    integer,
  already_existed     boolean
)
language plpgsql
as $$
declare
  v_existing            record;
  v_pity_threshold       integer;
  v_week_start_weekday   integer;
  v_iso_dow              integer;
  v_offset               integer;
  v_week_start           date;
  v_balance              integer;
  v_draw_count           integer;
  v_guaranteed_granted   boolean;
  v_is_guaranteed        boolean := false;
  v_prize                record;
  v_draw_id              uuid;
begin
  if p_customer_id is null or p_customer_id = '' then
    raise exception 'CUSTOMER_ID_REQUIRED' using errcode = 'P0004';
  end if;
  if p_idempotency_key is null or p_idempotency_key = '' then
    raise exception 'IDEMPOTENCY_KEY_REQUIRED' using errcode = 'P0005';
  end if;

  -- 1. idempotency_key で既存の抽選を検索(二重実行防止)
  select d.id, d.prize_id, d.is_guaranteed, p.name, p.shopify_variant_id,
         p.discount_type, p.discount_value, p.list_price, c.ticket_balance
    into v_existing
  from draws d
  join prizes p on p.id = d.prize_id
  join customers c on c.shopify_customer_id = d.shopify_customer_id
  where d.idempotency_key = p_idempotency_key;

  if found then
    select (value #>> '{}')::integer into v_pity_threshold
      from settings where key = 'pity_threshold';
    select (value #>> '{}')::integer into v_week_start_weekday
      from settings where key = 'week_start_weekday';

    v_iso_dow := extract(isodow from (now() at time zone 'utc'))::int;
    v_offset := (v_iso_dow - v_week_start_weekday + 7) % 7;
    v_week_start := (now() at time zone 'utc')::date - v_offset;

    select wc.draw_count into v_draw_count
      from weekly_counters wc
      where wc.shopify_customer_id = p_customer_id and wc.week_start = v_week_start;

    return query select
      v_existing.id, v_existing.prize_id, v_existing.name, v_existing.shopify_variant_id,
      v_existing.discount_type, v_existing.discount_value, v_existing.list_price,
      v_existing.is_guaranteed, v_existing.ticket_balance,
      coalesce(v_draw_count, 0), coalesce(v_pity_threshold, 7), true;
    return;
  end if;

  -- 2. 設定値の取得
  select (value #>> '{}')::integer into v_pity_threshold
    from settings where key = 'pity_threshold';
  select (value #>> '{}')::integer into v_week_start_weekday
    from settings where key = 'week_start_weekday';
  v_pity_threshold := coalesce(v_pity_threshold, 7);
  v_week_start_weekday := coalesce(v_week_start_weekday, 1);

  v_iso_dow := extract(isodow from (now() at time zone 'utc'))::int;
  v_offset := (v_iso_dow - v_week_start_weekday + 7) % 7;
  v_week_start := (now() at time zone 'utc')::date - v_offset;

  -- 3-1. customers 行をロック
  select ticket_balance into v_balance
    from customers
    where shopify_customer_id = p_customer_id
    for update;

  if not found then
    raise exception 'CUSTOMER_NOT_FOUND' using errcode = 'P0006';
  end if;

  -- 3-2. 残高チェック
  if v_balance < 1 then
    raise exception 'INSUFFICIENT_BALANCE' using errcode = 'P0002';
  end if;

  -- 3-3. weekly_counters を今週分でupsertし、draw_count を +1
  insert into weekly_counters (shopify_customer_id, week_start, draw_count, guaranteed_granted)
  values (p_customer_id, v_week_start, 1, false)
  on conflict (shopify_customer_id, week_start)
  do update set draw_count = weekly_counters.draw_count + 1
  returning draw_count, guaranteed_granted into v_draw_count, v_guaranteed_granted;

  -- 3-4. 景品を決定する
  if v_draw_count >= v_pity_threshold and not v_guaranteed_granted then
    v_is_guaranteed := true;

    update weekly_counters
      set guaranteed_granted = true
      where shopify_customer_id = p_customer_id and week_start = v_week_start;

    select id, name, shopify_variant_id, discount_type, discount_value, list_price
      into v_prize
      from prizes
      where is_active and weight > 0 and is_guaranteed_pool
        and (stock_limit is null or issued_count < stock_limit)
      order by -ln(random()) / weight
      limit 1;
  else
    select id, name, shopify_variant_id, discount_type, discount_value, list_price
      into v_prize
      from prizes
      where is_active and weight > 0
        and (stock_limit is null or issued_count < stock_limit)
      order by -ln(random()) / weight
      limit 1;
  end if;

  if v_prize.id is null then
    raise exception 'NO_PRIZE_AVAILABLE' using errcode = 'P0003';
  end if;

  v_draw_id := gen_random_uuid();

  -- 3-5. issued_count を +1
  update prizes set issued_count = issued_count + 1 where id = v_prize.id;

  -- 3-6. ticket_balance を -1
  update customers set ticket_balance = ticket_balance - 1
    where shopify_customer_id = p_customer_id
    returning ticket_balance into v_balance;

  -- 3-7. ticket_ledger に記録
  insert into ticket_ledger (shopify_customer_id, delta, reason, ref_id)
  values (p_customer_id, -1, 'draw', v_draw_id::text);

  -- 3-8. draws に挿入
  insert into draws (id, shopify_customer_id, prize_id, is_guaranteed, idempotency_key)
  values (v_draw_id, p_customer_id, v_prize.id, v_is_guaranteed, p_idempotency_key);

  return query select
    v_draw_id, v_prize.id, v_prize.name, v_prize.shopify_variant_id,
    v_prize.discount_type, v_prize.discount_value, v_prize.list_price,
    v_is_guaranteed, v_balance, v_draw_count, v_pity_threshold, false;
end;
$$;
