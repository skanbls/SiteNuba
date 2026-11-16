-- =====================================================================
-- Nuba Gestion · migration 0004 · iPad partagé : identification par code PIN
--
-- À exécuter une seule fois dans Supabase, après la 0003 :
--   SQL Editor > New query > coller tout ce fichier > Run.
--
-- Principes :
--   * sur un appareil relié à une borne, chacun touche son prénom et tape son
--     code PIN à 4 chiffres ; l'appli s'ouvre alors à son nom ;
--   * une session ouverte par code PIN a les droits d'un équipier, jamais ceux
--     du gérant ou d'un responsable : pour gérer, il faut sa connexion complète ;
--   * elle ne s'ouvre que depuis une borne reliée, dure 30 minutes au plus et se
--     ferme dès qu'on touche « Terminer » ;
--   * avec ce code, on peut aussi pointer directement sur la borne ;
--   * une personne sans adresse e-mail (un extra) peut tout faire sur l'iPad.
--
-- Technique : l'appli envoie le ticket de la session dans l'en-tête
-- « x-nuba-ticket ». `my_profile_id()` le reconnaît, si bien que toutes les
-- règles RLS existantes s'appliquent telles quelles à une session par code PIN.
-- =====================================================================

-- ---------- Une fiche d'équipe peut exister sans adresse e-mail ----------
alter table public.profiles alter column email drop not null;
alter table public.profiles add column has_pin boolean not null default false;

create or replace function public.profiles_normalize() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.email := nullif(lower(btrim(new.email)), '');
  new.first_name := btrim(new.first_name);
  new.last_name := btrim(new.last_name);
  new.job := btrim(new.job);
  return new;
end $$;

