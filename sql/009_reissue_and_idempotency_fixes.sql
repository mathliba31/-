-- コードレビューで見つかった2件の不具合を修正する。
--
-- 1. find_draws_missing_coupon: POST /api/admin/reissue が「作成日時が古い順に
--    BATCH_LIMIT件を取得してからJS側でクーポン未発行のものを絞り込む」実装になっており、
--    draws が BATCH_LIMIT 件を超えた時点で「まとめて処理」が実質的に機能しなくなっていた
--    (古い行は通常のフローで既にクーポン発行済みのため、絞り込み後に0件になる)。
--    DB側でNOT EXISTSによる絞り込みまで行ってから件数制限するよう修正する。
--
-- 2. grant_tickets: orders/paid Webhookの再配信時、grant_tickets呼び出しが
--    途中で失敗すると、webhook_eventsの重複防止レコードだけが先に残ってしまい、
--    Shopifyからの再配信が"処理済み"として無条件にスキップされ、
--    チケットが永久に付与されないケースがあった。ref_id(注文ID)単位で
--    冪等にすることで、Webhook側の処理順序を変えても安全に再試行できるようにする。

create or replace function find_draws_missing_coupon(
  p_draw_id uuid default null,
  p_limit integer default 20
)
returns table (
  draw_id             uuid,
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
    d.id as draw_id,
    d.shopify_customer_id,
    d.prize_id,
    p.name as prize_name,
    p.shopify_variant_id,
    p.discount_type,
    p.discount_value,
    p.list_price
  from draws d
  join prizes p on p.id = d.prize_id
  where not exists (select 1 from coupons c where c.draw_id = d.id)
    and (p_draw_id is null or d.id = p_draw_id)
  order by d.created_at asc
  limit p_limit;
$$;

-- 同一注文IDに対する grant_tickets の二重付与を防ぐ(reasonがpurchaseの行のみ対象。
-- 'draw'理由の行はref_idにdraw_id(UUID)を使っており名前空間が異なるため対象外にする)。
create unique index if not exists ticket_ledger_purchase_ref_id_key
  on ticket_ledger (ref_id)
  where reason = 'purchase';

create or replace function grant_tickets(
  p_customer_id text,
  p_delta integer,
  p_ref_id text
)
returns integer
language plpgsql
as $$
declare
  v_balance integer;
  v_rows    integer;
begin
  insert into customers (shopify_customer_id, ticket_balance)
  values (p_customer_id, 0)
  on conflict (shopify_customer_id) do nothing;

  insert into ticket_ledger (shopify_customer_id, delta, reason, ref_id)
  values (p_customer_id, p_delta, 'purchase', p_ref_id)
  on conflict (ref_id) where reason = 'purchase' do nothing;

  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    -- 既にこの注文IDでチケット付与済み(Webhook再配信からの再試行)。
    -- 残高はそのまま返し、二重付与はしない。
    select customers.ticket_balance into v_balance
      from customers where customers.shopify_customer_id = p_customer_id;
    return v_balance;
  end if;

  update customers
    set ticket_balance = ticket_balance + p_delta
    where shopify_customer_id = p_customer_id
    returning ticket_balance into v_balance;

  return v_balance;
end;
$$;

alter function find_draws_missing_coupon(uuid, integer) set search_path = public;
alter function grant_tickets(text, integer, text) set search_path = public;

-- reissueが customer_id 指定無しで作成日時順に走査するためのインデックス
-- (既存の (shopify_customer_id, created_at desc) は顧客単位の絞り込みには効くが、
-- 全体を作成日時順に見るこの用途には効かない)。
create index if not exists draws_created_at_idx on draws (created_at);
