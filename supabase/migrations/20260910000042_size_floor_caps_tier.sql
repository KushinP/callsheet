-- ============================================================================
-- A property below the size floor cannot be tier A, whoever scored it.
--
-- Twelve leads under six rooms were tier A or B, ranked alongside a 21-room
-- inn, while three of the first eight real conversations died on room count.
-- The scorer was never going to catch it: room counts left metadata_json when
-- room_count became a column, and leads_needing_brief never selected the
-- column, so the brief model has not seen a single room count since.
--
-- The floor belongs to the workspace, because what is too small is a fact
-- about what you sell. The cap is applied in the generated tier rather than by
-- overwriting tier_suggested: the model's opinion survives, a human override
-- still wins, and lowering the floor later restores every tier it capped
-- without re-scoring anything. Unknown room count is never disqualifying.
-- ============================================================================

alter table public.workspaces
  add column if not exists min_rooms integer
  check (min_rooms is null or min_rooms > 0);

comment on column public.workspaces.min_rooms is
  'Smallest property worth calling. A lead with a known room count under this is capped at tier c.';

alter table public.leads
  add column if not exists below_size_floor boolean not null default false;

create or replace function public.mark_lead_size_floor()
returns trigger language plpgsql set search_path = public
as $$
declare size_floor integer;
begin
  select w.min_rooms into size_floor from public.workspaces w where w.id = new.workspace_id;
  -- Unknown is not small: a lead with no room count is never disqualified by it.
  new.below_size_floor := coalesce(new.room_count < size_floor, false);
  return new;
end;
$$;

drop trigger if exists leads_mark_size_floor on public.leads;
create trigger leads_mark_size_floor
  before insert or update of room_count, workspace_id on public.leads
  for each row execute function public.mark_lead_size_floor();

create or replace function public.remark_workspace_size_floor()
returns trigger language plpgsql set search_path = public
as $$
begin
  update public.leads l
     set below_size_floor = coalesce(l.room_count < new.min_rooms, false)
   where l.workspace_id = new.id
     and l.below_size_floor is distinct from coalesce(l.room_count < new.min_rooms, false);
  return new;
end;
$$;

drop trigger if exists workspaces_remark_size_floor on public.workspaces;
create trigger workspaces_remark_size_floor
  after update of min_rooms on public.workspaces
  for each row when (new.min_rooms is distinct from old.min_rooms)
  execute function public.remark_workspace_size_floor();

-- A generated expression cannot be altered in place, so the column is rebuilt
-- with its index. Nothing else depends on it: no view or policy reads it.
drop index if exists public.leads_workspace_tier_idx;
alter table public.leads drop column if exists tier;
alter table public.leads
  add column tier public.lead_tier
  generated always as (
    coalesce(
      tier_override,
      case when below_size_floor then 'c'::public.lead_tier else tier_suggested end
    )
  ) stored;
create index if not exists leads_workspace_tier_idx
  on public.leads (workspace_id, tier) where tier is not null;

-- The brief model gets the room count and the contact name. Return shape
-- changes, so drop and create rather than replace.
drop function if exists public.leads_needing_brief(uuid, integer);
create function public.leads_needing_brief(ws uuid, max_rows integer default 25)
returns table (
  id uuid, business_name text, contact_name text, room_count integer, phone text,
  address text, city text, state text, zip text, website text, email text,
  notes text, metadata_json jsonb
)
language plpgsql
stable
set search_path = public
as $$
begin
  if not public.is_workspace_member(ws) then
    raise exception 'not a member of workspace %', ws using errcode = '42501';
  end if;

  return query
  select l.id, l.business_name, l.contact_name, l.room_count, l.phone, l.address,
         l.city, l.state, l.zip, l.website, l.email, l.notes, l.metadata_json
  from public.leads l
  where l.workspace_id = ws
    and not l.do_not_call
    and not exists (
      select 1 from public.documents d
      where d.lead_id = l.id and d.kind = 'lead_brief'
    )
  order by l.created_at desc
  limit greatest(least(max_rows, 50), 1);
end;
$$;

revoke execute on function public.leads_needing_brief(uuid, integer) from public, anon;
grant  execute on function public.leads_needing_brief(uuid, integer) to authenticated, service_role;
