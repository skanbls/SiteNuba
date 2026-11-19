-- =====================================================================
-- Nuba Gestion · migration 0016 · accès de la comptable
--
-- À exécuter une seule fois dans Supabase, après la 0015 :
--   SQL Editor > New query > coller tout ce fichier > Run.
-- Supabase doit répondre « Success. No rows returned ».
--
-- La comptable n'est pas une personne de l'équipe : elle n'a pas de fiche dans profiles,
-- donc aucune règle de l'équipe ne lui ouvre quoi que ce soit (planning, réservations,
-- clients…). Le gérant enregistre son adresse e-mail ; elle crée son compte avec cette
-- adresse. Elle lit les heures travaillées par la seule fonction hours_report : noms,
-- contrats, heures prévues au contrat, pointages et pauses. Ni notes, ni coordonnées.
-- =====================================================================
begin;

create table public.accountants (
  id           uuid primary key default gen_random_uuid(),
  email        text not null unique check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  name         text not null default '' check (length(name) <= 80),
  user_id      uuid unique references auth.users (id) on delete set null,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz
);

create function public.accountants_normalize() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.email := lower(btrim(new.email));
  new.name := btrim(new.name);
  if exists (select 1 from public.profiles where email = new.email) then
    raise exception 'Cette adresse est déjà celle d''une personne de l''équipe.' using errcode = 'P0001';
  end if;
  -- Changer l'adresse détache le compte : la nouvelle adresse devra créer le sien.
  if tg_op = 'UPDATE' and new.email is distinct from old.email then new.user_id := null; end if;
  return new;
end $$;
create trigger accountants_normalize before insert or update on public.accountants
  for each row execute function public.accountants_normalize();

-- Accès comptable du compte connecté, ou null. Jamais par code PIN (pas de compte).
create function public._accountant_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select id from public.accountants where user_id = (select auth.uid()) and active
$$;

-- À la connexion : rattache le compte (adresse confirmée) à l'accès prévu par le gérant.
-- Renvoie {id, name, email}, ou null si ce compte n'a pas d'accès comptable.
create function public.accountant_me() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid  uuid := auth.uid();
  mail text;
  a    public.accountants;
begin
  if uid is null then return null; end if;
  select * into a from public.accountants where user_id = uid and active;
  if not found then
    select lower(email) into mail from auth.users where id = uid and email_confirmed_at is not null;
    if mail is null then return null; end if;
    update public.accountants set user_id = uid where email = mail and user_id is null and active returning * into a;
    if not found then return null; end if;
  end if;
  update public.accountants set last_seen_at = now() where id = a.id;
  return jsonb_build_object('id', a.id, 'name', a.name, 'email', a.email);
end $$;

-- Heures travaillées du p_from au p_to inclus (jours de Paris). Pour la comptable et le gérant.
-- Même forme que les pointages lus par l'appli, sans les notes.
create function public.hours_report(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  t0 timestamptz;
  t1 timestamptz;
begin
  if public._accountant_id() is null and not public.is_gerant() then
    raise exception 'Réservé à la comptable et au gérant.' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'Choisis une période de 400 jours au plus.' using errcode = 'P0001';
  end if;
  t0 := p_from::timestamp at time zone 'Europe/Paris';
  t1 := (p_to + 1)::timestamp at time zone 'Europe/Paris';
  return jsonb_build_object(
    'people', (select coalesce(jsonb_agg(jsonb_build_object(
                  'id', p.id, 'first_name', p.first_name, 'last_name', p.last_name, 'contract', p.contract,
                  'weekly_hours', p.weekly_hours, 'active', p.active) order by p.first_name, p.last_name), '[]'::jsonb)
               from public.profiles p
               where p.active or exists (select 1 from public.time_entries e where e.profile_id = p.id and e.clock_in >= t0 and e.clock_in < t1)),
    'entries', (select coalesce(jsonb_agg(jsonb_build_object(
                  'id', e.id, 'profile_id', e.profile_id, 'site_id', e.site_id, 'clock_in', e.clock_in, 'clock_out', e.clock_out,
                  'source', e.source, 'note', '', 'needs_review', e.needs_review,
                  'profiles', jsonb_build_object('first_name', p.first_name, 'last_name', p.last_name),
                  'sites', case when s.id is null then null else jsonb_build_object('name', s.name) end,
                  'time_breaks', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'entry_id', b.entry_id, 'started_at', b.started_at, 'ended_at', b.ended_at)
                                                            order by b.started_at), '[]'::jsonb)
                                  from public.time_breaks b where b.entry_id = e.id))
                  order by e.clock_in), '[]'::jsonb)
                from public.time_entries e
                join public.profiles p on p.id = e.profile_id
                left join public.sites s on s.id = e.site_id
                where e.clock_in >= t0 and e.clock_in < t1));
end $$;

alter table public.accountants enable row level security;
revoke all on public.accountants from anon, authenticated;
grant select, insert, update, delete on public.accountants to authenticated;
create policy "comptables: gerant" on public.accountants
  for all to authenticated using ((select public.is_gerant())) with check ((select public.is_gerant()));

revoke all on function public.accountants_normalize(), public._accountant_id(), public.accountant_me(), public.hours_report(date, date)
  from public, anon, authenticated;
grant execute on function public.accountant_me(), public.hours_report(date, date) to authenticated;

commit;
