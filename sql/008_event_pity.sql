-- 天井(確定枠)の判定基準を「週次」から「イベント期間中の抽選回数」へ変更する。
--
-- 変更点:
--   - draw_gacha() は今後 weekly_counters を使わない。天井は
--     get_active_campaign_event() が返す「現在有効なイベント」の期間中の
--     抽選回数(draws.created_at で判定)で数える。有効なイベントが無い間は
--     天井(確定枠抽選)そのものが発生しない。
--   - 天井までの回数(N)はイベントごとに campaign_events.pity_threshold で
--     個別設定できる(NULLの場合は settings.pity_threshold をフォールバックとして使う)。
--   - customers 行のロック(FOR UPDATE)により同一顧客のリクエストは直列化されるため、
--     weekly_counters のような専用カウンタテーブル・upsertは不要(draws を直接集計する)。
--   - weekly_counters テーブル自体は過去データ保持のため削除しない(以後未使用になるだけ)。

alter table campaign_events add column if not exists pity_threshold integer;
comment on column campaign_events.pity_threshold is
  'このイベント期間中の天井(確定枠)までの回数。NULLの場合は settings.pity_threshold を使う。';

comment on table weekly_counters is
  '廃止: 天井判定は008以降イベント期間ベース(draws.created_atの集計)に変更されたため未使用。過去データ保持のため残置。';

drop function if exists get_active_campaign_event();
create function get_active_campaign_event()
returns table (
  id             bigint,
  key            text,
  name           text,
  starts_at      timestamptz,
  ends_at        timestamptz,
  pity_threshold integer
)
language sql
stable
as $$
  select id, key, name, starts_at, ends_at, pity_threshold
  from campaign_events
  where is_active
    and now() between starts_at and ends_at
  order by starts_at desc
  limit 1;
$$;

drop function if exists draw_gacha(text, text);
create function draw_gacha(
  p_customer_id text,
  p_idempotency_key text
)
returns table (
  draw_id              uuid,
  prize_id             bigint,
  prize_name           text,
  shopify_variant_id   text,
  discount_type        text,
  discount_value       integer,
  list_price           integer,
  is_guaranteed        boolean,
  ticket_balance       integer,
  event_key            text,
  event_draw_count     integer,
  event_pity_threshold integer,
  already_existed      boolean
)
language plpgsql
as $$
declare
  v_existing          record;
  v_event             record;
  v_pity_threshold     integer;
  v_balance            integer;
  v_prior_count        integer;
  v_already_granted    boolean;
  v_event_draw_count   integer;
  v_is_guaranteed      boolean := false;
  v_prize              record;
  v_draw_id            uuid;
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
    select gace.key, gace.pity_threshold, gace.starts_at, gace.ends_at
      into v_event
      from get_active_campaign_event() gace;

    if v_event.key is not null then
      select coalesce(
               v_event.pity_threshold,
               (select (value #>> '{}')::integer from settings where key = 'pity_threshold'),
               7
             ) into v_pity_threshold;
      select count(*) into v_event_draw_count
        from draws
        where shopify_customer_id = p_customer_id
          and created_at between v_event.starts_at and v_event.ends_at;
    else
      v_pity_threshold := null;
      v_event_draw_count := 0;
    end if;

    return query select
      v_existing.id, v_existing.prize_id, v_existing.name, v_existing.shopify_variant_id,
      v_existing.discount_type, v_existing.discount_value, v_existing.list_price,
      v_existing.is_guaranteed, v_existing.ticket_balance,
      v_event.key, v_event_draw_count, v_pity_threshold, true;
    return;
  end if;

  -- 2. customers 行をロックする。以降このトランザクションがcommit/rollbackするまで、
  --    同一顧客からの並行リクエストはここで直列化される(残高チェックに加え、
  --    下記のイベント期間中カウント・確定枠付与判定の整合性もこれで担保する)。
  select customers.ticket_balance into v_balance
    from customers
    where customers.shopify_customer_id = p_customer_id
    for update;

  if not found then
    raise exception 'CUSTOMER_NOT_FOUND' using errcode = 'P0006';
  end if;

  if v_balance < 1 then
    raise exception 'INSUFFICIENT_BALANCE' using errcode = 'P0002';
  end if;

  -- 3. 現在有効なイベントを取得し、天井を判定する。有効なイベントが無い間は天井なし。
  select gace.key, gace.pity_threshold, gace.starts_at, gace.ends_at
    into v_event
    from get_active_campaign_event() gace;

  if v_event.key is not null then
    select coalesce(
             v_event.pity_threshold,
             (select (value #>> '{}')::integer from settings where key = 'pity_threshold'),
             7
           ) into v_pity_threshold;

    select count(*) into v_prior_count
      from draws
      where shopify_customer_id = p_customer_id
        and created_at between v_event.starts_at and v_event.ends_at;

    select exists(
      select 1 from draws
      where shopify_customer_id = p_customer_id
        and is_guaranteed
        and created_at between v_event.starts_at and v_event.ends_at
    ) into v_already_granted;

    v_event_draw_count := v_prior_count + 1;

    if v_event_draw_count >= v_pity_threshold and not v_already_granted then
      v_is_guaranteed := true;
    end if;
  else
    v_pity_threshold := null;
    v_event_draw_count := 0;
  end if;

  -- 4. 景品を決定する
  if v_is_guaranteed then
    select prizes.id, prizes.name, prizes.shopify_variant_id, prizes.discount_type,
           prizes.discount_value, prizes.list_price
      into v_prize
      from prizes
      where is_active and weight > 0 and is_guaranteed_pool
        and (stock_limit is null or issued_count < stock_limit)
      order by -ln(random()) / weight
      limit 1;
  else
    select prizes.id, prizes.name, prizes.shopify_variant_id, prizes.discount_type,
           prizes.discount_value, prizes.list_price
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

  update prizes set issued_count = issued_count + 1 where id = v_prize.id;

  update customers set ticket_balance = customers.ticket_balance - 1
    where shopify_customer_id = p_customer_id
    returning customers.ticket_balance into v_balance;

  insert into ticket_ledger (shopify_customer_id, delta, reason, ref_id)
  values (p_customer_id, -1, 'draw', v_draw_id::text);

  insert into draws (id, shopify_customer_id, prize_id, is_guaranteed, idempotency_key)
  values (v_draw_id, p_customer_id, v_prize.id, v_is_guaranteed, p_idempotency_key);

  return query select
    v_draw_id, v_prize.id, v_prize.name, v_prize.shopify_variant_id,
    v_prize.discount_type, v_prize.discount_value, v_prize.list_price,
    v_is_guaranteed, v_balance, v_event.key, v_event_draw_count, v_pity_threshold, false;
end;
$$;
