-- 一番くじ機能: ガチャとは独立した「重複なし・総口数固定」の抽選システム。
--
-- ガチャとの違い:
--   - チケット(=くじ券)はキャンペーン(kuji_campaigns)ごとに別の通貨として扱う。
--     ticket_balance は customers ではなく kuji_participants(campaign_id, customer_id)に持つ。
--   - 景品(kuji_prizes)は「残数」を持ち、抽選のたびに減っていく(重複当選なし)。
--     重みではなく remaining_quantity に比例した抽選にすることで、
--     「総口数を引き切ったら景品も0になる」という一番くじらしい挙動を実現する。
--   - 「節目賞」(ラストワン賞・N人目の購入者賞など)は kuji_bonus_rules で表現する。
--     通常の抽選結果に「上乗せ」で付与する(仕様確認済み)。トリガーは2種類:
--       - draw_sequence:     キャンペーン内で何口目の「抽選」かで発火(ラストワン賞 = total_slotsと同値)
--       - purchase_sequence: キャンペーン内で何人目の「新規購入者」かで発火
--     各ルールは1回限りしか発火しない(granted_atで担保)。

create table kuji_campaigns (
  id                    bigserial primary key,
  key                   text not null unique,   -- ページ・チケット商品と紐付けるための識別子
  name                  text not null,
  total_slots           integer not null check (total_slots > 0),  -- 総口数
  status                text not null default 'draft',  -- 'draft' | 'active' | 'completed' | 'archived'
  next_sequence_number  integer not null default 1,  -- 次に採番する「何口目」(draw_kuji内で直列化に使う)
  participant_count     integer not null default 0,  -- 新規購入者数(grant_kuji_tickets内で直列化に使う)
  created_at            timestamptz not null default now()
);

-- くじ券(チケット)商品の対応表。1バリアント = 1キャンペーン専用。
create table kuji_ticket_products (
  shopify_variant_id  text primary key,
  campaign_id         bigint not null references kuji_campaigns,
  ticket_count        integer not null check (ticket_count > 0)
);

-- 景品マスタ。remaining_quantity が尽きた景品は通常抽選の対象から外れる。
create table kuji_prizes (
  id                  bigserial primary key,
  campaign_id         bigint not null references kuji_campaigns,
  name                text not null,
  shopify_variant_id  text not null,
  discount_type       text not null,      -- 'free_product'(100%OFF) | 'amount_off' | 'percent_off'
  discount_value      integer not null default 0,
  list_price          integer not null,
  unit_cost           integer not null default 0,
  total_quantity      integer not null check (total_quantity > 0),
  remaining_quantity  integer not null check (remaining_quantity >= 0),
  is_bonus            boolean not null default false,  -- true: 通常抽選のプールに含めない(節目賞専用の景品)
  is_active           boolean not null default true
);

-- 参加者ごとのくじ券残高(キャンペーンごとに別通貨)。
create table kuji_participants (
  campaign_id         bigint not null references kuji_campaigns,
  shopify_customer_id text not null,
  ticket_balance      integer not null default 0 check (ticket_balance >= 0),
  created_at          timestamptz not null default now(),
  primary key (campaign_id, shopify_customer_id)
);

-- くじ券増減の履歴(監査用)。
create table kuji_ticket_ledger (
  id                  bigserial primary key,
  campaign_id         bigint not null references kuji_campaigns,
  shopify_customer_id text not null,
  delta               integer not null,
  reason              text not null,   -- 'purchase' | 'draw' | 'admin_adjust'
  ref_id              text,            -- 注文IDや抽選ID
  created_at          timestamptz not null default now()
);

