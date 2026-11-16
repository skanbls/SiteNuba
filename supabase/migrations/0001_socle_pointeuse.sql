-- =====================================================================
-- Nuba Gestion · migration 0001 · socle (équipe, rôles) et pointeuse
--
-- À exécuter une seule fois dans Supabase :
--   SQL Editor > New query > coller tout ce fichier > Run.
--
-- Principes :
--   * chaque membre de l'équipe a une ligne dans `profiles`, créée par le
--     gérant ; elle se rattache à son compte quand il s'inscrit avec la
--     même adresse e-mail (fonction `me`) ;
--   * le tout premier compte confirmé devient le gérant ;
--   * on pointe en prouvant sa présence : un code à 6 chiffres, affiché sur
--     la borne (iPad) et renouvelé toutes les 30 secondes, est exigé à
--     l'arrivée et au départ (fonction `punch`) ;
--   * la sécurité repose sur les règles RLS ci-dessous, pas sur l'appli.
-- =====================================================================

-- ---------- Types ----------------------------------------------------
create type public.app_role as enum ('gerant', 'responsable', 'equipier');
create type public.contract_type as enum ('cdi', 'cdd', 'extra', 'autre');

-- ---------- Équipe ---------------------------------------------------
create table public.profiles (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid unique references auth.users (id) on delete set null,
  email        text not null,
  first_name   text not null check (length(btrim(first_name)) > 0),
  last_name    text not null default '',
  role         public.app_role not null default 'equipier',
  job          text not null default '',
  contract     public.contract_type not null default 'cdi',
  weekly_hours numeric(4, 1) not null default 35 check (weekly_hours between 0 and 60),
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);
create unique index profiles_email_key on public.profiles (email);

create function public.profiles_normalize() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.email := lower(btrim(new.email));
  new.first_name := btrim(new.first_name);
  new.last_name := btrim(new.last_name);
  new.job := btrim(new.job);
  return new;
end $$;
create trigger profiles_normalize before insert or update on public.profiles
  for each row execute function public.profiles_normalize();

-- Qui suis-je ? Ces fonctions servent aux règles RLS.
create function public.my_profile_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select id from public.profiles where user_id = (select auth.uid()) and active
$$;

create function public.my_role() returns public.app_role
language sql stable security definer set search_path = '' as $$
  select role from public.profiles where user_id = (select auth.uid()) and active
$$;

create function public.is_gerant() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.my_role() = 'gerant', false)
$$;

create function public.is_manager() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.my_role() in ('gerant', 'responsable'), false)
$$;

-- Il doit toujours rester au moins un gérant actif.
create function public.profiles_keep_a_gerant() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.role = 'gerant' and old.active
     and (tg_op = 'DELETE' or new.role <> 'gerant' or not new.active)
     and not exists (select 1 from public.profiles
                     where role = 'gerant' and active and id <> old.id) then
    raise exception 'Il doit rester au moins un gérant actif.' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger profiles_keep_a_gerant before update or delete on public.profiles
  for each row execute function public.profiles_keep_a_gerant();

-- Mon profil. Rattache le compte à sa fiche d'équipe à la première connexion.
create function public.me() returns setof public.profiles
language plpgsql security definer set search_path = '' as $$
declare
  uid     uuid := auth.uid();
  p       public.profiles;
  u_email text;
  u_name  text;
begin
  if uid is null then return; end if;

  select * into p from public.profiles where user_id = uid;
  if not found then
    select lower(email), nullif(btrim(raw_user_meta_data ->> 'first_name'), '')
      into u_email, u_name
      from auth.users where id = uid and email_confirmed_at is not null;
    if u_email is null then return; end if;

    update public.profiles set user_id = uid
      where email = u_email and user_id is null
      returning * into p;

    if not found then
      -- Aucune fiche à cette adresse. S'il n'existe encore aucune équipe,
      -- ce premier compte en devient le gérant.
      perform pg_advisory_xact_lock(7461001);
      if exists (select 1 from public.profiles) then return; end if;
      insert into public.profiles (user_id, email, first_name, role, job)
        values (uid, u_email, coalesce(u_name, initcap(split_part(u_email, '@', 1))), 'gerant', 'Gérant')
        returning * into p;
    end if;
  end if;

  return next p;
