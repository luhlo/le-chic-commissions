create or replace function public.analytics_period_lines(
  p_start date,
  p_end date
)
returns table (
  id uuid,
  external_line_id text,
  external_product_key text,
  source_sku text,
  sku_id uuid,
  product_name text,
  quantity integer,
  refunded_quantity integer,
  unit_price numeric,
  discounts numeric,
  refunds numeric,
  shipping numeric,
  platform_fees numeric,
  platform_commissions numeric,
  other_costs numeric,
  order_id uuid,
  order_number text,
  business_date date,
  currency text,
  source text,
  referral text,
  market text,
  cancelled boolean,
  account_id uuid,
  channel_id text
)
language sql
stable
security invoker
set search_path = public
as $$
  with latest_revisions as (
    select
      revision.*,
      orders.account_id,
      channel_accounts.channel_id,
      row_number() over (
        partition by revision.order_id
        order by revision.created_at desc, revision.id desc
      ) as revision_rank
    from public.order_revisions as revision
    join public.orders on orders.id = revision.order_id
    join public.channel_accounts on channel_accounts.id = orders.account_id
  )
  select
    item.id,
    item.external_line_id,
    item.external_product_key,
    item.source_sku,
    item.sku_id,
    item.product_name,
    item.quantity,
    item.refunded_quantity,
    item.unit_price,
    item.discounts,
    item.refunds,
    item.shipping,
    item.platform_fees,
    item.platform_commissions,
    item.other_costs,
    revision.order_id,
    revision.order_number,
    revision.business_date,
    revision.currency,
    revision.source,
    revision.referral,
    revision.market,
    revision.cancelled,
    revision.account_id,
    revision.channel_id
  from latest_revisions as revision
  join public.order_items as item on item.revision_id = revision.id
  where revision.revision_rank = 1
    and p_start is not null
    and p_end is not null
    and p_start <= p_end
    and revision.business_date between p_start and p_end
  order by revision.business_date, revision.order_id, item.id;
$$;

revoke all on function public.analytics_period_lines(date, date) from public;
grant execute on function public.analytics_period_lines(date, date) to authenticated;

comment on function public.analytics_period_lines(date, date) is
  'Returns paginatable latest-order-revision line data for authenticated Analytics reporting without changing imported orders.';
