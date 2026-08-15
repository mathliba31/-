-- orders/paid Webhook 用: チケット付与を顧客行の作成とあわせて原子的に行う。
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
begin
  insert into customers (shopify_customer_id, ticket_balance)
  values (p_customer_id, 0)
  on conflict (shopify_customer_id) do nothing;

  update customers
    set ticket_balance = ticket_balance + p_delta
    where shopify_customer_id = p_customer_id
    returning ticket_balance into v_balance;

  insert into ticket_ledger (shopify_customer_id, delta, reason, ref_id)
  values (p_customer_id, p_delta, 'purchase', p_ref_id);

  return v_balance;
end;
$$;