-- 抽選ログ。kind='draw'が通常の抽選、kind='bonus'が節目賞の付与。
-- 節目賞はtriggered_by_draw_idで元になった抽選(またはnull=購入トリガー)と紐付く。
create table kuji_draws (
  id                    uuid primary key default gen_random_uuid(),
  campaign_id           bigint not null references kuji_campaigns,
  shopify_customer_id   text not null,
  prize_id              bigint not null references kuji_prizes,
  kind                  text not null default 'draw',  -- 'draw' | 'bonus'
  sequence_number       integer,          -- 何口目の抽選か。購入トリガーのボーナスはnull
  triggered_by_draw_id  uuid references kuji_draws,  -- ボーナスの場合、元になった抽選(draw_sequence方式のみ)
  idempotency_key       text,             -- 通常抽選のみ必須(連打・二重送信防止)。ボーナスはnull
  created_at            timestamptz not null default now()
);

-- 発行済みクーポン。draws同様、1抽選(通常/ボーナス問わず)につき1枚。
create table kuji_coupons (
  id                  bigserial primary key,
  kuji_draw_id        uuid not null unique references kuji_draws,
  shopify_customer_id text not null,
  code                text not null unique,
  shopify_discount_id text,
  status              text not null default 'issued',  -- 'issued' | 'used' | 'expired'
  expires_at          timestamptz not null,
  used_at             timestamptz,
  shopify_order_id    text
);

-- 節目賞ルール。granted_atが埋まっていれば発火済み(1回限りを担保)。
create table kuji_bonus_rules (
  id                  bigserial primary key,
  campaign_id         bigint not null references kuji_campaigns,
  trigger_type        text not null,   -- 'draw_sequence' | 'purchase_sequence'
  trigger_value       integer not null check (trigger_value > 0),
  prize_id            bigint not null references kuji_prizes,
  granted_at          timestamptz,
  is_active           boolean not null default true
);

-- Webhook二重配信対策の一意制約は「同一キャンペーン内で同一注文ID」の粒度にする
-- (1注文に複数キャンペーンのくじ券が混在しうるため、ref_id単体では衝突してしまう)。
create unique index kuji_ticket_ledger_purchase_ref_key
  on kuji_ticket_ledger (campaign_id, ref_id)
  where reason = 'purchase';

-- 通常抽選の idempotency_key は一意(null=ボーナス行は対象外)。
create unique index kuji_draws_idempotency_key_idx
  on kuji_draws (idempotency_key)
  where idempotency_key is not null;

create index on kuji_draws (campaign_id, shopify_customer_id, created_at desc);
create index on kuji_draws (triggered_by_draw_id);
create index on kuji_coupons (shopify_customer_id, status);
create index on kuji_coupons (code);
create index on kuji_ticket_ledger (campaign_id, shopify_customer_id, created_at desc);
create index on kuji_prizes (campaign_id);
create index on kuji_bonus_rules (campaign_id);

-- 同一キャンペーン内で同じtrigger_type×trigger_valueの有効なルールを重複登録できないようにする。
-- (対策なしだと `select ... into` がSTRICTでないため、重複時は先勝ちで後者が永久に発火しないまま
--  黙って無視されてしまう。運用ミスを早期に検知するための制約。)
create unique index kuji_bonus_rules_trigger_key
  on kuji_bonus_rules (campaign_id, trigger_type, trigger_value)
  where is_active;

-- 抽選本体。1トランザクションで「くじ券消費→景品決定→節目賞判定」まで行う。
create or replace function draw_kuji(
  p_campaign_id bigint,
  p_customer_id text,
  p_idempotency_key text
)
returns table (
  draw_id               uuid,
  prize_id              bigint,
  prize_name            text,
  shopify_variant_id    text,
  discount_type         text,
  discount_value        integer,
  list_price            integer,
  sequence_number       integer,
  ticket_balance        integer,
  already_existed       boolean,
  bonus_draw_id         uuid,
  bonus_prize_id        bigint,
  bonus_prize_name      text,
  bonus_shopify_variant_id text,
  bonus_discount_type   text,
  bonus_discount_value  integer,
  bonus_list_price      integer
)
language plpgsql
as $$
declare
  v_existing        record;
  v_existing_bonus  record;
  v_balance         integer;
  v_prize           record;
  v_draw_id         uuid;
  v_sequence        integer;
  v_bonus_rule      record;
  v_bonus_prize     record;
  v_bonus_draw_id   uuid;
