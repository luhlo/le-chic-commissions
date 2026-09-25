-- Recipient approvals reuse the immutable statements/payouts foundation while
-- the live quarterly report remains the calculation source of truth.
alter table public.statements
  alter column period_id drop not null,
  alter column batch_id drop not null,
  add column year integer,
  add column quarter integer,
  add column starts_on date,
  add column ends_on date,
  add column finalization_id uuid references public.quarter_finalizations(id),
  add column finalization_snapshot jsonb not null default '{}'::jsonb,
  add column approved_at timestamptz,
  add column approved_by uuid references auth.users(id);

alter table public.statements
  add constraint statements_live_period_check check (
    (year is null and quarter is null and starts_on is null and ends_on is null and finalization_id is null and approved_at is null and approved_by is null)
    or
    (year between 2000 and 2100 and quarter between 1 and 4 and starts_on is not null and ends_on >= starts_on and finalization_id is not null and approved_at is not null and approved_by is not null)
  );

create index statements_live_period_recipient_idx
  on public.statements(year, quarter, recipient_id, approved_at desc)
  where year is not null;
create index statements_finalization_idx on public.statements(finalization_id) where finalization_id is not null;
create index statements_approved_by_idx on public.statements(approved_by) where approved_by is not null;

alter table public.payouts
  add column reference text not null default '';

alter table public.payouts
  add constraint payouts_method_check check (method in ('Zelle','ACH','PayPal','Check','Cash','Other'));

create or replace function public.approve_recipient_statement(
  p_recipient_id uuid,
  p_year integer,
  p_quarter integer,
  p_recipient_snapshot jsonb,
  p_calculation_snapshot jsonb,
  p_commission_total numeric
)
returns public.statements
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  actor uuid := auth.uid();
  q public.quarter_finalizations;
  recipient_name text;
  calculation_total numeric(18,2);
  style_total numeric(18,2);
  result public.statements;