-- ---------- Codes PIN (jamais lisibles par l'appli) -----------------------
create table public.profile_pins (
  profile_id   uuid primary key references public.profiles (id) on delete cascade,
  pin_hash     bytea not null,
  failures     int not null default 0,
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);

-- ---------- Sessions ouvertes par code PIN sur une borne -------------------
create table public.kiosk_sessions (
  token_hash bytea primary key,
  kiosk_id   uuid not null references public.kiosks (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index kiosk_sessions_expiry on public.kiosk_sessions (expires_at);

alter table public.profile_pins   enable row level security;
alter table public.kiosk_sessions enable row level security;
revoke all on public.profile_pins, public.kiosk_sessions from anon, authenticated;

create function public._pin_hash(p_profile uuid, p_pin text) returns bytea
language sql immutable set search_path = '' as $$
  select sha256(convert_to(p_profile::text || ':' || p_pin, 'UTF8'))
$$;

-- Ticket envoyé par l'appli dans l'en-tête x-nuba-ticket, ou null.
create function public._ticket() returns text
language sql stable set search_path = '' as $$
  select nullif(nullif(current_setting('request.headers', true), '')::json ->> 'x-nuba-ticket', '')
$$;

-- Personne de la session par code PIN en cours, ou null.
create function public._ticket_profile() returns uuid
language sql stable security definer set search_path = '' as $$
  select s.profile_id
  from public.kiosk_sessions s
  join public.kiosks k on k.id = s.kiosk_id and k.revoked_at is null
  join public.profiles p on p.id = s.profile_id and p.active
  where s.token_hash = sha256(convert_to(public._ticket(), 'UTF8')) and s.expires_at > now()
$$;

-- ---------- Qui suis-je ? ---------------------------------------------------
-- Un compte connecté passe toujours avant un ticket : les deux ne se mélangent pas.
create or replace function public.my_profile_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select case
    when (select auth.uid()) is not null
      then (select id from public.profiles where user_id = (select auth.uid()) and active)
    else public._ticket_profile()
  end
$$;

-- Une session par code PIN n'a que les droits d'un équipier.
create or replace function public.my_role() returns public.app_role
language sql stable security definer set search_path = '' as $$
  select case
    when (select auth.uid()) is not null
      then (select role from public.profiles where user_id = (select auth.uid()) and active)
    when public._ticket_profile() is not null then 'equipier'::public.app_role
  end
$$;

-- Mon profil : par mon compte, ou par ma session à code PIN (alors en équipier).
create or replace function public.me() returns setof public.profiles
language plpgsql security definer set search_path = '' as $$
declare
  uid     uuid := auth.uid();
  p       public.profiles;
  u_email text;
  u_name  text;
begin
  if uid is null then
    select * into p from public.profiles where id = public._ticket_profile();
    if not found then return; end if;
    p.role := 'equipier';
    return next p;
    return;
  end if;

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
      perform pg_advisory_xact_lock(7461001);
      if exists (select 1 from public.profiles) then return; end if;
      insert into public.profiles (user_id, email, first_name, role, job)
        values (uid, u_email, coalesce(u_name, initcap(split_part(u_email, '@', 1))), 'gerant', 'Gérant')
        returning * into p;
    end if;
  end if;

  return next p;
end $$;

-- ---------- Choisir et donner un code PIN ------------------------------------
create function public._store_pin(p_profile uuid, p_pin text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_pin is null or p_pin !~ '^[0-9]{4}$' then
    raise exception 'Le code PIN a 4 chiffres.' using errcode = 'P0001';
  end if;
  if p_pin in ('0000', '1234', '1111') then
    raise exception 'Ce code est trop facile à deviner. Choisis-en un autre.' using errcode = 'P0001';
  end if;
  insert into public.profile_pins (profile_id, pin_hash)
    values (p_profile, public._pin_hash(p_profile, p_pin))
    on conflict (profile_id) do update
      set pin_hash = excluded.pin_hash, failures = 0, locked_until = null, updated_at = now();
  update public.profiles set has_pin = true where id = p_profile;
  -- Un nouveau code ferme les sessions ouvertes avec l'ancien.
  delete from public.kiosk_sessions where profile_id = p_profile;
end $$;

-- Chacun choisit son code PIN (depuis son téléphone, ou depuis l'iPad une fois identifié).
create function public.set_my_pin(p_pin text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me_id uuid := public.my_profile_id();
begin
  if me_id is null then raise exception 'Compte non rattaché à l''équipe.' using errcode = '42501'; end if;
  perform public._store_pin(me_id, p_pin);
end $$;

-- Le gérant donne ou retire le code PIN de quelqu'un (p_pin null pour le retirer).
create function public.set_member_pin(p_profile uuid, p_pin text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_gerant() then
    raise exception 'Réservé au gérant.' using errcode = '42501';
  end if;
  if p_pin is null then
    delete from public.profile_pins where profile_id = p_profile;
    delete from public.kiosk_sessions where profile_id = p_profile;
    update public.profiles set has_pin = false where id = p_profile;
  else
    perform public._store_pin(p_profile, p_pin);
  end if;
end $$;

-- ---------- Sur la borne : l'équipe, puis l'ouverture par code PIN ------------
create function public._kiosk_by_token(p_token text) returns uuid
language sql stable security definer set search_path = '' as $$
  select id from public.kiosks
  where token_hash = sha256(convert_to(coalesce(p_token, ''), 'UTF8')) and revoked_at is null
$$;

-- Prénoms à afficher sur la borne. Appelable sans compte, avec le jeton de la borne.
create function public.kiosk_team(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if public._kiosk_by_token(p_token) is null then return null; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', id, 'first_name', first_name, 'last_name', last_name, 'has_pin', has_pin)
                     order by first_name, last_name)
    from public.profiles where active), '[]'::jsonb);
end $$;

-- Ouvre une session. Renvoie {ok:true, ticket, minutes} ou {ok:false, error}.
create function public.kiosk_login(p_token text, p_profile uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  k_id uuid := public._kiosk_by_token(p_token);
  pin  public.profile_pins;
  t    text;
begin
  if k_id is null then return jsonb_build_object('ok', false, 'error', 'kiosk'); end if;
  if not exists (select 1 from public.profiles where id = p_profile and active) then
    return jsonb_build_object('ok', false, 'error', 'profile');
  end if;
  select * into pin from public.profile_pins where profile_id = p_profile for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_pin'); end if;
  if pin.locked_until is not null and pin.locked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'locked');
  end if;

  if p_pin is null or pin.pin_hash <> public._pin_hash(p_profile, p_pin) then
    -- Cinq erreurs de suite bloquent ce code pendant 10 minutes.
    update public.profile_pins
      set failures = case when failures + 1 >= 5 then 0 else failures + 1 end,
          locked_until = case when failures + 1 >= 5 then now() + interval '10 minutes' else null end
      where profile_id = p_profile;
    return jsonb_build_object('ok', false, 'error', case when pin.failures + 1 >= 5 then 'locked' else 'pin' end);
  end if;

  update public.profile_pins set failures = 0, locked_until = null where profile_id = p_profile;
  delete from public.kiosk_sessions where expires_at < now();
  t := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into public.kiosk_sessions (token_hash, kiosk_id, profile_id, expires_at)
    values (sha256(convert_to(t, 'UTF8')), k_id, p_profile, now() + interval '30 minutes');
  return jsonb_build_object('ok', true, 'ticket', t, 'minutes', 30);
end $$;

-- Ferme la session en cours (bouton « Terminer », ou verrouillage automatique).
create function public.kiosk_logout() returns void
language sql security definer set search_path = '' as $$
  delete from public.kiosk_sessions where token_hash = sha256(convert_to(public._ticket(), 'UTF8'))
$$;

-- Prolonge la session tant que la personne se sert de l'appli.
create function public.kiosk_keepalive() returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update public.kiosk_sessions set expires_at = now() + interval '30 minutes'
    where token_hash = sha256(convert_to(public._ticket(), 'UTF8')) and expires_at > now();
  return found;
end $$;

-- Sert à vérifier que l'en-tête du ticket arrive bien jusqu'à la base.
create function public.has_ticket_header() returns boolean
language sql stable security definer set search_path = '' as $$
  select public._ticket() is not null
$$;

-- ---------- Pointer sur la borne avec son code PIN ----------------------------
alter table public.time_entries drop constraint time_entries_source_check;
alter table public.time_entries add constraint time_entries_source_check check (source in ('qr', 'manuel', 'borne'));

-- Arrivée ou départ, une fois la présence prouvée (code de la borne, ou session ouverte sur la borne).
create function public._do_punch(p_me uuid, p_site uuid, p_action text, p_source text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  e        public.time_entries;
  has_open boolean;
begin
  perform set_config('nuba.via_punch', '1', true);
  select * into e from public.time_entries where profile_id = p_me and clock_out is null;
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
      values (p_me, p_site, clock_timestamp(), p_source) returning * into e;
  else
    if not has_open then return jsonb_build_object('ok', false, 'error', 'not_in'); end if;
    update public.time_breaks set ended_at = clock_timestamp() where entry_id = e.id and ended_at is null;
    update public.time_entries set clock_out = clock_timestamp() where id = e.id returning * into e;
  end if;
  return jsonb_build_object('ok', true, 'action', p_action, 'entry', to_jsonb(e));
end $$;

-- Pointer avec le code affiché par la borne (inchangé pour l'appli).
create or replace function public.punch(p_site uuid, p_code text, p_action text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me_id uuid := public.my_profile_id();
  step  bigint := floor(extract(epoch from clock_timestamp()) / 30)::bigint;
  fails int;
  r     jsonb;
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
  if p_code is null
     or btrim(p_code) not in (public._site_code(p_site, step), public._site_code(p_site, step - 1)) then
    insert into public.punch_failures (profile_id) values (me_id);
    return jsonb_build_object('ok', false, 'error', 'code');
  end if;
  r := public._do_punch(me_id, p_site, p_action, 'qr');
  if (r ->> 'ok')::boolean then delete from public.punch_failures where profile_id = me_id; end if;
  return r;
end $$;

-- Pointer sur la borne : la session ouverte par code PIN prouve la présence sur place.
create function public.punch_kiosk(p_action text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s    public.kiosk_sessions;
  site uuid;
begin
  if auth.uid() is not null then return jsonb_build_object('ok', false, 'error', 'no_profile'); end if;
  select ks.* into s from public.kiosk_sessions ks
    where ks.token_hash = sha256(convert_to(public._ticket(), 'UTF8')) and ks.expires_at > now();
  if not found or public._ticket_profile() is null then
    return jsonb_build_object('ok', false, 'error', 'no_profile');
  end if;
  if p_action is null or p_action not in ('in', 'out') then
    return jsonb_build_object('ok', false, 'error', 'action');
  end if;
  select k.site_id into site from public.kiosks k
    join public.sites st on st.id = k.site_id and st.active
    where k.id = s.kiosk_id;
  if site is null then return jsonb_build_object('ok', false, 'error', 'site'); end if;
  return public._do_punch(s.profile_id, site, p_action, 'borne');
end $$;

-- ---------- Droits : une session par code PIN passe par le rôle « anon » -------
-- Sans ticket valide, my_profile_id() est vide et les règles RLS ne laissent rien passer.
grant select on public.profiles, public.sites, public.time_entries, public.time_breaks,
                public.shifts, public.leave_requests, public.shift_swaps to anon;
grant insert, delete on public.leave_requests to anon;
grant delete on public.shift_swaps to anon;

alter policy "equipe: lecture par les membres"   on public.profiles       to anon, authenticated;
alter policy "lieux: lecture par les membres"    on public.sites          to anon, authenticated;
alter policy "pointages: lecture"                on public.time_entries   to anon, authenticated;
alter policy "pauses: lecture"                   on public.time_breaks    to anon, authenticated;
alter policy "planning: lecture par les membres" on public.shifts         to anon, authenticated;
alter policy "conges: lecture"                   on public.leave_requests to anon, authenticated;
alter policy "conges: demande"                   on public.leave_requests to anon, authenticated;
alter policy "conges: annulation"                on public.leave_requests to anon, authenticated;
alter policy "echanges: lecture"                 on public.shift_swaps    to anon, authenticated;
alter policy "echanges: annulation"              on public.shift_swaps    to anon, authenticated;

-- Fonctions utilisables par une session à code PIN comme par un compte connecté.
grant execute on function
  public.my_profile_id(), public.my_role(), public.is_gerant(), public.is_manager(),
  public.me(), public.punch_break(text), public.request_swap(uuid, uuid, text)
  to anon;

revoke all on function
  public.set_my_pin(text), public.kiosk_team(text), public.kiosk_login(text, uuid, text),
  public.kiosk_logout(), public.kiosk_keepalive(), public.has_ticket_header(), public.punch_kiosk(text)
  from public;
grant execute on function
  public.set_my_pin(text), public.kiosk_team(text), public.kiosk_login(text, uuid, text),
  public.kiosk_logout(), public.kiosk_keepalive(), public.has_ticket_header(), public.punch_kiosk(text)
  to anon, authenticated;

revoke all on function public.set_member_pin(uuid, text) from public, anon;
grant execute on function public.set_member_pin(uuid, text) to authenticated;

-- Fonctions internes : jamais appelables depuis l'appli.
revoke all on function
  public._pin_hash(uuid, text), public._ticket(), public._ticket_profile(), public._store_pin(uuid, text),
  public._kiosk_by_token(text), public._do_punch(uuid, uuid, text, text)
  from public, anon, authenticated;
