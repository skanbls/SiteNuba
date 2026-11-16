-- =====================================================================
-- Nuba Gestion · migration 0002 · planning, congés et échanges de service
--
-- À exécuter une seule fois dans Supabase, après la 0001 :
--   SQL Editor > New query > coller tout ce fichier > Run.
--
-- Principes :
--   * toute l'équipe voit le planning ; seul le gérant l'écrit ;
--   * chacun demande ses congés et propose de céder un service à un collègue ;
--   * le gérant accepte ou refuse ; un échange accepté change le service de main.
-- =====================================================================

-- ---------- Services planifiés ----------------------------------------
create table public.shifts (
  id         uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  site_id    uuid references public.sites (id) on delete set null,
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  area       text not null default '',     -- Salle, Bar, Cuisine…
  note       text not null default '',
  created_at timestamptz not null default now(),
  constraint shifts_order check (ends_at > starts_at),
  constraint shifts_length check (ends_at - starts_at <= interval '16 hours')
);
create index shifts_by_start on public.shifts (starts_at);
create index shifts_by_profile on public.shifts (profile_id, starts_at);

-- Une personne ne peut pas avoir deux services qui se chevauchent.
create function public.shifts_no_overlap() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.area := btrim(new.area);
  new.note := btrim(new.note);
  if exists (
    select 1 from public.shifts s
    where s.profile_id = new.profile_id and s.id <> new.id
      and s.starts_at < new.ends_at and s.ends_at > new.starts_at
  ) then
    raise exception 'Cette personne a déjà un service sur ce créneau.' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger shifts_no_overlap before insert or update on public.shifts
  for each row execute function public.shifts_no_overlap();