begin
  if actor is null or not exists(select 1 from public.admin_members where user_id=actor) then
    raise exception 'Administrator access is required';
  end if;

  select * into q
  from public.quarter_finalizations
  where year=p_year and quarter=p_quarter
  for update;
  if q.id is null or q.status <> 'finalized' then
    raise exception 'The quarter must be finalized before a statement can be approved';
  end if;

  select name into recipient_name from public.recipients where id=p_recipient_id;
  if recipient_name is null then raise exception 'Recipient not found'; end if;
  if jsonb_typeof(p_calculation_snapshot->'model'->'calculations') <> 'array' then
    raise exception 'The statement calculation snapshot is incomplete';
  end if;
  if coalesce((p_calculation_snapshot#>>'{review,recipientBlockedLines}')::integer,-1) <> 0
     or coalesce((p_calculation_snapshot#>>'{review,amountsAvailable}')::boolean,false) is not true then
    raise exception 'Resolve blocking commission issues before approval';
  end if;
  if p_calculation_snapshot#>>'{model,status}' <> 'FINAL' then
    raise exception 'Only a final statement can be approved';
  end if;

  select coalesce(sum(round((item->>'commission')::numeric,2)),0)::numeric(18,2)
    into calculation_total
  from jsonb_array_elements(p_calculation_snapshot->'model'->'calculations') item;
  select coalesce(sum(round((item->>'commission')::numeric,2)),0)::numeric(18,2)
    into style_total
  from jsonb_array_elements(p_calculation_snapshot->'model'->'styles') item;

  if calculation_total <> round(p_commission_total,2)
     or style_total <> round(p_commission_total,2)
     or round((p_calculation_snapshot#>>'{model,commission}')::numeric,2) <> round(p_commission_total,2) then
    raise exception 'Statement totals do not reconcile with the quarterly report';
  end if;

  if exists (
    select 1 from public.statements s
    where s.recipient_id=p_recipient_id and s.year=p_year and s.quarter=p_quarter
      and not exists (
        select 1 from public.audit_events a
        where a.entity_table='statements' and a.entity_id=s.id and a.action='statement_approval_revoked'
      )
  ) then
    raise exception 'This recipient already has an active approved statement for the quarter';
  end if;

  insert into public.statements(
    period_id,recipient_id,batch_id,recipient_snapshot,calculation_snapshot,adjustment_snapshot,
    commission_total,adjustment_total,total,year,quarter,starts_on,ends_on,finalization_id,
    finalization_snapshot,approved_at,approved_by
  ) values (
    null,p_recipient_id,null,
    p_recipient_snapshot,p_calculation_snapshot,'[]'::jsonb,
    round(p_commission_total,2),0,round(p_commission_total,2),
    p_year,p_quarter,q.quarter_start,q.quarter_end,q.id,to_jsonb(q),now(),actor
  ) returning * into result;

  insert into public.audit_events(actor_id,action,entity_table,entity_id,details)
  values(actor,'statement_approved','statements',result.id,
    jsonb_build_object('recipient_id',p_recipient_id,'recipient_name',recipient_name,
      'year',p_year,'quarter',p_quarter,'amount',result.total,'finalization_id',q.id));
  return result;
end;
$$;

create or replace function public.record_statement_payout(
  p_statement_id uuid,
  p_amount numeric,
  p_paid_on date,
  p_method text,
  p_reference text default '',
  p_note text default ''
)
returns public.payouts
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  actor uuid := auth.uid();
  s public.statements;
  paid numeric(18,2);
  result public.payouts;
begin
  if actor is null or not exists(select 1 from public.admin_members where user_id=actor) then
    raise exception 'Administrator access is required';
  end if;
  if p_amount is null or round(p_amount,2) <= 0 then raise exception 'Payment amount must be greater than zero'; end if;
  if p_paid_on is null then raise exception 'Payment date is required'; end if;
  if p_method not in ('Zelle','ACH','PayPal','Check','Cash','Other') then raise exception 'Select a valid payment method'; end if;

  select * into s from public.statements where id=p_statement_id for update;
  if s.id is null or s.approved_at is null then raise exception 'Approve the statement before recording payment'; end if;
  if exists(select 1 from public.audit_events where entity_table='statements' and entity_id=s.id and action='statement_approval_revoked') then
    raise exception 'This statement approval was revoked';
  end if;
  select coalesce(sum(amount),0)::numeric(18,2) into paid from public.payouts where statement_id=s.id;
  if paid + round(p_amount,2) > s.total then
    raise exception 'Payment exceeds the remaining approved amount';
  end if;

  insert into public.payouts(statement_id,amount,paid_on,method,reference,notes,created_by)
  values(s.id,round(p_amount,2),p_paid_on,p_method,coalesce(trim(p_reference),''),coalesce(trim(p_note),''),actor)
  returning * into result;

  insert into public.audit_events(actor_id,action,entity_table,entity_id,details)
  values(actor,'payout_recorded','payouts',result.id,
    jsonb_build_object('statement_id',s.id,'recipient_id',s.recipient_id,'year',s.year,'quarter',s.quarter,
      'amount',result.amount,'paid_on',result.paid_on,'method',result.method,'reference',result.reference));
  return result;
end;
$$;

create or replace function public.revoke_statement_approval(p_statement_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  actor uuid := auth.uid();
  s public.statements;
begin
  if actor is null or not exists(select 1 from public.admin_members where user_id=actor) then
    raise exception 'Administrator access is required';
  end if;
  select * into s from public.statements where id=p_statement_id for update;
  if s.id is null or s.approved_at is null then raise exception 'Approved statement not found'; end if;
  if exists(select 1 from public.payouts where statement_id=s.id) then
    raise exception 'Approval cannot be revoked after a payment has been recorded';
  end if;
  if exists(select 1 from public.audit_events where entity_table='statements' and entity_id=s.id and action='statement_approval_revoked') then
    raise exception 'This statement approval was already revoked';
  end if;

  insert into public.audit_events(actor_id,action,entity_table,entity_id,details)
  values(actor,'statement_approval_revoked','statements',s.id,
    jsonb_build_object('recipient_id',s.recipient_id,'year',s.year,'quarter',s.quarter,'amount',s.total));
  return s.id;
end;
$$;

revoke all on function public.approve_recipient_statement(uuid,integer,integer,jsonb,jsonb,numeric) from public,anon;
revoke all on function public.record_statement_payout(uuid,numeric,date,text,text,text) from public,anon;
revoke all on function public.revoke_statement_approval(uuid) from public,anon;
grant execute on function public.approve_recipient_statement(uuid,integer,integer,jsonb,jsonb,numeric) to authenticated;
grant execute on function public.record_statement_payout(uuid,numeric,date,text,text,text) to authenticated;
grant execute on function public.revoke_statement_approval(uuid) to authenticated;
