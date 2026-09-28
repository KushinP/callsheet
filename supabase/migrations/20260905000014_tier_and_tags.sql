-- ============================================================================
-- Tier and tags.
--
-- The tier question — "how does a human override survive Claude's next brief
-- run?" — is answered structurally rather than with a WHERE clause someone can
-- forget. Claude writes tier_suggested; a human writes tier_override; `tier` is
-- generated and cannot be written at all, so an attempt to set it errors
-- immediately instead of quietly winning.
-- ============================================================================

create type public.lead_tier as enum ('a', 'b', 'c');

-- Playbook due dates say things like "+3 days at 09:00", which has to mean 9am
-- where the rep lives. Every RPC takes tz from the browser, but a trigger has no
-- caller to ask — without this, every task lands at 9am UTC and is silently
-- overdue before anyone sees it.
alter table public.workspaces
  add column if not exists timezone text not null default 'UTC';

create or replace function public.validate_lead_tags(tags text[])
returns text                          -- null when valid, else the first problem
language plpgsql immutable set search_path = public
as $$
declare t text;
begin
  if tags is null then return null; end if;
  if cardinality(tags) > 12 then
    return format('a lead can carry at most 12 tags, got %s', cardinality(tags));
  end if;
  foreach t in array tags loop
    if t !~ '^[a-z0-9][a-z0-9 _-]{0,31}$' then
      return format('tag "%s" is not lowercase alphanumeric, 1-32 chars', t);
    end if;
  end loop;
  return null;
end;
$$;

alter table public.leads
  add column if not exists tier_suggested public.lead_tier,
  -- The moment a human decides whether to override is the moment they need to
  -- know why Claude said C. Making them open a document to find out means they
  -- will not.
  add column if not exists tier_suggested_reason text,
  add column if not exists tier_override public.lead_tier,
  add column if not exists tier public.lead_tier
    generated always as (coalesce(tier_override, tier_suggested)) stored,
  add column if not exists tags text[] not null default '{}'::text[];

alter table public.leads
  add constraint leads_tier_reason_bounded
    check (tier_suggested_reason is null or length(tier_suggested_reason) <= 280),
  add constraint leads_tags_valid
    check (public.validate_lead_tags(tags) is null);

-- Normalisation is a trigger, not a generated column: a generated column cannot
-- contain DISTINCT or a subquery, so array dedupe is impossible there.
-- Lossless on purpose — it never truncates, because silently dropping the 13th
-- tag is worse than the CHECK's loud rejection.
create or replace function public.normalize_lead_tags()
returns trigger language plpgsql set search_path = public
as $$
begin
  if new.tags is not null then
    new.tags := coalesce(
      (select array_agg(distinct lower(btrim(t)) order by lower(btrim(t)))
         from unnest(new.tags) t where btrim(t) <> ''),
      '{}'::text[]);
  end if;
  return new;
end;
$$;

drop trigger if exists leads_normalize_tags on public.leads;
create trigger leads_normalize_tags
  before insert or update of tags on public.leads
  for each row execute function public.normalize_lead_tags();

create index if not exists leads_workspace_tier_idx
  on public.leads (workspace_id, tier) where tier is not null;
create index if not exists leads_tags_idx on public.leads using gin (tags);

-- One statement, so add/remove is atomic, and shared by the app and the MCP
-- tool rather than each reimplementing read-modify-write.
create or replace function public.set_lead_tags(
  lead uuid, new_tags text[], mode text default 'replace'
)
returns text[]
language plpgsql security invoker set search_path = public
as $$
declare ws uuid; result text[];
begin
  -- Already under RLS, so a foreign lead is simply invisible. Gating on it
  -- explicitly turns "silently changed nothing" into a real error.
  select workspace_id into ws from public.leads where id = lead;
  if ws is null then
    raise exception 'lead % is not visible to this account', lead using errcode = '42501';
  end if;
  if mode not in ('replace', 'add', 'remove') then
    raise exception 'mode must be replace, add or remove' using errcode = '22023';
  end if;

  update public.leads l
     set tags = case mode
       when 'replace' then new_tags
       when 'add'     then l.tags || new_tags        -- the trigger dedupes and sorts
       when 'remove'  then array(
         select t from unnest(l.tags) t
         where not (t = any (select lower(btrim(x)) from unnest(new_tags) x)))
     end
   where l.id = lead
   returning l.tags into result;

  return result;
end;
$$;

revoke execute on function public.normalize_lead_tags() from public, anon, authenticated;
revoke execute on function public.validate_lead_tags(text[]) from public, anon;
revoke execute on function public.set_lead_tags(uuid, text[], text) from public, anon;
grant  execute on function public.validate_lead_tags(text[]) to authenticated, service_role;
grant  execute on function public.set_lead_tags(uuid, text[], text) to authenticated, service_role;