-- ---------- Congés et indisponibilités ---------------------------------
create table public.leave_requests (
  id         uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  kind       text not null default 'conge' check (kind in ('conge', 'indisponibilite')),
  start_date date not null,
  end_date   date not null,
  note       text not null default '',
  status     text not null default 'pending' check (status in ('pending', 'approved', 'refused')),
  decided_by uuid references public.profiles (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  constraint leave_requests_order check (end_date >= start_date),
  constraint leave_requests_length check (end_date - start_date <= 92)
);
create index leave_requests_by_profile on public.leave_requests (profile_id, start_date);
create index leave_requests_by_date on public.leave_requests (start_date, end_date);

-- Le gérant accepte ou refuse une demande de congé.
create function public.decide_leave(p_id uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_gerant() then
    raise exception 'Réservé au gérant.' using errcode = '42501';
  end if;
  update public.leave_requests
    set status = case when p_approve then 'approved' else 'refused' end,
        decided_by = public.my_profile_id(), decided_at = now()
    where id = p_id;
  if not found then raise exception 'Demande introuvable.' using errcode = 'P0001'; end if;
end $$;

-- ---------- Échanges : céder un service à un collègue -------------------
create table public.shift_swaps (
  id           uuid primary key default gen_random_uuid(),
  shift_id     uuid not null references public.shifts (id) on delete cascade,
  from_profile uuid not null references public.profiles (id) on delete cascade,
  to_profile   uuid not null references public.profiles (id) on delete cascade,
  note         text not null default '',
  status       text not null default 'pending' check (status in ('pending', 'approved', 'refused')),
  decided_by   uuid references public.profiles (id) on delete set null,
  decided_at   timestamptz,
  created_at   timestamptz not null default now(),
  constraint shift_swaps_distinct check (from_profile <> to_profile)
);
-- Une seule demande en attente par service.
create unique index shift_swaps_one_pending on public.shift_swaps (shift_id) where status = 'pending';
create index shift_swaps_by_people on public.shift_swaps (from_profile, to_profile);

-- Proposer de céder un de ses services à venir à un collègue.
create function public.request_swap(p_shift uuid, p_to uuid, p_note text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me_id uuid := public.my_profile_id();
  v_id  uuid;
begin
  if me_id is null then raise exception 'Compte non rattaché à l''équipe.' using errcode = '42501'; end if;
  if not exists (select 1 from public.shifts where id = p_shift and profile_id = me_id and starts_at > now()) then
    raise exception 'Tu ne peux céder qu''un de tes services à venir.' using errcode = 'P0001';
  end if;
  if p_to = me_id or not exists (select 1 from public.profiles where id = p_to and active) then
    raise exception 'Choisis un collègue de l''équipe.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.shift_swaps where shift_id = p_shift and status = 'pending') then
    raise exception 'Une demande est déjà en attente pour ce service.' using errcode = 'P0001';
  end if;
  insert into public.shift_swaps (shift_id, from_profile, to_profile, note)
    values (p_shift, me_id, p_to, coalesce(btrim(p_note), ''))
    returning id into v_id;
  return v_id;
end $$;

-- Le gérant accepte ou refuse un échange. Accepté, le service passe au collègue.
create function public.decide_swap(p_id uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  w public.shift_swaps;
begin
  if not public.is_gerant() then
    raise exception 'Réservé au gérant.' using errcode = '42501';
  end if;
  select * into w from public.shift_swaps where id = p_id and status = 'pending' for update;
  if not found then raise exception 'Demande introuvable ou déjà traitée.' using errcode = 'P0001'; end if;
  if p_approve then
    update public.shifts set profile_id = w.to_profile where id = w.shift_id and profile_id = w.from_profile;
    if not found then raise exception 'Ce service a changé depuis la demande.' using errcode = 'P0001'; end if;
  end if;
  update public.shift_swaps
    set status = case when p_approve then 'approved' else 'refused' end,
        decided_by = public.my_profile_id(), decided_at = now()
    where id = p_id;
end $$;

-- ---------- Sécurité : droits et RLS -----------------------------------
alter table public.shifts         enable row level security;
alter table public.leave_requests enable row level security;
alter table public.shift_swaps    enable row level security;

revoke all on public.shifts, public.leave_requests, public.shift_swaps from anon, authenticated;
grant select, insert, update, delete on public.shifts to authenticated;
grant select, insert, delete on public.leave_requests to authenticated;
grant select, delete on public.shift_swaps to authenticated;

-- Planning : lu par toute l'équipe, écrit par le gérant.
create policy "planning: lecture par les membres" on public.shifts
  for select to authenticated using ((select public.my_profile_id()) is not null);
create policy "planning: ajout par le gerant" on public.shifts
  for insert to authenticated with check ((select public.is_gerant()));
create policy "planning: modification par le gerant" on public.shifts
  for update to authenticated using ((select public.is_gerant())) with check ((select public.is_gerant()));
create policy "planning: suppression par le gerant" on public.shifts
  for delete to authenticated using ((select public.is_gerant()));

-- Congés : chacun voit les siens, gérant et responsables voient ceux de l'équipe.
-- Les congés acceptés sont visibles de tous, pour savoir qui est absent.
create policy "conges: lecture" on public.leave_requests
  for select to authenticated
  using (profile_id = (select public.my_profile_id()) or (select public.is_manager())
         or (status = 'approved' and (select public.my_profile_id()) is not null));
-- Chacun demande pour soi, en attente ; le gérant peut saisir directement une absence.
create policy "conges: demande" on public.leave_requests
  for insert to authenticated
  with check ((select public.is_gerant())
              or (profile_id = (select public.my_profile_id()) and status = 'pending'
                  and decided_by is null and decided_at is null));
-- Chacun annule sa demande tant qu'elle attend ; le gérant peut tout supprimer.
create policy "conges: annulation" on public.leave_requests
  for delete to authenticated
  using ((select public.is_gerant())
         or (profile_id = (select public.my_profile_id()) and status = 'pending'));

-- Échanges : vus par les deux personnes concernées et par les responsables.
create policy "echanges: lecture" on public.shift_swaps
  for select to authenticated
  using (from_profile = (select public.my_profile_id()) or to_profile = (select public.my_profile_id())
         or (select public.is_manager()));
create policy "echanges: annulation" on public.shift_swaps
  for delete to authenticated
  using ((select public.is_gerant())
         or (from_profile = (select public.my_profile_id()) and status = 'pending'));

revoke all on function
  public.decide_leave(uuid, boolean), public.request_swap(uuid, uuid, text), public.decide_swap(uuid, boolean)
  from public, anon;
grant execute on function
  public.decide_leave(uuid, boolean), public.request_swap(uuid, uuid, text), public.decide_swap(uuid, boolean)
  to authenticated;
revoke all on function public.shifts_no_overlap() from public, anon, authenticated;