begin
  if p_campaign_id is null then
    raise exception 'CAMPAIGN_ID_REQUIRED' using errcode = 'P0007';
  end if;
  if p_customer_id is null or p_customer_id = '' then
    raise exception 'CUSTOMER_ID_REQUIRED' using errcode = 'P0004';
  end if;
  if p_idempotency_key is null or p_idempotency_key = '' then
    raise exception 'IDEMPOTENCY_KEY_REQUIRED' using errcode = 'P0005';
  end if;

  -- v_bonus_prize / v_existing_bonus をあらかじめ全列NULLで初期化しておく。未代入のまま
  -- (record型の構造が未確定のまま)RETURN QUERYでフィールドアクセスすると
  -- "record is not assigned yet" エラーになるため(節目賞が発火しない=大半のケースで踏む)。
  select null::bigint as id, null::text as name, null::text as shopify_variant_id,
         null::text as discount_type, null::integer as discount_value, null::integer as list_price
    into v_bonus_prize;

  select null::uuid as id, null::bigint as prize_id, null::text as name, null::text as shopify_variant_id,
         null::text as discount_type, null::integer as discount_value, null::integer as list_price
    into v_existing_bonus;

  -- 1. idempotency_key で既存の抽選を検索(二重実行防止)
  select d.id, d.prize_id, p.name, p.shopify_variant_id, p.discount_type, p.discount_value, p.list_price,
         d.sequence_number, kp.ticket_balance
    into v_existing
  from kuji_draws d
  join kuji_prizes p on p.id = d.prize_id
  join kuji_participants kp on kp.campaign_id = d.campaign_id and kp.shopify_customer_id = d.shopify_customer_id
  where d.idempotency_key = p_idempotency_key and d.kind = 'draw';

  if found then
    select bd.id, bd.prize_id, bp.name, bp.shopify_variant_id, bp.discount_type, bp.discount_value, bp.list_price
      into v_existing_bonus
      from kuji_draws bd
      join kuji_prizes bp on bp.id = bd.prize_id
      where bd.triggered_by_draw_id = v_existing.id and bd.kind = 'bonus';

    return query select
      v_existing.id, v_existing.prize_id, v_existing.name, v_existing.shopify_variant_id,
      v_existing.discount_type, v_existing.discount_value, v_existing.list_price,
      v_existing.sequence_number, v_existing.ticket_balance, true,
      v_existing_bonus.id, v_existing_bonus.prize_id, v_existing_bonus.name,
      v_existing_bonus.shopify_variant_id, v_existing_bonus.discount_type,
      v_existing_bonus.discount_value, v_existing_bonus.list_price;
    return;
  end if;

  -- 2. 参加者行をロックして残高チェック
  select kuji_participants.ticket_balance into v_balance
    from kuji_participants
    where kuji_participants.campaign_id = p_campaign_id
      and kuji_participants.shopify_customer_id = p_customer_id
    for update;

  if not found then
    raise exception 'CUSTOMER_NOT_FOUND' using errcode = 'P0006';
  end if;

  if v_balance < 1 then
    raise exception 'INSUFFICIENT_BALANCE' using errcode = 'P0002';
  end if;

  -- 3. キャンペーン行をロックしつつ「何口目か」を直列に採番する
  update kuji_campaigns
    set next_sequence_number = next_sequence_number + 1
    where id = p_campaign_id and status = 'active'
    returning next_sequence_number - 1 into v_sequence;

  if not found then
    raise exception 'CAMPAIGN_NOT_ACTIVE' using errcode = 'P0008';
  end if;

  -- 4. 景品を決定する(残数に比例した重み付け。通常プール = is_bonus false のみ)
  select kuji_prizes.id, kuji_prizes.name, kuji_prizes.shopify_variant_id, kuji_prizes.discount_type,
         kuji_prizes.discount_value, kuji_prizes.list_price
    into v_prize
    from kuji_prizes
    where campaign_id = p_campaign_id and is_active and not is_bonus and remaining_quantity > 0
    order by -ln(random()) / remaining_quantity
    limit 1;

  if v_prize.id is null then
    raise exception 'NO_PRIZE_AVAILABLE' using errcode = 'P0003';
  end if;

  v_draw_id := gen_random_uuid();

  update kuji_prizes set remaining_quantity = remaining_quantity - 1 where id = v_prize.id;

  -- 列名を明示的に kuji_participants. で修飾する。RETURNS TABLE の出力列(ticket_balance)と
  -- 同名のテーブル列があると、修飾なしではPL/pgSQLが変数参照と解釈してしまい
  -- "column reference is ambiguous" エラーになるため(draw_gacha関数と同じ注意点)。
  update kuji_participants set ticket_balance = kuji_participants.ticket_balance - 1
    where campaign_id = p_campaign_id and shopify_customer_id = p_customer_id
    returning kuji_participants.ticket_balance into v_balance;

  insert into kuji_ticket_ledger (campaign_id, shopify_customer_id, delta, reason, ref_id)
  values (p_campaign_id, p_customer_id, -1, 'draw', v_draw_id::text);

  insert into kuji_draws (id, campaign_id, shopify_customer_id, prize_id, kind, sequence_number, idempotency_key)
  values (v_draw_id, p_campaign_id, p_customer_id, v_prize.id, 'draw', v_sequence, p_idempotency_key);

  -- 5. 節目賞(draw_sequence方式)の判定・発火。「ラストワン賞」もtrigger_value = total_slotsとして
  --    ここで自然に表現される(特別扱いしない)。
  v_bonus_draw_id := null;

  select * into v_bonus_rule
    from kuji_bonus_rules
    where campaign_id = p_campaign_id
      and trigger_type = 'draw_sequence'
      and trigger_value = v_sequence
      and is_active
      and granted_at is null
    for update;

  if found then
    -- ルールの発火チャンスは一度きりなので、対象の節目(trigger_value)は granted_at で
    -- 消費済みにする。ただし景品在庫が尽きていた場合はクーポン付与自体はスキップする
    -- (在庫切れの景品をマイナスにしない。remaining_quantity > 0 をここでも確認する)。
    update kuji_bonus_rules set granted_at = now() where id = v_bonus_rule.id;

    select kuji_prizes.id, kuji_prizes.name, kuji_prizes.shopify_variant_id, kuji_prizes.discount_type,
           kuji_prizes.discount_value, kuji_prizes.list_price
      into v_bonus_prize
      from kuji_prizes
      where id = v_bonus_rule.prize_id and remaining_quantity > 0;

    if v_bonus_prize.id is not null then
      update kuji_prizes set remaining_quantity = remaining_quantity - 1 where id = v_bonus_prize.id;

      v_bonus_draw_id := gen_random_uuid();

      insert into kuji_draws (id, campaign_id, shopify_customer_id, prize_id, kind, sequence_number, triggered_by_draw_id)
      values (v_bonus_draw_id, p_campaign_id, p_customer_id, v_bonus_prize.id, 'bonus', v_sequence, v_draw_id);
    end if;
  end if;

  return query select
    v_draw_id, v_prize.id, v_prize.name, v_prize.shopify_variant_id, v_prize.discount_type,
    v_prize.discount_value, v_prize.list_price, v_sequence, v_balance, false,
    v_bonus_draw_id, v_bonus_prize.id, v_bonus_prize.name, v_bonus_prize.shopify_variant_id,
    v_bonus_prize.discount_type, v_bonus_prize.discount_value, v_bonus_prize.list_price;
