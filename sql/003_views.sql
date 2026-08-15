-- 損益管理用ビュー(7-2)
create or replace view v_return_rate as
select
  sum(weight * list_price)::numeric / nullif(sum(weight), 0) as expected_list_value,
  sum(weight * unit_cost)::numeric  / nullif(sum(weight), 0) as expected_unit_cost
from prizes
where is_active and weight > 0;

-- 効果測定用ビュー: クーポン使用率(景品別)(7-3)
create or replace view v_coupon_use_rate as
select p.name,
       count(*) as issued,
       count(c.used_at) as used,
       round(count(c.used_at)::numeric / nullif(count(*), 0), 3) as use_rate
from coupons c
join draws d on d.id = c.draw_id
join prizes p on p.id = d.prize_id
group by p.name
order by issued desc;