end $$;

-- ---------- Lieux de pointage ----------------------------------------
create table public.sites (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) > 0),
  kind       text not null default 'etablissement' check (kind in ('etablissement', 'evenement')),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- Le secret de chaque lieu ne sort jamais de la base.
create table public.site_secrets (
  site_id uuid primary key references public.sites (id) on delete cascade,
  secret  bytea not null
);

create function public.sites_make_secret() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.site_secrets (site_id, secret)
    values (new.id, decode(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex'));
  return new;
end $$;
create trigger sites_make_secret after insert on public.sites
  for each row execute function public.sites_make_secret();

insert into public.sites (name) values ('La Nuba');

-- Code à 6 chiffres d'un lieu pour une tranche de 30 secondes.
create function public._site_code(p_site uuid, p_step bigint) returns text
language sql stable security definer set search_path = '' as $$
  select lpad((('x' || substr(encode(sha256(s.secret || convert_to(p_step::text, 'UTF8')), 'hex'), 1, 8))::bit(32)::bigint % 1000000)::text, 6, '0')
  from public.site_secrets s where s.site_id = p_site
$$;

create function public._code_payload(p_site uuid) returns jsonb
language sql volatile security definer set search_path = '' as $$
  select jsonb_build_object(
    'site_id', s.id,
    'site_name', s.name,
    'code', public._site_code(s.id, floor(extract(epoch from clock_timestamp()) / 30)::bigint),
    'seconds_left', 30 - (floor(extract(epoch from clock_timestamp()))::bigint % 30))
  from public.sites s where s.id = p_site and s.active
$$;

-- ---------- Bornes (iPad qui affiche le code) -------------------------
create table public.kiosks (
  id           uuid primary key default gen_random_uuid(),
  site_id      uuid not null references public.sites (id) on delete cascade,
  label        text not null check (length(btrim(label)) > 0),
  token_hash   bytea not null unique,
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at   timestamptz
);

-- Crée une borne et renvoie son jeton, visible une seule fois.
create function public.create_kiosk(p_site uuid, p_label text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  t text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  if not public.is_gerant() then
    raise exception 'Réservé au gérant.' using errcode = '42501';
  end if;
  insert into public.kiosks (site_id, label, token_hash, created_by)
    values (p_site, btrim(p_label), sha256(convert_to(t, 'UTF8')), public.my_profile_id());
  return t;
end $$;

-- Code affiché par une borne. Appelable sans compte, avec le jeton de la borne.
create function public.kiosk_code(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  k public.kiosks;
begin
  select * into k from public.kiosks
    where token_hash = sha256(convert_to(coalesce(p_token, ''), 'UTF8')) and revoked_at is null;
  if not found then return null; end if;
  update public.kiosks set last_seen_at = now()
    where id = k.id and (last_seen_at is null or last_seen_at < now() - interval '2 minutes');
  return public._code_payload(k.site_id);
end $$;

-- Code affiché sur le téléphone d'un responsable (prestation extérieure).
create function public.site_code(p_site uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_manager() then
    raise exception 'Réservé aux responsables.' using errcode = '42501';
  end if;
  return public._code_payload(p_site);
end $$;

-- ---------- Pointages ------------------------------------------------
create table public.time_entries (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null references public.profiles (id) on delete restrict,
  site_id      uuid references public.sites (id) on delete set null,
  clock_in     timestamptz not null,
  clock_out    timestamptz,
  source       text not null default 'qr' check (source in ('qr', 'manuel')),
  note         text not null default '',
  needs_review boolean not null default false,
  created_at   timestamptz not null default now(),
  constraint time_entries_order check (clock_out is null or clock_out >= clock_in)
);
-- Une seule présence ouverte par personne.
create unique index time_entries_one_open on public.time_entries (profile_id) where clock_out is null;
create index time_entries_by_profile on public.time_entries (profile_id, clock_in desc);
create index time_entries_by_day on public.time_entries (clock_in desc);

create table public.time_breaks (
  id         uuid primary key default gen_random_uuid(),
  entry_id   uuid not null references public.time_entries (id) on delete cascade,
  started_at timestamptz not null,
  ended_at   timestamptz,
  constraint time_breaks_order check (ended_at is null or ended_at >= started_at)
);
create unique index time_breaks_one_open on public.time_breaks (entry_id) where ended_at is null;
create index time_breaks_by_entry on public.time_breaks (entry_id);

-- Codes refusés, pour limiter les essais.
create table public.punch_failures (
  profile_id uuid not null references public.profiles (id) on delete cascade,
  at         timestamptz not null default now()
);
create index punch_failures_recent on public.punch_failures (profile_id, at desc);

-- Journal des corrections faites à la main.
create table public.time_entry_audit (
  id         bigint generated always as identity primary key,
  entry_id   uuid not null,
  action     text not null,
  changed_by uuid,
  changed_at timestamptz not null default now(),
  old_row    jsonb,
  new_row    jsonb
);
create index time_entry_audit_by_entry on public.time_entry_audit (entry_id, changed_at desc);

create function public.time_entries_audit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- Les pointages normaux (arrivée, départ) ne sont pas des corrections.
  if coalesce(current_setting('nuba.via_punch', true), '') = '1' then return null; end if;
  if tg_op = 'INSERT' then
    insert into public.time_entry_audit (entry_id, action, changed_by, new_row)
      values (new.id, 'ajout', public.my_profile_id(), to_jsonb(new));
  elsif tg_op = 'UPDATE' then
    insert into public.time_entry_audit (entry_id, action, changed_by, old_row, new_row)
      values (new.id, 'modification', public.my_profile_id(), to_jsonb(old), to_jsonb(new));
  else
    insert into public.time_entry_audit (entry_id, action, changed_by, old_row)
      values (old.id, 'suppression', public.my_profile_id(), to_jsonb(old));
  end if;
  return null;
end $$;
create trigger time_entries_audit after insert or update or delete on public.time_entries
  for each row execute function public.time_entries_audit();

-- Pointer son arrivée ('in') ou son départ ('out') avec le code du lieu.
-- Renvoie {ok:true, action, entry} ou {ok:false, error}.
create function public.punch(p_site uuid, p_code text, p_action text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me_id    uuid := public.my_profile_id();
  step     bigint := floor(extract(epoch from clock_timestamp()) / 30)::bigint;
  e        public.time_entries;
  has_open boolean;
  fails    int;
begin
  if me_id is null then return jsonb_build_object('ok', false, 'error', 'no_profile'); end if;
  if p_action is null or p_action not in ('in', 'out') then
    return jsonb_build_object('ok', false, 'error', 'action');
  end if;

  select count(*) into fails from public.punch_failures
    where profile_id = me_id and at > now() - interval '10 minutes';
  if fails >= 8 then return jsonb_build_object('ok', false, 'error', 'too_many'); end if;

  if not exists (select 1 from public.sites where id = p_site and active) then
    return jsonb_build_object('ok', false, 'error', 'site');
  end if;

  -- Le code de la tranche en cours ou de la précédente est accepté.
  if p_code is null
     or btrim(p_code) not in (public._site_code(p_site, step), public._site_code(p_site, step - 1)) then
    insert into public.punch_failures (profile_id) values (me_id);
    return jsonb_build_object('ok', false, 'error', 'code');
  end if;

  perform set_config('nuba.via_punch', '1', true);
  select * into e from public.time_entries where profile_id = me_id and clock_out is null;
  has_open := found;

  -- Départ oublié : on ferme la présence restée ouverte et on la signale au gérant.
  if has_open and e.clock_in < clock_timestamp() - interval '16 hours' then
    update public.time_breaks set ended_at = started_at where entry_id = e.id and ended_at is null;
    update public.time_entries
      set clock_out = clock_in, needs_review = true, note = btrim(note || ' Départ non pointé.')
      where id = e.id;
    has_open := false;
    if p_action = 'out' then return jsonb_build_object('ok', false, 'error', 'stale_closed'); end if;
  end if;

  if p_action = 'in' then
    if has_open then return jsonb_build_object('ok', false, 'error', 'already_in'); end if;
    insert into public.time_entries (profile_id, site_id, clock_in, source)
      values (me_id, p_site, clock_timestamp(), 'qr') returning * into e;
  else
    if not has_open then return jsonb_build_object('ok', false, 'error', 'not_in'); end if;
    update public.time_breaks set ended_at = clock_timestamp() where entry_id = e.id and ended_at is null;
    update public.time_entries set clock_out = clock_timestamp() where id = e.id returning * into e;
  end if;

  delete from public.punch_failures where profile_id = me_id;
  return jsonb_build_object('ok', true, 'action', p_action, 'entry', to_jsonb(e));
end $$;

-- Commencer ('start') ou terminer ('end') une pause. Pas de code exigé.
create function public.punch_break(p_action text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me_id uuid := public.my_profile_id();
  e     public.time_entries;
begin
  if me_id is null then return jsonb_build_object('ok', false, 'error', 'no_profile'); end if;
  select * into e from public.time_entries where profile_id = me_id and clock_out is null;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_in'); end if;

  if p_action = 'start' then
    if exists (select 1 from public.time_breaks where entry_id = e.id and ended_at is null) then
      return jsonb_build_object('ok', false, 'error', 'already_paused');
    end if;
    insert into public.time_breaks (entry_id, started_at) values (e.id, clock_timestamp());
  elsif p_action = 'end' then
    update public.time_breaks set ended_at = clock_timestamp() where entry_id = e.id and ended_at is null;
    if not found then return jsonb_build_object('ok', false, 'error', 'not_paused'); end if;
  else
    return jsonb_build_object('ok', false, 'error', 'action');
  end if;
  return jsonb_build_object('ok', true, 'action', p_action);
end $$;

-- Correction ou ajout manuel par le gérant. Tracé dans time_entry_audit.
create function public.save_time_entry(
  p_id uuid, p_profile uuid, p_site uuid,
  p_in timestamptz, p_out timestamptz, p_break_minutes int, p_note text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := p_id;
  brk  int := greatest(coalesce(p_break_minutes, 0), 0);
begin
  if not public.is_gerant() then
    raise exception 'Réservé au gérant.' using errcode = '42501';
  end if;
  if p_in is null then raise exception 'Heure d''arrivée manquante.' using errcode = 'P0001'; end if;
  if p_out is not null and p_out < p_in then
    raise exception 'Le départ est avant l''arrivée.' using errcode = 'P0001';
  end if;
  if p_out is not null and p_in + make_interval(mins => brk) > p_out then
    raise exception 'La pause est plus longue que la présence.' using errcode = 'P0001';
  end if;

  if v_id is null then
    insert into public.time_entries (profile_id, site_id, clock_in, clock_out, source, note)
      values (p_profile, p_site, p_in, p_out, 'manuel', coalesce(btrim(p_note), ''))
      returning id into v_id;
  else
    update public.time_entries
      set site_id = p_site, clock_in = p_in, clock_out = p_out,
          note = coalesce(btrim(p_note), ''), needs_review = false
      where id = v_id;
    if not found then raise exception 'Pointage introuvable.' using errcode = 'P0001'; end if;
    delete from public.time_breaks where entry_id = v_id;
  end if;

  if brk > 0 then
    insert into public.time_breaks (entry_id, started_at, ended_at)
      values (v_id, p_in, p_in + make_interval(mins => brk));
  end if;
  return v_id;
end $$;

-- ---------- Sécurité : RLS -------------------------------------------
alter table public.profiles         enable row level security;
alter table public.sites            enable row level security;
alter table public.site_secrets     enable row level security;
alter table public.kiosks           enable row level security;
alter table public.time_entries     enable row level security;
alter table public.time_breaks      enable row level security;
alter table public.punch_failures   enable row level security;
alter table public.time_entry_audit enable row level security;

-- Droits de base, donnés explicitement pour ne dépendre d'aucun réglage par défaut du projet.
-- Les règles RLS ci-dessous décident ensuite ligne par ligne.
revoke all on public.profiles, public.sites, public.site_secrets, public.kiosks, public.time_entries,
              public.time_breaks, public.punch_failures, public.time_entry_audit
  from anon, authenticated;
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, update on public.sites to authenticated;
grant select, update, delete on public.kiosks to authenticated;
grant select, delete on public.time_entries to authenticated;
grant select on public.time_breaks, public.time_entry_audit to authenticated;
-- site_secrets et punch_failures : aucun accès direct, seulement par les fonctions ci-dessus.

create policy "equipe: lecture par les membres" on public.profiles
  for select to authenticated using ((select public.my_profile_id()) is not null);
create policy "equipe: ajout par le gerant" on public.profiles
  for insert to authenticated with check ((select public.is_gerant()));
create policy "equipe: modification par le gerant" on public.profiles
  for update to authenticated using ((select public.is_gerant())) with check ((select public.is_gerant()));
create policy "equipe: suppression par le gerant" on public.profiles
  for delete to authenticated using ((select public.is_gerant()));

create policy "lieux: lecture par les membres" on public.sites
  for select to authenticated using ((select public.my_profile_id()) is not null);
create policy "lieux: ajout par le gerant" on public.sites
  for insert to authenticated with check ((select public.is_gerant()));
create policy "lieux: modification par le gerant" on public.sites
  for update to authenticated using ((select public.is_gerant())) with check ((select public.is_gerant()));

create policy "bornes: lecture par le gerant" on public.kiosks
  for select to authenticated using ((select public.is_gerant()));
create policy "bornes: revocation par le gerant" on public.kiosks
  for update to authenticated using ((select public.is_gerant())) with check ((select public.is_gerant()));
create policy "bornes: suppression par le gerant" on public.kiosks
  for delete to authenticated using ((select public.is_gerant()));

-- Chacun voit ses pointages ; gérant et responsables voient ceux de l'équipe.
-- Les écritures passent par punch, punch_break et save_time_entry.
create policy "pointages: lecture" on public.time_entries
  for select to authenticated
  using (profile_id = (select public.my_profile_id()) or (select public.is_manager()));
create policy "pointages: suppression par le gerant" on public.time_entries
  for delete to authenticated using ((select public.is_gerant()));

create policy "pauses: lecture" on public.time_breaks
  for select to authenticated
  using (exists (select 1 from public.time_entries e where e.id = entry_id));

create policy "journal: lecture par le gerant" on public.time_entry_audit
  for select to authenticated using ((select public.is_gerant()));

-- ---------- Droits d'exécution des fonctions --------------------------
revoke all on function
  public.my_profile_id(), public.my_role(), public.is_gerant(), public.is_manager(),
  public.me(), public.create_kiosk(uuid, text), public.site_code(uuid),
  public.punch(uuid, text, text), public.punch_break(text),
  public.save_time_entry(uuid, uuid, uuid, timestamptz, timestamptz, int, text)
  from public, anon;
grant execute on function
  public.my_profile_id(), public.my_role(), public.is_gerant(), public.is_manager(),
  public.me(), public.create_kiosk(uuid, text), public.site_code(uuid),
  public.punch(uuid, text, text), public.punch_break(text),
  public.save_time_entry(uuid, uuid, uuid, timestamptz, timestamptz, int, text)
  to authenticated;

revoke all on function public.kiosk_code(text) from public;
grant execute on function public.kiosk_code(text) to anon, authenticated;

-- Fonctions internes : jamais appelables depuis l'appli.
revoke all on function
  public._site_code(uuid, bigint), public._code_payload(uuid),
  public.profiles_normalize(), public.profiles_keep_a_gerant(),
  public.sites_make_secret(), public.time_entries_audit()
  from public, anon, authenticated;