end;
$$;

-- くじ券付与。orders/paid Webhookから呼ぶ。ref_id(注文ID)単位でキャンペーンごとに冪等。
-- 新規購入者(そのキャンペーンで初めてくじ券を持った顧客)であれば、
-- purchase_sequence方式の節目賞(例: 10人目の購入者)も判定・発火する。
create or replace function grant_kuji_tickets(
  p_campaign_id bigint,
  p_customer_id text,
  p_delta integer,
  p_ref_id text
)
returns table (
  ticket_balance            integer,
  bonus_draw_id             uuid,
  bonus_prize_id            bigint,
  bonus_prize_name          text,
  bonus_shopify_variant_id  text,
  bonus_discount_type       text,
  bonus_discount_value      integer,
  bonus_list_price          integer
)
language plpgsql
as $$
declare
  v_balance             integer;
  v_rows                integer;
  v_is_new              boolean := false;
  v_participant_count   integer;
  v_bonus_rule          record;
  v_bonus_prize         record;
  v_bonus_draw_id       uuid;
  v_existing_bonus      record;
begin
  -- v_bonus_prize / v_existing_bonus をあらかじめ全列NULLで初期化しておく(理由はdraw_kuji関数のコメント参照)。
  select null::bigint as id, null::text as name, null::text as shopify_variant_id,
         null::text as discount_type, null::integer as discount_value, null::integer as list_price
    into v_bonus_prize;

  select null::uuid as id, null::bigint as prize_id, null::text as name, null::text as shopify_variant_id,
         null::text as discount_type, null::integer as discount_value, null::integer as list_price
    into v_existing_bonus;

  insert into kuji_participants (campaign_id, shopify_customer_id, ticket_balance)
  values (p_campaign_id, p_customer_id, 0)
  on conflict (campaign_id, shopify_customer_id) do nothing;

  get diagnostics v_rows = row_count;
  v_is_new := v_rows > 0;

  insert into kuji_ticket_ledger (campaign_id, shopify_customer_id, delta, reason, ref_id)
  values (p_campaign_id, p_customer_id, p_delta, 'purchase', p_ref_id)
  on conflict (campaign_id, ref_id) where reason = 'purchase' do nothing;

  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    -- 既にこの注文ID×キャンペーンでくじ券付与済み(Webhook再配信からの再試行)。
    -- このタイミングで節目賞(purchase_sequence)が発火していた場合は、その結果も
    -- 再現して返す(そうしないとWebhookの再試行でボーナスクーポンの発行が握りつぶされる)。
    -- 新規参加者になれるのは各顧客につき1回限りなので、この再試行は当時と同じ
    -- 購入イベントを指している(= triggered_by_draw_id is null のボーナス抽選と1:1対応する)。
    select kuji_participants.ticket_balance into v_balance
      from kuji_participants
      where campaign_id = p_campaign_id and shopify_customer_id = p_customer_id;

    select bd.id, bd.prize_id, bp.name, bp.shopify_variant_id, bp.discount_type, bp.discount_value, bp.list_price
      into v_existing_bonus
      from kuji_draws bd
      join kuji_prizes bp on bp.id = bd.prize_id
      where bd.campaign_id = p_campaign_id
        and bd.shopify_customer_id = p_customer_id
        and bd.kind = 'bonus'
        and bd.triggered_by_draw_id is null;

    return query select
      v_balance, v_existing_bonus.id, v_existing_bonus.prize_id, v_existing_bonus.name,
      v_existing_bonus.shopify_variant_id, v_existing_bonus.discount_type,
      v_existing_bonus.discount_value, v_existing_bonus.list_price;
    return;
  end if;

  -- 列名を明示的に kuji_participants. で修飾する(理由はdraw_kuji関数のコメント参照)。
  update kuji_participants
    set ticket_balance = kuji_participants.ticket_balance + p_delta
    where campaign_id = p_campaign_id and shopify_customer_id = p_customer_id
    returning kuji_participants.ticket_balance into v_balance;

  v_bonus_draw_id := null;

  if v_is_new then
    -- キャンペーン行をロックしつつ「何人目の新規購入者か」を直列に採番する
    update kuji_campaigns
      set participant_count = participant_count + 1
      where id = p_campaign_id
      returning participant_count into v_participant_count;

    select * into v_bonus_rule
      from kuji_bonus_rules
      where campaign_id = p_campaign_id
        and trigger_type = 'purchase_sequence'
        and trigger_value = v_participant_count
        and is_active
        and granted_at is null
      for update;

    if found then
      -- draw_kuji関数と同様、在庫が尽きている場合はクーポン付与をスキップする
      -- (ルール自体はgranted_atで消費済みにし、再度は発火させない)。
      update kuji_bonus_rules set granted_at = now() where id = v_bonus_rule.id;

      select kuji_prizes.id, kuji_prizes.name, kuji_prizes.shopify_variant_id, kuji_prizes.discount_type,
             kuji_prizes.discount_value, kuji_prizes.list_price
        into v_bonus_prize
        from kuji_prizes
        where id = v_bonus_rule.prize_id and remaining_quantity > 0;

      if v_bonus_prize.id is not null then
        update kuji_prizes set remaining_quantity = remaining_quantity - 1 where id = v_bonus_prize.id;

        v_bonus_draw_id := gen_random_uuid();

        insert into kuji_draws (id, campaign_id, shopify_customer_id, prize_id, kind, sequence_number)
        values (v_bonus_draw_id, p_campaign_id, p_customer_id, v_bonus_prize.id, 'bonus', null);
      end if;
    end if;
  end if;

  return query select v_balance, v_bonus_draw_id, v_bonus_prize.id, v_bonus_prize.name,
    v_bonus_prize.shopify_variant_id, v_bonus_prize.discount_type, v_bonus_prize.discount_value, v_bonus_prize.list_price;
end;
$$;

alter function draw_kuji(bigint, text, text) set search_path = public;
alter function grant_kuji_tickets(bigint, text, integer, text) set search_path = public;

-- 抽選は成立したがクーポン未発行のまま止まっている行を検出する(gacha側と同じ救済用)。
create or replace function find_kuji_draws_missing_coupon(
  p_draw_id uuid default null,
  p_limit integer default 20
)
returns table (
  kuji_draw_id        uuid,
  shopify_customer_id text,
  prize_id            bigint,
  prize_name          text,
  shopify_variant_id  text,
  discount_type       text,
  discount_value      integer,
  list_price          integer
)
language sql
stable
as $$
  select
    d.id as kuji_draw_id,
    d.shopify_customer_id,
    d.prize_id,
    p.name as prize_name,
    p.shopify_variant_id,
    p.discount_type,
    p.discount_value,
    p.list_price
  from kuji_draws d
  join kuji_prizes p on p.id = d.prize_id
  where not exists (select 1 from kuji_coupons c where c.kuji_draw_id = d.id)
    and (p_draw_id is null or d.id = p_draw_id)
  order by d.created_at asc
  limit p_limit;
$$;

alter function find_kuji_draws_missing_coupon(uuid, integer) set search_path = public;

-- RLS: 全テーブルで有効化。ポリシーは追加しないため anon/authenticated からのアクセスは遮断される
-- (バックエンドはservice_roleキーを使うため常にバイパスされ、動作に影響しない)。
alter table public.kuji_campaigns        enable row level security;
alter table public.kuji_ticket_products  enable row level security;
alter table public.kuji_prizes           enable row level security;
alter table public.kuji_participants     enable row level security;
alter table public.kuji_ticket_ledger    enable row level security;
alter table public.kuji_draws            enable row level security;
alter table public.kuji_coupons          enable row level security;
alter table public.kuji_bonus_rules      enable row level security;
