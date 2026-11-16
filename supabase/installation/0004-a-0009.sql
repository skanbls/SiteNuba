-- =====================================================================
-- Nuba Gestion · mises à jour 0004 à 0009 en une seule fois
--
-- Pour une base qui a déjà reçu les scripts 0001, 0002 et 0003.
-- SQL Editor > New query > coller tout ce fichier > Run.
--
-- Tout passe ou rien ne passe : en cas d'erreur, la base reste comme avant.
-- Ce fichier est la copie exacte des six fichiers de supabase/migrations/.
-- Ne l'exécute qu'une fois, et pas en plus des fichiers séparés.
-- =====================================================================
begin;


-- >>>>>>>>>> 0004_ipad_pin.sql
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

-- >>>>>>>>>> 0005_checklists_hygiene.sql
-- =====================================================================
-- Nuba Gestion · migration 0005 · checklists et hygiène
--
-- À exécuter une seule fois dans Supabase, après la 0004 :
--   SQL Editor > New query > coller tout ce fichier > Run.
--
-- Principes :
--   * une checklist se coche pour une période : le jour de service, la semaine
--     ou le mois ; chaque case garde qui l'a cochée et quand ;
--   * le jour de service va de 5 h du matin à 5 h le lendemain (heure de Paris) :
--     la fermeture de 2 h du matin appartient encore à la soirée ;
--   * hygiène : relevés de température avec action corrective obligatoire hors
--     limite, plan de nettoyage (des checklists), dates limites des préparations
--     et des produits entamés, suivi de l'huile de friture ;
--   * toute l'équipe coche et relève, sur son téléphone comme sur l'iPad ; le
--     gérant compose les listes et les enceintes. Des modèles sont proposés.
-- =====================================================================

-- ---------- Jour de service et périodes -----------------------------------
create function public.service_day() returns date
language sql stable set search_path = '' as $$
  select ((now() at time zone 'Europe/Paris') - interval '5 hours')::date
$$;

create function public._period(p_frequency text, p_day date) returns date
language sql immutable set search_path = '' as $$
  select case p_frequency
    when 'weekly' then date_trunc('week', p_day)::date
    when 'monthly' then date_trunc('month', p_day)::date
    else p_day
  end
$$;

-- ---------- Checklists -----------------------------------------------------
create table public.checklists (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) > 0),
  kind       text not null default 'service' check (kind in ('service', 'nettoyage')),
  frequency  text not null default 'daily' check (frequency in ('daily', 'weekly', 'monthly')),
  position   int not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.checklist_items (
  id           uuid primary key default gen_random_uuid(),
  checklist_id uuid not null references public.checklists (id) on delete cascade,
  label        text not null check (length(btrim(label)) > 0),
  position     int not null default 0,
  active       boolean not null default true
);
create index checklist_items_by_list on public.checklist_items (checklist_id, position);

create table public.checklist_ticks (
  item_id uuid not null references public.checklist_items (id) on delete cascade,
  period  date not null,
  done_by uuid references public.profiles (id) on delete set null,
  done_at timestamptz not null default now(),
  primary key (item_id, period)
);
create index checklist_ticks_by_period on public.checklist_ticks (period);

-- Les checklists actives avec leurs cases, cochées ou non pour la période en cours.
create function public.checklists_today() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  d date := public.service_day();
begin
  if public.my_profile_id() is null then return null; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', c.id, 'name', c.name, 'kind', c.kind, 'frequency', c.frequency,
      'items', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', i.id, 'label', i.label, 'done', t.item_id is not null,
          'done_by', t.done_by, 'done_by_name', p.first_name, 'done_at', t.done_at)
          order by i.position, i.label)
        from public.checklist_items i
        left join public.checklist_ticks t on t.item_id = i.id and t.period = public._period(c.frequency, d)
        left join public.profiles p on p.id = t.done_by
        where i.checklist_id = c.id and i.active), '[]'::jsonb))
      order by c.position, c.name)
    from public.checklists c where c.active), '[]'::jsonb);
end $$;

-- Cocher ou décocher une case pour la période en cours.
-- On ne décoche que sa propre case ; le gérant peut tout décocher.
create function public.tick_item(p_item uuid, p_done boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me_id uuid := public.my_profile_id();
  per   date;
  t     public.checklist_ticks;
begin
  if me_id is null then return jsonb_build_object('ok', false, 'error', 'no_profile'); end if;
  select public._period(c.frequency, public.service_day()) into per
    from public.checklist_items i join public.checklists c on c.id = i.checklist_id
    where i.id = p_item and i.active and c.active;
  if per is null then return jsonb_build_object('ok', false, 'error', 'item'); end if;

  select * into t from public.checklist_ticks where item_id = p_item and period = per;
  if p_done then
    if not found then
      insert into public.checklist_ticks (item_id, period, done_by) values (p_item, per, me_id);
    end if;
  elsif found then
    if t.done_by is distinct from me_id and not public.is_gerant() then
      return jsonb_build_object('ok', false, 'error', 'not_yours');
    end if;
    delete from public.checklist_ticks where item_id = p_item and period = per;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Créer ou modifier une checklist et ses cases, d'un seul coup. Réservé au gérant.
-- p_items : [{id?, label}] dans l'ordre voulu. Une case absente est retirée de la liste,
-- mais son historique est conservé.
create function public.save_checklist(p_id uuid, p_name text, p_kind text, p_frequency text, p_items jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := p_id;
  it   jsonb;
  n    int := 0;
  keep uuid[] := '{}';
  i_id uuid;
begin
  if not public.is_gerant() then
    raise exception 'Réservé au gérant.' using errcode = '42501';
  end if;
  if v_id is null then
    insert into public.checklists (name, kind, frequency, position)
      values (btrim(p_name), p_kind, p_frequency, coalesce((select max(position) + 1 from public.checklists), 0))
      returning id into v_id;
  else
    update public.checklists set name = btrim(p_name), kind = p_kind, frequency = p_frequency where id = v_id;
    if not found then raise exception 'Checklist introuvable.' using errcode = 'P0001'; end if;
  end if;

  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    continue when length(btrim(coalesce(it ->> 'label', ''))) = 0;
    n := n + 1;
    i_id := nullif(it ->> 'id', '')::uuid;
    if i_id is not null and exists (select 1 from public.checklist_items where id = i_id and checklist_id = v_id) then
      update public.checklist_items set label = btrim(it ->> 'label'), position = n, active = true where id = i_id;
    else
      insert into public.checklist_items (checklist_id, label, position)
        values (v_id, btrim(it ->> 'label'), n) returning id into i_id;
    end if;
    keep := keep || i_id;
  end loop;
  update public.checklist_items set active = false where checklist_id = v_id and not (id = any (keep));
  return v_id;
end $$;

-- ---------- Températures ----------------------------------------------------
create table public.cold_units (
  id               uuid primary key default gen_random_uuid(),
  name             text not null check (length(btrim(name)) > 0),
  min_temp         numeric(4, 1) not null,
  max_temp         numeric(4, 1) not null,
  readings_per_day smallint not null default 2 check (readings_per_day in (1, 2)),
  position         int not null default 0,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  constraint cold_units_range check (max_temp > min_temp)
);

create table public.temp_readings (
  id           uuid primary key default gen_random_uuid(),
  unit_id      uuid not null references public.cold_units (id) on delete cascade,
  value        numeric(4, 1) not null check (value between -60 and 60),
  day          date not null,
  slot         text not null check (slot in ('matin', 'soir')),
  out_of_range boolean not null,
  corrective   text not null default '',
  taken_by     uuid references public.profiles (id) on delete set null,
  taken_at     timestamptz not null default now()
);
create index temp_readings_by_day on public.temp_readings (day, unit_id);

-- Matin jusqu'à 15 h (heure de Paris), soir ensuite, jusqu'à la fermeture.
create function public._slot() returns text
language sql stable set search_path = '' as $$
  select case when extract(hour from now() at time zone 'Europe/Paris') between 5 and 14 then 'matin' else 'soir' end
$$;

-- Enregistrer un relevé. Hors limite, il attend son action corrective.
create function public.record_temp(p_unit uuid, p_value numeric) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me_id uuid := public.my_profile_id();
  u     public.cold_units;
  v_id  uuid;
  bad   boolean;
begin
  if me_id is null then return jsonb_build_object('ok', false, 'error', 'no_profile'); end if;
  select * into u from public.cold_units where id = p_unit and active;
  if not found then return jsonb_build_object('ok', false, 'error', 'unit'); end if;
  if p_value is null or p_value < -60 or p_value > 60 then return jsonb_build_object('ok', false, 'error', 'value'); end if;
  bad := p_value < u.min_temp or p_value > u.max_temp;
  insert into public.temp_readings (unit_id, value, day, slot, out_of_range, taken_by)
    values (p_unit, round(p_value, 1), public.service_day(), public._slot(), bad, me_id)
    returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'out_of_range', bad);
end $$;

-- Noter l'action corrective d'un relevé hors limite.
create function public.note_corrective(p_reading uuid, p_text text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if public.my_profile_id() is null then raise exception 'Compte non rattaché à l''équipe.' using errcode = '42501'; end if;
  if length(btrim(coalesce(p_text, ''))) = 0 then raise exception 'Décris l''action corrective.' using errcode = 'P0001'; end if;
  update public.temp_readings set corrective = btrim(p_text) where id = p_reading and out_of_range;
  if not found then raise exception 'Relevé introuvable.' using errcode = 'P0001'; end if;
end $$;

-- ---------- Traçabilité : préparations et produits entamés -------------------
create table public.trace_items (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (length(btrim(name)) > 0),
  kind          text not null default 'preparation' check (kind in ('preparation', 'ouverture')),
  made_on       date not null,
  use_by        date not null,
  note          text not null default '',
  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  closed_at     timestamptz,
  closed_by     uuid references public.profiles (id) on delete set null,
  closed_reason text check (closed_reason in ('utilise', 'jete')),
  constraint trace_items_order check (use_by >= made_on)
);
create index trace_items_open on public.trace_items (use_by) where closed_at is null;

-- Sortir une préparation : terminée ('utilise') ou jetée ('jete').
create function public.close_trace(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me_id uuid := public.my_profile_id();
begin
  if me_id is null then raise exception 'Compte non rattaché à l''équipe.' using errcode = '42501'; end if;
  if p_reason is null or p_reason not in ('utilise', 'jete') then raise exception 'Motif inconnu.' using errcode = 'P0001'; end if;
  update public.trace_items set closed_at = now(), closed_by = me_id, closed_reason = p_reason
    where id = p_id and closed_at is null;
  if not found then raise exception 'Étiquette introuvable ou déjà sortie.' using errcode = 'P0001'; end if;
end $$;

-- ---------- Huile de friture -------------------------------------------------
create table public.oil_logs (
  id        uuid primary key default gen_random_uuid(),
  action    text not null check (action in ('test', 'changement')),
  polar_pct numeric(4, 1) check (polar_pct between 0 and 100),
  note      text not null default '',
  done_by   uuid references public.profiles (id) on delete set null,
  done_at   timestamptz not null default now(),
  constraint oil_logs_test_value check (action <> 'test' or polar_pct is not null)
);
create index oil_logs_recent on public.oil_logs (done_at desc);

-- ---------- Ce qu'il y a à faire aujourd'hui (accueil) -------------------------
create function public.today_tasks() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  d  date := public.service_day();
  sl text := public._slot();
begin
  if public.my_profile_id() is null then return null; end if;
  return jsonb_build_object(
    'day', d,
    'slot', sl,
    'checks_total', (select count(*) from public.checklist_items i join public.checklists c on c.id = i.checklist_id
                     where i.active and c.active and c.frequency = 'daily'),
    'checks_done', (select count(*) from public.checklist_ticks t
                    join public.checklist_items i on i.id = t.item_id and i.active
                    join public.checklists c on c.id = i.checklist_id and c.active and c.frequency = 'daily'
                    where t.period = d),
    -- Enceintes sans relevé pour ce moment de la journée (ou pour la journée, si un seul relevé suffit).
    'temps_due', (select count(*) from public.cold_units u
                  where u.active and not exists (
                    select 1 from public.temp_readings r
                    where r.unit_id = u.id and r.day = d and (u.readings_per_day = 1 or r.slot = sl))),
    'temps_alerts', (select count(*) from public.temp_readings r join public.cold_units u on u.id = r.unit_id and u.active
                     where r.out_of_range and r.corrective = '' and r.day >= d - 1),
    'dlc_today', (select count(*) from public.trace_items where closed_at is null and use_by = d),
    'dlc_late', (select count(*) from public.trace_items where closed_at is null and use_by < d));
end $$;

-- ---------- Sécurité : droits et RLS --------------------------------------------
alter table public.checklists      enable row level security;
alter table public.checklist_items enable row level security;
alter table public.checklist_ticks enable row level security;
alter table public.cold_units      enable row level security;
alter table public.temp_readings   enable row level security;
alter table public.trace_items     enable row level security;
alter table public.oil_logs        enable row level security;

revoke all on public.checklists, public.checklist_items, public.checklist_ticks, public.cold_units,
              public.temp_readings, public.trace_items, public.oil_logs from anon, authenticated;
-- Lecture par toute l'équipe, y compris dans une session à code PIN (rôle anon avec ticket).
grant select on public.checklists, public.checklist_items, public.checklist_ticks, public.cold_units,
                public.temp_readings, public.trace_items, public.oil_logs to anon, authenticated;
grant insert on public.trace_items, public.oil_logs to anon, authenticated;
-- Gestion par le gérant, avec son compte.
grant insert, update, delete on public.cold_units to authenticated;
grant delete on public.checklists, public.temp_readings, public.trace_items, public.oil_logs to authenticated;
grant update on public.checklists to authenticated;

create policy "checklists: lecture" on public.checklists
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "checklists: modification par le gerant" on public.checklists
  for update to authenticated using ((select public.is_gerant())) with check ((select public.is_gerant()));
create policy "checklists: suppression par le gerant" on public.checklists
  for delete to authenticated using ((select public.is_gerant()));
create policy "cases: lecture" on public.checklist_items
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "coches: lecture" on public.checklist_ticks
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);

create policy "enceintes: lecture" on public.cold_units
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "enceintes: ajout par le gerant" on public.cold_units
  for insert to authenticated with check ((select public.is_gerant()));
create policy "enceintes: modification par le gerant" on public.cold_units
  for update to authenticated using ((select public.is_gerant())) with check ((select public.is_gerant()));
create policy "enceintes: suppression par le gerant" on public.cold_units
  for delete to authenticated using ((select public.is_gerant()));

create policy "releves: lecture" on public.temp_readings
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "releves: suppression par le gerant" on public.temp_readings
  for delete to authenticated using ((select public.is_gerant()));

create policy "tracabilite: lecture" on public.trace_items
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "tracabilite: ajout" on public.trace_items
  for insert to anon, authenticated
  with check (created_by = (select public.my_profile_id()) and closed_at is null and closed_by is null and closed_reason is null);
create policy "tracabilite: suppression par le gerant" on public.trace_items
  for delete to authenticated using ((select public.is_gerant()));

create policy "huile: lecture" on public.oil_logs
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "huile: ajout" on public.oil_logs
  for insert to anon, authenticated with check (done_by = (select public.my_profile_id()));
create policy "huile: suppression par le gerant" on public.oil_logs
  for delete to authenticated using ((select public.is_gerant()));

revoke all on function
  public.service_day(), public.checklists_today(), public.tick_item(uuid, boolean),
  public.record_temp(uuid, numeric), public.note_corrective(uuid, text),
  public.close_trace(uuid, text), public.today_tasks()
  from public;
grant execute on function
  public.service_day(), public.checklists_today(), public.tick_item(uuid, boolean),
  public.record_temp(uuid, numeric), public.note_corrective(uuid, text),
  public.close_trace(uuid, text), public.today_tasks()
  to anon, authenticated;
revoke all on function public.save_checklist(uuid, text, text, text, jsonb) from public, anon;
grant execute on function public.save_checklist(uuid, text, text, text, jsonb) to authenticated;
revoke all on function public._period(text, date), public._slot() from public, anon, authenticated;

-- ---------- Modèles de départ, à ajuster dans l'appli -----------------------------
do $$
declare
  l record;
  c_id uuid;
  n int := 0;
  k int;
  lbl text;
begin
  for l in select * from (values
    ('Ouverture bar', 'service', 'daily', array[
      'Machine à glaçons en route, bac plein',
      'Mise en place : agrumes, menthe, sirops maison',
      'Fûts contrôlés, tireuse purgée',
      'Fond de caisse compté et noté',
      'Terrasse installée, cendriers propres',
      'Lumières et musique en place']),
    ('Ouverture cuisine', 'service', 'daily', array[
      'Contrôle des dates et des étiquettes',
      'Plans de travail désinfectés',
      'Mise en place selon la fiche du jour',
      'Niveau et état de l''huile de friture',
      'Lave-vaisselle : produits et température de rinçage',
      'Livraisons contrôlées et rangées']),
    ('Fermeture', 'service', 'daily', array[
      'Caisse clôturée, enveloppe au coffre',
      'Frigos fermés, relevés du soir faits',
      'Bar nettoyé, becs verseurs rincés',
      'Cuisine : plans, sols, friteuse couverte',
      'Poubelles sorties, verre trié',
      'Gaz coupé, hotte éteinte',
      'Terrasse rentrée',
      'Alarme mise, portes verrouillées']),
    ('Tâches de la semaine', 'service', 'weekly', array[
      'Inventaire du bar et de la cave',
      'Machine à café détartrée',
      'Trousse de secours vérifiée']),
    ('Nettoyage du jour', 'nettoyage', 'daily', array[
      'Plans de travail et planches',
      'Trancheuse démontée et désinfectée',
      'Sols de la cuisine et du bar',
      'Poignées de frigos et de portes',
      'Sanitaires']),
    ('Nettoyage de la semaine', 'nettoyage', 'weekly', array[
      'Filtres de hotte',
      'Siphons de sol',
      'Intérieur des frigos',
      'Étagères de la réserve']),
    ('Nettoyage du mois', 'nettoyage', 'monthly', array[
      'Machine à glaçons',
      'Chambre froide : sol, murs, clayettes',
      'Derrière et sous les équipements'])
  ) as t(name, kind, frequency, items) loop
    n := n + 1;
    insert into public.checklists (name, kind, frequency, position) values (l.name, l.kind, l.frequency, n) returning id into c_id;
    k := 0;
    foreach lbl in array l.items loop
      k := k + 1;
      insert into public.checklist_items (checklist_id, label, position) values (c_id, lbl, k);
    end loop;
  end loop;
end $$;

insert into public.cold_units (name, min_temp, max_temp, readings_per_day, position) values
  ('Chambre froide',   0,   4, 2, 1),
  ('Frigo bar',        0,   4, 2, 2),
  ('Timbre cuisine',   0,   4, 2, 3),
  ('Vitrine desserts', 0,   4, 2, 4),
  ('Congélateur',    -30, -18, 1, 5);

-- >>>>>>>>>> 0006_stocks_commandes.sql
-- =====================================================================
-- Nuba Gestion · migration 0006 · stocks, fournisseurs et commandes
--
-- À exécuter une seule fois dans Supabase, après la 0005 :
--   SQL Editor > New query > coller tout ce fichier > Run.
--
-- Principes :
--   * chaque produit a une quantité, un seuil d'alerte et un fournisseur ;
--   * la quantité ne change que par un mouvement signé : ajustement, inventaire
--     ou réception d'une commande ; l'historique reste consultable ;
--   * toute l'équipe ajuste le stock, prépare, envoie et réceptionne les
--     commandes, sur son téléphone comme sur l'iPad ; chaque geste est signé ;
--   * le gérant tient le catalogue : produits, seuils, prix, fournisseurs ;
--   * réceptionner une commande ajoute les quantités reçues au stock et garde
--     le contrôle à réception (conformité, température).
-- =====================================================================

-- Personne en cours (compte ou session à code PIN), ou erreur si aucune.
create function public._member() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  me_id uuid := public.my_profile_id();
begin
  if me_id is null then raise exception 'Compte non rattaché à l''équipe.' using errcode = '42501'; end if;
  return me_id;
end $$;

-- ---------- Fournisseurs ----------------------------------------------------
create table public.suppliers (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (length(btrim(name)) > 0),
  contact       text not null default '',
  phone         text not null default '',
  email         text not null default '',
  delivery_days text not null default '',
  order_cutoff  text not null default '',
  minimum       text not null default '',
  note          text not null default '',
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- ---------- Produits et stock -----------------------------------------------
create table public.products (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) > 0),
  category    text not null default 'Bar',
  unit        text not null default '',
  quantity    numeric(10, 2) not null default 0 check (quantity >= 0),
  threshold   numeric(10, 2) not null default 0 check (threshold >= 0),
  target      numeric(10, 2) check (target is null or target >= 0),
  unit_price  numeric(10, 2) not null default 0 check (unit_price >= 0),
  supplier_id uuid references public.suppliers (id) on delete set null,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create index products_by_supplier on public.products (supplier_id);

create table public.stock_moves (
  id             bigint generated always as identity primary key,
  product_id     uuid not null references public.products (id) on delete cascade,
  delta          numeric(10, 2) not null,
  quantity_after numeric(10, 2) not null,
  reason         text not null check (reason in ('ajustement', 'inventaire', 'reception', 'perte')),
  note           text not null default '',
  done_by        uuid references public.profiles (id) on delete set null,
  done_at        timestamptz not null default now()
);
create index stock_moves_by_product on public.stock_moves (product_id, done_at desc);

-- Change la quantité d'un produit et écrit le mouvement. Le stock ne descend pas sous zéro.
create function public._move_stock(p_product uuid, p_new numeric, p_reason text, p_note text, p_me uuid) returns numeric
language plpgsql security definer set search_path = '' as $$
declare
  old_q numeric;
  new_q numeric := greatest(0, round(p_new, 2));
begin
  select quantity into old_q from public.products where id = p_product for update;
  if not found then raise exception 'Produit introuvable.' using errcode = 'P0001'; end if;
  if new_q <> old_q then
    update public.products set quantity = new_q where id = p_product;
    insert into public.stock_moves (product_id, delta, quantity_after, reason, note, done_by)
      values (p_product, new_q - old_q, new_q, p_reason, coalesce(btrim(p_note), ''), p_me);
  end if;
  return new_q;
end $$;

-- Ajouter ou retirer une quantité (boutons + et −). Renvoie la nouvelle quantité.
create function public.adjust_stock(p_product uuid, p_delta numeric) returns numeric
language plpgsql security definer set search_path = '' as $$
declare
  me_id uuid := public._member();
  q     numeric;
begin
  if p_delta is null or p_delta = 0 then raise exception 'Quantité manquante.' using errcode = 'P0001'; end if;
  select quantity into q from public.products where id = p_product and active;
  if not found then raise exception 'Produit introuvable.' using errcode = 'P0001'; end if;
  return public._move_stock(p_product, q + p_delta, 'ajustement', '', me_id);
end $$;

-- Inventaire : enregistre les quantités comptées. p_counts : [{id, quantity}]. Renvoie le nombre de produits modifiés.
create function public.count_stock(p_counts jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare
  me_id uuid := public._member();
  c     jsonb;
  old_q numeric;
  q     numeric;
  n     int := 0;
begin
  for c in select * from jsonb_array_elements(coalesce(p_counts, '[]'::jsonb)) loop
    q := (c ->> 'quantity')::numeric;
    continue when q is null or q < 0;
    select quantity into old_q from public.products where id = (c ->> 'id')::uuid and active;
    continue when not found;
    if round(q, 2) <> old_q then
      perform public._move_stock((c ->> 'id')::uuid, q, 'inventaire', '', me_id);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- ---------- Commandes -------------------------------------------------------
create table public.orders (
  id             uuid primary key default gen_random_uuid(),
  supplier_id    uuid not null references public.suppliers (id) on delete restrict,
  status         text not null default 'draft' check (status in ('draft', 'sent', 'received', 'cancelled')),
  note           text not null default '',
  created_by     uuid references public.profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  sent_by        uuid references public.profiles (id) on delete set null,
  sent_at        timestamptz,
  received_by    uuid references public.profiles (id) on delete set null,
  received_at    timestamptz,
  reception_ok   boolean,
  reception_temp numeric(4, 1),
  reception_note text not null default ''
);
create index orders_by_status on public.orders (status, created_at desc);

create table public.order_lines (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null references public.orders (id) on delete cascade,
  product_id        uuid not null references public.products (id) on delete restrict,
  quantity          numeric(10, 2) not null check (quantity > 0),
  unit_price        numeric(10, 2) not null default 0,
  received_quantity numeric(10, 2) check (received_quantity is null or received_quantity >= 0),
  unique (order_id, product_id)
);

-- Créer ou modifier un brouillon de commande. p_lines : [{product_id, quantity}].
create function public.save_order(p_id uuid, p_supplier uuid, p_note text, p_lines jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me_id uuid := public._member();
  v_id  uuid := p_id;
  l     jsonb;
  p     public.products;
  q     numeric;
begin
  if v_id is null then
    if not exists (select 1 from public.suppliers where id = p_supplier and active) then
      raise exception 'Fournisseur introuvable.' using errcode = 'P0001';
    end if;
    insert into public.orders (supplier_id, note, created_by)
      values (p_supplier, coalesce(btrim(p_note), ''), me_id) returning id into v_id;
  else
    update public.orders set note = coalesce(btrim(p_note), '') where id = v_id and status = 'draft';
    if not found then raise exception 'Cette commande n''est plus modifiable.' using errcode = 'P0001'; end if;
    delete from public.order_lines where order_id = v_id;
  end if;

  for l in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    q := (l ->> 'quantity')::numeric;
    continue when q is null or q <= 0;
    select * into p from public.products where id = (l ->> 'product_id')::uuid and active;
    continue when not found;
    insert into public.order_lines (order_id, product_id, quantity, unit_price)
      values (v_id, p.id, round(q, 2), p.unit_price)
      on conflict (order_id, product_id) do update set quantity = excluded.quantity;
  end loop;
  return v_id;
end $$;

-- La commande est partie chez le fournisseur.
create function public.send_order(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me_id uuid := public._member();
begin
  if not exists (select 1 from public.order_lines where order_id = p_id) then
    raise exception 'Cette commande est vide.' using errcode = 'P0001';
  end if;
  update public.orders set status = 'sent', sent_by = me_id, sent_at = now() where id = p_id and status = 'draft';
  if not found then raise exception 'Cette commande a déjà été envoyée.' using errcode = 'P0001'; end if;
end $$;

-- Supprimer un brouillon.
create function public.delete_order(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public._member();
  delete from public.orders where id = p_id and status = 'draft';
  if not found then raise exception 'Seul un brouillon peut être supprimé.' using errcode = 'P0001'; end if;
end $$;

-- Annuler une commande envoyée qui ne sera pas livrée. Réservé au gérant.
create function public.cancel_order(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_gerant() then
    raise exception 'Réservé au gérant.' using errcode = '42501';
  end if;
  update public.orders set status = 'cancelled' where id = p_id and status = 'sent';
  if not found then raise exception 'Seule une commande envoyée peut être annulée.' using errcode = 'P0001'; end if;
end $$;

-- Réceptionner une livraison : quantités reçues, contrôle à réception, mise à jour du stock.
-- p_lines : [{line_id, received}] ; une ligne absente est considérée comme reçue en entier.
create function public.receive_order(p_id uuid, p_lines jsonb, p_ok boolean, p_temp numeric, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me_id uuid := public._member();
  o     public.orders;
  l     public.order_lines;
  got   numeric;
  s_name text;
begin
  select * into o from public.orders where id = p_id and status = 'sent' for update;
  if not found then raise exception 'Cette commande n''attend pas de livraison.' using errcode = 'P0001'; end if;
  if p_ok is not true and length(btrim(coalesce(p_note, ''))) = 0 then
    raise exception 'Décris le problème constaté à la réception.' using errcode = 'P0001';
  end if;
  select name into s_name from public.suppliers where id = o.supplier_id;

  for l in select * from public.order_lines where order_id = p_id loop
    select (e ->> 'received')::numeric into got
      from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) e where (e ->> 'line_id')::uuid = l.id;
    got := greatest(0, round(coalesce(got, l.quantity), 2));
    update public.order_lines set received_quantity = got where id = l.id;
    if got > 0 then
      perform public._move_stock(l.product_id,
        (select quantity from public.products where id = l.product_id) + got, 'reception', 'Livraison ' || s_name, me_id);
    end if;
  end loop;

  update public.orders
    set status = 'received', received_by = me_id, received_at = now(),
        reception_ok = coalesce(p_ok, false), reception_temp = p_temp, reception_note = coalesce(btrim(p_note), '')
    where id = p_id;
end $$;

-- ---------- Accueil : ajoute les stocks bas et les livraisons attendues ---------
create or replace function public.today_tasks() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  d  date := public.service_day();
  sl text := public._slot();
begin
  if public.my_profile_id() is null then return null; end if;
  return jsonb_build_object(
    'day', d,
    'slot', sl,
    'checks_total', (select count(*) from public.checklist_items i join public.checklists c on c.id = i.checklist_id
                     where i.active and c.active and c.frequency = 'daily'),
    'checks_done', (select count(*) from public.checklist_ticks t
                    join public.checklist_items i on i.id = t.item_id and i.active
                    join public.checklists c on c.id = i.checklist_id and c.active and c.frequency = 'daily'
                    where t.period = d),
    'temps_due', (select count(*) from public.cold_units u
                  where u.active and not exists (
                    select 1 from public.temp_readings r
                    where r.unit_id = u.id and r.day = d and (u.readings_per_day = 1 or r.slot = sl))),
    'temps_alerts', (select count(*) from public.temp_readings r join public.cold_units u on u.id = r.unit_id and u.active
                     where r.out_of_range and r.corrective = '' and r.day >= d - 1),
    'dlc_today', (select count(*) from public.trace_items where closed_at is null and use_by = d),
    'dlc_late', (select count(*) from public.trace_items where closed_at is null and use_by < d),
    'low_stock', (select count(*) from public.products where active and threshold > 0 and quantity < threshold),
    'deliveries', (select count(*) from public.orders where status = 'sent'));
end $$;

-- ---------- Sécurité : droits et RLS --------------------------------------------
alter table public.suppliers   enable row level security;
alter table public.products    enable row level security;
alter table public.stock_moves enable row level security;
alter table public.orders      enable row level security;
alter table public.order_lines enable row level security;

revoke all on public.suppliers, public.products, public.stock_moves, public.orders, public.order_lines from anon, authenticated;
-- Lecture par toute l'équipe, y compris dans une session à code PIN.
grant select on public.suppliers, public.products, public.stock_moves, public.orders, public.order_lines to anon, authenticated;
-- Catalogue tenu par le gérant. La quantité ne se modifie pas ici : seulement par un mouvement de stock.
grant insert, update on public.suppliers to authenticated;
grant insert (name, category, unit, threshold, target, unit_price, supplier_id, active) on public.products to authenticated;
grant update (name, category, unit, threshold, target, unit_price, supplier_id, active) on public.products to authenticated;

create policy "fournisseurs: lecture" on public.suppliers
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "fournisseurs: ajout par le gerant" on public.suppliers
  for insert to authenticated with check ((select public.is_gerant()));
create policy "fournisseurs: modification par le gerant" on public.suppliers
  for update to authenticated using ((select public.is_gerant())) with check ((select public.is_gerant()));

create policy "produits: lecture" on public.products
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "produits: ajout par le gerant" on public.products
  for insert to authenticated with check ((select public.is_gerant()));
create policy "produits: modification par le gerant" on public.products
  for update to authenticated using ((select public.is_gerant())) with check ((select public.is_gerant()));

create policy "mouvements: lecture" on public.stock_moves
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "commandes: lecture" on public.orders
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "lignes: lecture" on public.order_lines
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);

revoke all on function
  public.adjust_stock(uuid, numeric), public.count_stock(jsonb),
  public.save_order(uuid, uuid, text, jsonb), public.send_order(uuid), public.delete_order(uuid),
  public.receive_order(uuid, jsonb, boolean, numeric, text)
  from public;
grant execute on function
  public.adjust_stock(uuid, numeric), public.count_stock(jsonb),
  public.save_order(uuid, uuid, text, jsonb), public.send_order(uuid), public.delete_order(uuid),
  public.receive_order(uuid, jsonb, boolean, numeric, text)
  to anon, authenticated;
revoke all on function public.cancel_order(uuid) from public, anon;
grant execute on function public.cancel_order(uuid) to authenticated;
revoke all on function public._member(), public._move_stock(uuid, numeric, text, text, uuid) from public, anon, authenticated;

-- >>>>>>>>>> 0007_reservations.sql
-- =====================================================================
-- Nuba Gestion · migration 0007 · réservations de tables
--
-- À exécuter une seule fois dans Supabase, après la 0006 :
--   SQL Editor > New query > coller tout ce fichier > Run.
--
-- Principes :
--   * les clients réservent en ligne sur une page publique (lien ou intégration
--     dans le site web) ; l'équipe saisit les réservations prises par téléphone,
--     sur place ou sur Instagram ; tout arrive dans la même liste ;
--   * en ligne : jusqu'à 9 personnes, sur les créneaux d'ouverture, au moins
--     une heure à l'avance ; à partir de 10, le client appelle ;
--   * la réservation est confirmée à l'écran, avec un lien pour l'annuler ;
--   * horaires, dernier créneau, capacité et règles se modifient dans l'appli ;
--   * les coordonnées des clients ne sont lisibles que par l'équipe.
-- =====================================================================

-- ---------- Règles et horaires -----------------------------------------------
create table public.booking_settings (
  id                boolean primary key default true check (id),
  online_enabled    boolean not null default true,
  slot_minutes      smallint not null default 30 check (slot_minutes in (15, 30, 60)),
  max_party_online  smallint not null default 9 check (max_party_online between 1 and 50),
  min_lead_minutes  int not null default 60 check (min_lead_minutes between 0 and 2880),
  max_days_ahead    smallint not null default 60 check (max_days_ahead between 1 and 365),
  capacity_per_slot int check (capacity_per_slot is null or capacity_per_slot > 0),
  phone             text not null default '',
  notice            text not null default ''
);
insert into public.booking_settings default values;

-- Jour de la semaine : 1 = lundi … 7 = dimanche.
create table public.opening_hours (
  weekday    smallint primary key check (weekday between 1 and 7),
  open       boolean not null default true,
  first_slot time not null default '12:00',
  last_slot  time not null default '22:00',
  break_from time,
  break_to   time,
  constraint opening_hours_order check (last_slot >= first_slot),
  constraint opening_hours_break check ((break_from is null and break_to is null) or (break_to > break_from))
);
-- Ouverture : mardi à jeudi 12 h – 0 h, vendredi 12 h – 2 h, samedi 12 h – 3 h, dimanche 12 h – 16 h, lundi fermé.
-- Dernière réservation : deux heures avant la fermeture, et pas après 22 h 30.
insert into public.opening_hours (weekday, open, first_slot, last_slot) values
  (1, false, '12:00', '22:00'),
  (2, true,  '12:00', '22:00'),
  (3, true,  '12:00', '22:00'),
  (4, true,  '12:00', '22:00'),
  (5, true,  '12:00', '22:30'),
  (6, true,  '12:00', '22:30'),
  (7, true,  '12:00', '14:00');

-- ---------- Réservations ---------------------------------------------------
create table public.reservations (
  id          uuid primary key default gen_random_uuid(),
  day         date not null,
  slot        time not null,
  party       int not null check (party between 1 and 500),
  name        text not null check (length(btrim(name)) > 0),
  phone       text not null default '',
  email       text not null default '',
  note        text not null default '',
  table_label text not null default '',
  source      text not null default 'telephone' check (source in ('en_ligne', 'telephone', 'sur_place', 'instagram', 'autre')),
  status      text not null default 'confirmed' check (status in ('confirmed', 'seated', 'no_show', 'cancelled')),
  code_hash   bytea,
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index reservations_by_day on public.reservations (day, slot);
create index reservations_recent on public.reservations (created_at desc);

-- Créneaux encore réservables en ligne pour un jour et un nombre de personnes.
create function public._booking_slots(p_day date, p_party int) returns setof time
language sql stable security definer set search_path = '' as $$
  select t::time
  from public.booking_settings s
  join public.opening_hours h on h.weekday = extract(isodow from p_day)::int and h.open
  cross join lateral generate_series(p_day + h.first_slot, p_day + h.last_slot, make_interval(mins => s.slot_minutes)) t
  where s.online_enabled
    and p_party between 1 and s.max_party_online
    and p_day <= (now() at time zone 'Europe/Paris')::date + s.max_days_ahead
    and t >= (now() at time zone 'Europe/Paris') + make_interval(mins => s.min_lead_minutes)
    and (h.break_from is null or t::time < h.break_from or t::time >= h.break_to)
    and (s.capacity_per_slot is null or p_party + coalesce((
          select sum(r.party) from public.reservations r
          where r.day = p_day and r.slot = t::time and r.status in ('confirmed', 'seated')), 0) <= s.capacity_per_slot)
  order by t
$$;

-- Ce que la page publique a besoin de savoir : règles et jours d'ouverture. Aucune donnée de client.
create function public.booking_info() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'online_enabled', s.online_enabled, 'max_party_online', s.max_party_online, 'max_days_ahead', s.max_days_ahead,
    'phone', s.phone, 'notice', s.notice,
    'today', (now() at time zone 'Europe/Paris')::date,
    'open_weekdays', (select coalesce(jsonb_agg(weekday order by weekday), '[]'::jsonb) from public.opening_hours where open))
  from public.booking_settings s
$$;

-- Créneaux libres d'un jour, pour la page publique.
create function public.booking_slots(p_day date, p_party int) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(to_char(s, 'HH24:MI') order by s), '[]'::jsonb) from public._booking_slots(p_day, p_party) s
$$;

-- Réserver en ligne. Renvoie {ok:true, id, code} ou {ok:false, error}.
-- p_trap est un champ caché du formulaire : un robot le remplit, une personne non.
create function public.book_table(p_day date, p_slot time, p_party int, p_name text, p_phone text, p_email text, p_note text, p_trap text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s      public.booking_settings;
  v_id   uuid;
  v_code text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 20);
  tel    text := regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g');
begin
  select * into s from public.booking_settings;
  if not s.online_enabled then return jsonb_build_object('ok', false, 'error', 'disabled'); end if;
  if length(coalesce(p_trap, '')) > 0 then return jsonb_build_object('ok', false, 'error', 'contact'); end if;
  if length(btrim(coalesce(p_name, ''))) < 2 or length(tel) < 8 then return jsonb_build_object('ok', false, 'error', 'contact'); end if;
  if p_party is null or p_party < 1 or p_party > s.max_party_online then return jsonb_build_object('ok', false, 'error', 'party'); end if;

  -- Garde-fous contre les envois en rafale.
  if (select count(*) from public.reservations where source = 'en_ligne' and created_at > now() - interval '10 minutes') >= 20 then
    return jsonb_build_object('ok', false, 'error', 'too_many');
  end if;
  if (select count(*) from public.reservations
      where source = 'en_ligne' and phone = tel and status = 'confirmed' and day >= (now() at time zone 'Europe/Paris')::date) >= 3 then
    return jsonb_build_object('ok', false, 'error', 'too_many_phone');
  end if;

  perform pg_advisory_xact_lock(7461002, (p_day - date '2020-01-01'));
  if not exists (select 1 from public._booking_slots(p_day, p_party) t where t = p_slot) then
    return jsonb_build_object('ok', false, 'error', 'slot');
  end if;

  insert into public.reservations (day, slot, party, name, phone, email, note, source, code_hash)
    values (p_day, p_slot, p_party, btrim(p_name), tel, lower(btrim(coalesce(p_email, ''))), left(btrim(coalesce(p_note, '')), 300),
            'en_ligne', sha256(convert_to(v_code, 'UTF8')))
    returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'code', v_code);
end $$;

-- La réservation d'un client, retrouvée par son lien (identifiant et code).
create function public.my_booking(p_id uuid, p_code text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('day', r.day, 'slot', to_char(r.slot, 'HH24:MI'), 'party', r.party, 'name', r.name, 'status', r.status,
                            'phone', (select phone from public.booking_settings))
  from public.reservations r
  where r.id = p_id and r.code_hash = sha256(convert_to(coalesce(p_code, ''), 'UTF8'))
$$;

-- Le client annule sa réservation avec son lien.
create function public.cancel_booking(p_id uuid, p_code text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update public.reservations set status = 'cancelled', updated_at = now()
    where id = p_id and code_hash = sha256(convert_to(coalesce(p_code, ''), 'UTF8'))
      and status = 'confirmed' and day >= (now() at time zone 'Europe/Paris')::date;
  return found;
end $$;

-- L'équipe ajoute ou modifie une réservation (téléphone, sur place, Instagram…). Aucune limite de taille ni d'horaire.
create function public.save_reservation(
  p_id uuid, p_day date, p_slot time, p_party int, p_name text, p_phone text, p_email text, p_note text, p_source text, p_table text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me_id uuid := public._member();
  v_id  uuid := p_id;
begin
  if p_day is null or p_slot is null then raise exception 'Indique le jour et l''heure.' using errcode = 'P0001'; end if;
  if p_party is null or p_party < 1 then raise exception 'Indique le nombre de personnes.' using errcode = 'P0001'; end if;
  if length(btrim(coalesce(p_name, ''))) = 0 then raise exception 'Indique le nom du client.' using errcode = 'P0001'; end if;
  if v_id is null then
    insert into public.reservations (day, slot, party, name, phone, email, note, source, table_label, created_by)
      values (p_day, p_slot, p_party, btrim(p_name), btrim(coalesce(p_phone, '')), lower(btrim(coalesce(p_email, ''))),
              btrim(coalesce(p_note, '')), coalesce(nullif(p_source, ''), 'telephone'), btrim(coalesce(p_table, '')), me_id)
      returning id into v_id;
  else
    update public.reservations
      set day = p_day, slot = p_slot, party = p_party, name = btrim(p_name), phone = btrim(coalesce(p_phone, '')),
          email = lower(btrim(coalesce(p_email, ''))), note = btrim(coalesce(p_note, '')),
          table_label = btrim(coalesce(p_table, '')), updated_at = now()
      where id = v_id;
    if not found then raise exception 'Réservation introuvable.' using errcode = 'P0001'; end if;
  end if;
  return v_id;
end $$;

-- Arrivés, absents, annulée, ou retour à « confirmée ».
create function public.set_reservation_status(p_id uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public._member();
  if p_status is null or p_status not in ('confirmed', 'seated', 'no_show', 'cancelled') then
    raise exception 'Statut inconnu.' using errcode = 'P0001';
  end if;
  update public.reservations set status = p_status, updated_at = now() where id = p_id;
  if not found then raise exception 'Réservation introuvable.' using errcode = 'P0001'; end if;
end $$;

-- ---------- Accueil : ajoute les réservations du jour -------------------------
create or replace function public.today_tasks() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  d  date := public.service_day();
  sl text := public._slot();
begin
  if public.my_profile_id() is null then return null; end if;
  return jsonb_build_object(
    'day', d,
    'slot', sl,
    'checks_total', (select count(*) from public.checklist_items i join public.checklists c on c.id = i.checklist_id
                     where i.active and c.active and c.frequency = 'daily'),
    'checks_done', (select count(*) from public.checklist_ticks t
                    join public.checklist_items i on i.id = t.item_id and i.active
                    join public.checklists c on c.id = i.checklist_id and c.active and c.frequency = 'daily'
                    where t.period = d),
    'temps_due', (select count(*) from public.cold_units u
                  where u.active and not exists (
                    select 1 from public.temp_readings r
                    where r.unit_id = u.id and r.day = d and (u.readings_per_day = 1 or r.slot = sl))),
    'temps_alerts', (select count(*) from public.temp_readings r join public.cold_units u on u.id = r.unit_id and u.active
                     where r.out_of_range and r.corrective = '' and r.day >= d - 1),
    'dlc_today', (select count(*) from public.trace_items where closed_at is null and use_by = d),
    'dlc_late', (select count(*) from public.trace_items where closed_at is null and use_by < d),
    'low_stock', (select count(*) from public.products where active and threshold > 0 and quantity < threshold),
    'deliveries', (select count(*) from public.orders where status = 'sent'),
    'bookings', (select count(*) from public.reservations where day = d and status in ('confirmed', 'seated')),
    'covers', (select coalesce(sum(party), 0) from public.reservations where day = d and status in ('confirmed', 'seated')));
end $$;

-- ---------- Sécurité : droits et RLS --------------------------------------------
alter table public.booking_settings enable row level security;
alter table public.opening_hours    enable row level security;
alter table public.reservations     enable row level security;

revoke all on public.booking_settings, public.opening_hours, public.reservations from anon, authenticated;
-- Lecture par l'équipe, y compris dans une session à code PIN. Le public ne lit rien directement :
-- la page de réservation passe par booking_info, booking_slots, book_table, my_booking et cancel_booking.
grant select on public.booking_settings, public.opening_hours, public.reservations to anon, authenticated;
grant update on public.booking_settings, public.opening_hours to authenticated;

create policy "regles: lecture" on public.booking_settings
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "regles: modification par le gerant" on public.booking_settings
  for update to authenticated using ((select public.is_gerant())) with check ((select public.is_gerant()));
create policy "horaires: lecture" on public.opening_hours
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "horaires: modification par le gerant" on public.opening_hours
  for update to authenticated using ((select public.is_gerant())) with check ((select public.is_gerant()));
create policy "reservations: lecture" on public.reservations
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);

revoke all on function
  public.booking_info(), public.booking_slots(date, int),
  public.book_table(date, time, int, text, text, text, text, text),
  public.my_booking(uuid, text), public.cancel_booking(uuid, text),
  public.save_reservation(uuid, date, time, int, text, text, text, text, text, text),
  public.set_reservation_status(uuid, text)
  from public;
grant execute on function
  public.booking_info(), public.booking_slots(date, int),
  public.book_table(date, time, int, text, text, text, text, text),
  public.my_booking(uuid, text), public.cancel_booking(uuid, text),
  public.save_reservation(uuid, date, time, int, text, text, text, text, text, text),
  public.set_reservation_status(uuid, text)
  to anon, authenticated;
revoke all on function public._booking_slots(date, int) from public, anon, authenticated;

-- >>>>>>>>>> 0008_evenements_clients.sql
-- =====================================================================
-- Nuba Gestion · migration 0008 · événements et fichier clients
--
-- À exécuter une seule fois dans Supabase, après la 0007 :
--   SQL Editor > New query > coller tout ce fichier > Run.
--
-- Principes :
--   * un événement est une privatisation, un concert, une exposition ou une
--     prestation extérieure ; il avance de la demande au devis, à l'acompte,
--     puis à la confirmation ;
--   * chaque événement a sa liste de choses à préparer, que l'équipe coche ;
--   * les clients peuvent envoyer une demande depuis une page publique ; elle
--     arrive comme « demande » ; l'équipe peut aussi en noter une ;
--   * le gérant chiffre, confirme et modifie ; toute l'équipe consulte ;
--   * le fichier clients regroupe particuliers, entreprises, artistes et
--     prestataires ; il n'est lisible que par l'équipe.
-- =====================================================================

-- ---------- Fichier clients --------------------------------------------------
create table public.customers (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) > 0),
  kind       text not null default 'particulier' check (kind in ('particulier', 'entreprise', 'artiste', 'prestataire')),
  company    text not null default '',
  phone      text not null default '',
  email      text not null default '',
  note       text not null default '',
  active     boolean not null default true,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index customers_by_name on public.customers (lower(name));

-- Ajouter ou modifier une fiche. Toute l'équipe peut le faire.
create function public.save_customer(p_id uuid, p_name text, p_kind text, p_company text, p_phone text, p_email text, p_note text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me_id uuid := public._member();
  v_id  uuid := p_id;
begin
  if length(btrim(coalesce(p_name, ''))) = 0 then raise exception 'Indique le nom.' using errcode = 'P0001'; end if;
  if v_id is null then
    insert into public.customers (name, kind, company, phone, email, note, created_by)
      values (btrim(p_name), coalesce(nullif(p_kind, ''), 'particulier'), btrim(coalesce(p_company, '')), btrim(coalesce(p_phone, '')),
              lower(btrim(coalesce(p_email, ''))), btrim(coalesce(p_note, '')), me_id)
      returning id into v_id;
  else
    update public.customers
      set name = btrim(p_name), kind = coalesce(nullif(p_kind, ''), kind), company = btrim(coalesce(p_company, '')),
          phone = btrim(coalesce(p_phone, '')), email = lower(btrim(coalesce(p_email, ''))), note = btrim(coalesce(p_note, ''))
      where id = v_id;
    if not found then raise exception 'Fiche introuvable.' using errcode = 'P0001'; end if;
  end if;
  return v_id;
end $$;

-- ---------- Événements ---------------------------------------------------
create table public.events (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in ('privatisation', 'concert', 'exposition', 'exterieur')),
  title        text not null check (length(btrim(title)) > 0),
  day          date not null,
  end_day      date,
  start_time   time,
  guests       int check (guests is null or guests between 1 and 5000),
  status       text not null default 'demande' check (status in ('demande', 'devis', 'acompte', 'confirme', 'termine', 'annule')),
  customer_id  uuid references public.customers (id) on delete set null,
  site_id      uuid references public.sites (id) on delete set null,
  amount       numeric(10, 2) check (amount is null or amount >= 0),
  deposit      numeric(10, 2) check (deposit is null or deposit >= 0),
  deposit_paid boolean not null default false,
  details      text not null default '',
  note         text not null default '',
  source       text not null default 'equipe' check (source in ('equipe', 'en_ligne')),
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  constraint events_days check (end_day is null or end_day >= day)
);
create index events_by_day on public.events (day);

create table public.event_tasks (
  id       uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  label    text not null check (length(btrim(label)) > 0),
  position int not null default 0,
  done_by  uuid references public.profiles (id) on delete set null,
  done_at  timestamptz
);
create index event_tasks_by_event on public.event_tasks (event_id, position);

-- Choses à préparer proposées à la création, selon le type d'événement.
create function public._seed_event_tasks(p_event uuid, p_kind text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  labels text[] := case p_kind
    when 'privatisation' then array['Devis signé', 'Acompte encaissé', 'Menu validé avec la cuisine', 'Plan de salle envoyé au client', 'Équipe prévue au planning']
    when 'concert' then array['Contrat signé', 'Fiche technique reçue', 'Déclaration des droits d''auteur', 'Repas des artistes prévu', 'Annonce publiée']
    when 'exposition' then array['Contrats de dépôt signés', 'Accrochage terminé', 'Cartels et liste de prix imprimés', 'Vernissage annoncé']
    else array['Devis signé', 'Acompte encaissé', 'Matériel listé et chargé', 'Équipe prévue au planning', 'Lieu et accès confirmés avec le client']
  end;
  i int;
begin
  for i in 1 .. array_length(labels, 1) loop
    insert into public.event_tasks (event_id, label, position) values (p_event, labels[i], i);
  end loop;
end $$;

-- Créer ou modifier un événement. Réservé au gérant. p : les champs de l'événement.
create function public.save_event(p_id uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := p_id;
begin
  if not public.is_gerant() then
    raise exception 'Réservé au gérant.' using errcode = '42501';
  end if;
  if v_id is null then
    insert into public.events (kind, title, day, end_day, start_time, guests, status, customer_id, site_id, amount, deposit, deposit_paid, details, note, created_by)
      values (p ->> 'kind', btrim(p ->> 'title'), (p ->> 'day')::date, nullif(p ->> 'end_day', '')::date, nullif(p ->> 'start_time', '')::time,
              nullif(p ->> 'guests', '')::int, coalesce(nullif(p ->> 'status', ''), 'demande'), nullif(p ->> 'customer_id', '')::uuid,
              nullif(p ->> 'site_id', '')::uuid, nullif(p ->> 'amount', '')::numeric, nullif(p ->> 'deposit', '')::numeric,
              coalesce((p ->> 'deposit_paid')::boolean, false), btrim(coalesce(p ->> 'details', '')), btrim(coalesce(p ->> 'note', '')),
              public.my_profile_id())
      returning id into v_id;
    perform public._seed_event_tasks(v_id, p ->> 'kind');
  else
    update public.events
      set kind = p ->> 'kind', title = btrim(p ->> 'title'), day = (p ->> 'day')::date, end_day = nullif(p ->> 'end_day', '')::date,
          start_time = nullif(p ->> 'start_time', '')::time, guests = nullif(p ->> 'guests', '')::int,
          status = coalesce(nullif(p ->> 'status', ''), status), customer_id = nullif(p ->> 'customer_id', '')::uuid,
          site_id = nullif(p ->> 'site_id', '')::uuid, amount = nullif(p ->> 'amount', '')::numeric,
          deposit = nullif(p ->> 'deposit', '')::numeric, deposit_paid = coalesce((p ->> 'deposit_paid')::boolean, false),
          details = btrim(coalesce(p ->> 'details', '')), note = btrim(coalesce(p ->> 'note', ''))
      where id = v_id;
    if not found then raise exception 'Événement introuvable.' using errcode = 'P0001'; end if;
  end if;
  return v_id;
end $$;

-- L'équipe note une demande reçue au bar ou par téléphone : le gérant la traitera.
create function public.request_event(p_kind text, p_title text, p_day date, p_guests int, p_customer uuid, p_note text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me_id uuid := public._member();
  v_id  uuid;
begin
  if p_day is null or length(btrim(coalesce(p_title, ''))) = 0 then
    raise exception 'Indique un titre et une date.' using errcode = 'P0001';
  end if;
  insert into public.events (kind, title, day, guests, status, customer_id, note, created_by)
    values (p_kind, btrim(p_title), p_day, p_guests, 'demande', p_customer, btrim(coalesce(p_note, '')), me_id)
    returning id into v_id;
  perform public._seed_event_tasks(v_id, p_kind);
  return v_id;
end $$;

-- Cocher ou décocher une chose à préparer.
create function public.tick_event_task(p_task uuid, p_done boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me_id uuid := public._member();
begin
  update public.event_tasks
    set done_by = case when p_done then me_id end, done_at = case when p_done then now() end
    where id = p_task;
  if not found then raise exception 'Tâche introuvable.' using errcode = 'P0001'; end if;
end $$;

-- Demande envoyée par un client depuis la page publique. Renvoie {ok} ou {ok:false, error}.
create function public.request_private_event(
  p_kind text, p_day date, p_guests int, p_name text, p_company text, p_phone text, p_email text, p_message text, p_trap text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  tel  text := regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g');
  c_id uuid;
  e_id uuid;
begin
  if length(coalesce(p_trap, '')) > 0 then return jsonb_build_object('ok', false, 'error', 'contact'); end if;
  if length(btrim(coalesce(p_name, ''))) < 2 or length(tel) < 8 then return jsonb_build_object('ok', false, 'error', 'contact'); end if;
  if p_kind is null or p_kind not in ('privatisation', 'exterieur') then return jsonb_build_object('ok', false, 'error', 'kind'); end if;
  if p_day is null or p_day < (now() at time zone 'Europe/Paris')::date or p_day > (now() at time zone 'Europe/Paris')::date + 730 then
    return jsonb_build_object('ok', false, 'error', 'day');
  end if;
  if p_guests is null or p_guests < 1 or p_guests > 2000 then return jsonb_build_object('ok', false, 'error', 'guests'); end if;
  if (select count(*) from public.events where source = 'en_ligne' and created_at > now() - interval '10 minutes') >= 10 then
    return jsonb_build_object('ok', false, 'error', 'too_many');
  end if;

  -- Même téléphone : on complète la fiche existante plutôt que d'en créer une seconde.
  select id into c_id from public.customers where regexp_replace(phone, '[^0-9+]', '', 'g') = tel and active limit 1;
  if c_id is null then
    insert into public.customers (name, kind, company, phone, email)
      values (btrim(p_name), case when length(btrim(coalesce(p_company, ''))) > 0 then 'entreprise' else 'particulier' end,
              btrim(coalesce(p_company, '')), tel, lower(btrim(coalesce(p_email, ''))))
      returning id into c_id;
  end if;
  insert into public.events (kind, title, day, guests, status, customer_id, note, source)
    values (p_kind, case p_kind when 'exterieur' then 'Prestation extérieure' else 'Privatisation' end || ', ' || btrim(p_name),
            p_day, p_guests, 'demande', c_id, left(btrim(coalesce(p_message, '')), 1000), 'en_ligne')
    returning id into e_id;
  perform public._seed_event_tasks(e_id, p_kind);
  return jsonb_build_object('ok', true);
end $$;

-- ---------- Accueil : ajoute les événements ---------------------------------
create or replace function public.today_tasks() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  d  date := public.service_day();
  sl text := public._slot();
begin
  if public.my_profile_id() is null then return null; end if;
  return jsonb_build_object(
    'day', d,
    'slot', sl,
    'checks_total', (select count(*) from public.checklist_items i join public.checklists c on c.id = i.checklist_id
                     where i.active and c.active and c.frequency = 'daily'),
    'checks_done', (select count(*) from public.checklist_ticks t
                    join public.checklist_items i on i.id = t.item_id and i.active
                    join public.checklists c on c.id = i.checklist_id and c.active and c.frequency = 'daily'
                    where t.period = d),
    'temps_due', (select count(*) from public.cold_units u
                  where u.active and not exists (
                    select 1 from public.temp_readings r
                    where r.unit_id = u.id and r.day = d and (u.readings_per_day = 1 or r.slot = sl))),
    'temps_alerts', (select count(*) from public.temp_readings r join public.cold_units u on u.id = r.unit_id and u.active
                     where r.out_of_range and r.corrective = '' and r.day >= d - 1),
    'dlc_today', (select count(*) from public.trace_items where closed_at is null and use_by = d),
    'dlc_late', (select count(*) from public.trace_items where closed_at is null and use_by < d),
    'low_stock', (select count(*) from public.products where active and threshold > 0 and quantity < threshold),
    'deliveries', (select count(*) from public.orders where status = 'sent'),
    'bookings', (select count(*) from public.reservations where day = d and status in ('confirmed', 'seated')),
    'covers', (select coalesce(sum(party), 0) from public.reservations where day = d and status in ('confirmed', 'seated')),
    'events_today', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'title', e.title, 'start_time', to_char(e.start_time, 'HH24:MI'), 'guests', e.guests)
                                               order by e.start_time nulls last), '[]'::jsonb)
                     from public.events e
                     where d between e.day and coalesce(e.end_day, e.day) and e.status in ('acompte', 'confirme')),
    'event_requests', (select count(*) from public.events where status = 'demande'));
end $$;

-- ---------- Sécurité : droits et RLS --------------------------------------------
alter table public.customers   enable row level security;
alter table public.events      enable row level security;
alter table public.event_tasks enable row level security;

revoke all on public.customers, public.events, public.event_tasks from anon, authenticated;
grant select on public.customers, public.events, public.event_tasks to anon, authenticated;
grant update (active) on public.customers to authenticated;
grant insert, delete on public.event_tasks to authenticated;
grant delete on public.events to authenticated;

create policy "clients: lecture" on public.customers
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "clients: retrait par le gerant" on public.customers
  for update to authenticated using ((select public.is_gerant())) with check ((select public.is_gerant()));
create policy "evenements: lecture" on public.events
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "evenements: suppression par le gerant" on public.events
  for delete to authenticated using ((select public.is_gerant()));
create policy "preparation: lecture" on public.event_tasks
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "preparation: ajout par le gerant" on public.event_tasks
  for insert to authenticated with check ((select public.is_gerant()));
create policy "preparation: retrait par le gerant" on public.event_tasks
  for delete to authenticated using ((select public.is_gerant()));

revoke all on function
  public.save_customer(uuid, text, text, text, text, text, text),
  public.request_event(text, text, date, int, uuid, text), public.tick_event_task(uuid, boolean),
  public.request_private_event(text, date, int, text, text, text, text, text, text)
  from public;
grant execute on function
  public.save_customer(uuid, text, text, text, text, text, text),
  public.request_event(text, text, date, int, uuid, text), public.tick_event_task(uuid, boolean),
  public.request_private_event(text, date, int, text, text, text, text, text, text)
  to anon, authenticated;
revoke all on function public.save_event(uuid, jsonb) from public, anon;
grant execute on function public.save_event(uuid, jsonb) to authenticated;
revoke all on function public._seed_event_tasks(uuid, text) from public, anon, authenticated;

-- >>>>>>>>>> 0009_pilotage.sql
-- =====================================================================
-- Nuba Gestion · migration 0009 · fiches techniques, maintenance, procédures
--
-- À exécuter une seule fois dans Supabase, après la 0008 :
--   SQL Editor > New query > coller tout ce fichier > Run.
--
-- Principes :
--   * fiches techniques : ingrédients, grammages, préparation et allergènes,
--     lisibles par toute l'équipe ; le gérant les écrit et voit leur coût ;
--   * pannes : n'importe qui signale et suit une panne ;
--   * échéances (contrôles, contrats, documents de l'équipe) : réservées au
--     gérant, avec rappel sur son accueil ;
--   * procédures : chacun les lit et confirme sa lecture ; le gérant les écrit
--     et voit qui les a lues.
-- =====================================================================

-- ---------- Fiches techniques ------------------------------------------------
create table public.recipes (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) > 0),
  category   text not null default 'Cuisine',
  portions   numeric(6, 2) not null default 1 check (portions > 0),
  sale_price numeric(10, 2) check (sale_price is null or sale_price >= 0),
  vat        numeric(4, 1) not null default 10 check (vat between 0 and 30),
  method     text not null default '',
  allergens  text[] not null default '{}',
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- Un ingrédient : un produit du stock (coût calculé) ou une ligne libre (coût saisi).
-- pack_size : combien d'unités de la recette contient une unité du produit (70 cl dans une bouteille de 70 cl).
create table public.recipe_items (
  id          uuid primary key default gen_random_uuid(),
  recipe_id   uuid not null references public.recipes (id) on delete cascade,
  product_id  uuid references public.products (id) on delete set null,
  label       text not null default '',
  quantity    numeric(10, 3) not null check (quantity > 0),
  unit        text not null default '',
  pack_size   numeric(10, 3) not null default 1 check (pack_size > 0),
  manual_cost numeric(10, 2) check (manual_cost is null or manual_cost >= 0),
  position    int not null default 0
);
create index recipe_items_by_recipe on public.recipe_items (recipe_id, position);

-- Créer ou modifier une fiche technique et ses ingrédients. Réservé au gérant.
-- p : champs de la fiche ; p_items : [{product_id?, label, quantity, unit, pack_size?, manual_cost?}].
create function public.save_recipe(p_id uuid, p jsonb, p_items jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := p_id;
  it   jsonb;
  n    int := 0;
begin
  if not public.is_gerant() then
    raise exception 'Réservé au gérant.' using errcode = '42501';
  end if;
  if v_id is null then
    insert into public.recipes (name, category, portions, sale_price, vat, method, allergens)
      values (btrim(p ->> 'name'), coalesce(nullif(btrim(p ->> 'category'), ''), 'Cuisine'), coalesce(nullif(p ->> 'portions', '')::numeric, 1),
              nullif(p ->> 'sale_price', '')::numeric, coalesce(nullif(p ->> 'vat', '')::numeric, 10), coalesce(p ->> 'method', ''),
              coalesce((select array_agg(a order by a) from jsonb_array_elements_text(coalesce(p -> 'allergens', '[]'::jsonb)) a), '{}'))
      returning id into v_id;
  else
    update public.recipes
      set name = btrim(p ->> 'name'), category = coalesce(nullif(btrim(p ->> 'category'), ''), 'Cuisine'),
          portions = coalesce(nullif(p ->> 'portions', '')::numeric, 1), sale_price = nullif(p ->> 'sale_price', '')::numeric,
          vat = coalesce(nullif(p ->> 'vat', '')::numeric, 10), method = coalesce(p ->> 'method', ''),
          allergens = coalesce((select array_agg(a order by a) from jsonb_array_elements_text(coalesce(p -> 'allergens', '[]'::jsonb)) a), '{}'),
          active = coalesce((p ->> 'active')::boolean, active)
      where id = v_id;
    if not found then raise exception 'Fiche introuvable.' using errcode = 'P0001'; end if;
    delete from public.recipe_items where recipe_id = v_id;
  end if;

  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    continue when coalesce(nullif(it ->> 'quantity', '')::numeric, 0) <= 0;
    n := n + 1;
    insert into public.recipe_items (recipe_id, product_id, label, quantity, unit, pack_size, manual_cost, position)
      values (v_id, nullif(it ->> 'product_id', '')::uuid, btrim(coalesce(it ->> 'label', '')), (it ->> 'quantity')::numeric,
              btrim(coalesce(it ->> 'unit', '')), coalesce(nullif(it ->> 'pack_size', '')::numeric, 1), nullif(it ->> 'manual_cost', '')::numeric, n);
  end loop;
  return v_id;
end $$;

-- ---------- Pannes -----------------------------------------------------------
create table public.issues (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (length(btrim(title)) > 0),
  place       text not null default '',
  details     text not null default '',
  urgent      boolean not null default false,
  status      text not null default 'open' check (status in ('open', 'doing', 'done')),
  resolution  text not null default '',
  reported_by uuid references public.profiles (id) on delete set null,
  reported_at timestamptz not null default now(),
  closed_by   uuid references public.profiles (id) on delete set null,
  closed_at   timestamptz
);
create index issues_by_status on public.issues (status, reported_at desc);

-- Signaler une panne. Toute l'équipe.
create function public.report_issue(p_title text, p_place text, p_details text, p_urgent boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me_id uuid := public._member();
  v_id  uuid;
begin
  if length(btrim(coalesce(p_title, ''))) = 0 then raise exception 'Décris la panne en quelques mots.' using errcode = 'P0001'; end if;
  insert into public.issues (title, place, details, urgent, reported_by)
    values (btrim(p_title), btrim(coalesce(p_place, '')), btrim(coalesce(p_details, '')), coalesce(p_urgent, false), me_id)
    returning id into v_id;
  return v_id;
end $$;

-- Faire avancer une panne : 'open', 'doing' (en cours de réparation) ou 'done' (réparée).
create function public.set_issue_status(p_id uuid, p_status text, p_resolution text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me_id uuid := public._member();
begin
  if p_status is null or p_status not in ('open', 'doing', 'done') then raise exception 'Statut inconnu.' using errcode = 'P0001'; end if;
  update public.issues
    set status = p_status, resolution = coalesce(nullif(btrim(coalesce(p_resolution, '')), ''), resolution),
        closed_by = case when p_status = 'done' then me_id end, closed_at = case when p_status = 'done' then now() end
    where id = p_id;
  if not found then raise exception 'Panne introuvable.' using errcode = 'P0001'; end if;
end $$;

-- ---------- Échéances (gérant) ----------------------------------------------
create table public.deadlines (
  id            uuid primary key default gen_random_uuid(),
  title         text not null check (length(btrim(title)) > 0),
  category      text not null default 'controle' check (category in ('controle', 'contrat', 'document', 'autre')),
  due_date      date not null,
  repeat_months int check (repeat_months is null or repeat_months between 1 and 240),
  profile_id    uuid references public.profiles (id) on delete cascade,
  note          text not null default '',
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create index deadlines_by_due on public.deadlines (due_date) where active;

create table public.deadline_done (
  id          uuid primary key default gen_random_uuid(),
  deadline_id uuid not null references public.deadlines (id) on delete cascade,
  done_on     date not null,
  done_by     uuid references public.profiles (id) on delete set null,
  note        text not null default ''
);

-- Échéance faite : une échéance qui revient est reportée, une échéance unique est classée.
create function public.complete_deadline(p_id uuid, p_done_on date, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  d   public.deadlines;
  day date := coalesce(p_done_on, (now() at time zone 'Europe/Paris')::date);
begin
  if not public.is_gerant() then
    raise exception 'Réservé au gérant.' using errcode = '42501';
  end if;
  select * into d from public.deadlines where id = p_id and active for update;
  if not found then raise exception 'Échéance introuvable.' using errcode = 'P0001'; end if;
  insert into public.deadline_done (deadline_id, done_on, done_by, note)
    values (p_id, day, public.my_profile_id(), btrim(coalesce(p_note, '')));
  if d.repeat_months is null then
    update public.deadlines set active = false where id = p_id;
  else
    update public.deadlines set due_date = (day + make_interval(months => d.repeat_months))::date where id = p_id;
  end if;
end $$;

-- ---------- Procédures et formation ---------------------------------------
create table public.procedures (
  id         uuid primary key default gen_random_uuid(),
  title      text not null check (length(btrim(title)) > 0),
  category   text not null default 'Général',
  body       text not null default '',
  must_read  boolean not null default true,
  position   int not null default 0,
  active     boolean not null default true,
  updated_at timestamptz not null default now()
);

create table public.procedure_reads (
  procedure_id uuid not null references public.procedures (id) on delete cascade,
  profile_id   uuid not null references public.profiles (id) on delete cascade,
  read_at      timestamptz not null default now(),
  primary key (procedure_id, profile_id)
);

-- Créer ou modifier une procédure. p_reset : redemander la lecture à tout le monde. Réservé au gérant.
create function public.save_procedure(p_id uuid, p_title text, p_category text, p_body text, p_must_read boolean, p_reset boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := p_id;
begin
  if not public.is_gerant() then
    raise exception 'Réservé au gérant.' using errcode = '42501';
  end if;
  if v_id is null then
    insert into public.procedures (title, category, body, must_read, position)
      values (btrim(p_title), coalesce(nullif(btrim(p_category), ''), 'Général'), coalesce(p_body, ''), coalesce(p_must_read, true),
              coalesce((select max(position) + 1 from public.procedures), 0))
      returning id into v_id;
  else
    update public.procedures
      set title = btrim(p_title), category = coalesce(nullif(btrim(p_category), ''), 'Général'), body = coalesce(p_body, ''),
          must_read = coalesce(p_must_read, true), updated_at = now()
      where id = v_id;
    if not found then raise exception 'Procédure introuvable.' using errcode = 'P0001'; end if;
    if coalesce(p_reset, false) then delete from public.procedure_reads where procedure_id = v_id; end if;
  end if;
  return v_id;
end $$;

-- « J'ai lu et compris ».
create function public.ack_procedure(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me_id uuid := public._member();
begin
  if not exists (select 1 from public.procedures where id = p_id and active) then
    raise exception 'Procédure introuvable.' using errcode = 'P0001';
  end if;
  insert into public.procedure_reads (procedure_id, profile_id) values (p_id, me_id) on conflict do nothing;
end $$;

-- ---------- Accueil : pannes, procédures à lire, échéances du gérant ----------
create or replace function public.today_tasks() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  d   date := public.service_day();
  sl  text := public._slot();
  me  uuid := public.my_profile_id();
begin
  if me is null then return null; end if;
  return jsonb_build_object(
    'day', d,
    'slot', sl,
    'checks_total', (select count(*) from public.checklist_items i join public.checklists c on c.id = i.checklist_id
                     where i.active and c.active and c.frequency = 'daily'),
    'checks_done', (select count(*) from public.checklist_ticks t
                    join public.checklist_items i on i.id = t.item_id and i.active
                    join public.checklists c on c.id = i.checklist_id and c.active and c.frequency = 'daily'
                    where t.period = d),
    'temps_due', (select count(*) from public.cold_units u
                  where u.active and not exists (
                    select 1 from public.temp_readings r
                    where r.unit_id = u.id and r.day = d and (u.readings_per_day = 1 or r.slot = sl))),
    'temps_alerts', (select count(*) from public.temp_readings r join public.cold_units u on u.id = r.unit_id and u.active
                     where r.out_of_range and r.corrective = '' and r.day >= d - 1),
    'dlc_today', (select count(*) from public.trace_items where closed_at is null and use_by = d),
    'dlc_late', (select count(*) from public.trace_items where closed_at is null and use_by < d),
    'low_stock', (select count(*) from public.products where active and threshold > 0 and quantity < threshold),
    'deliveries', (select count(*) from public.orders where status = 'sent'),
    'bookings', (select count(*) from public.reservations where day = d and status in ('confirmed', 'seated')),
    'covers', (select coalesce(sum(party), 0) from public.reservations where day = d and status in ('confirmed', 'seated')),
    'events_today', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'title', e.title, 'start_time', to_char(e.start_time, 'HH24:MI'), 'guests', e.guests)
                                               order by e.start_time nulls last), '[]'::jsonb)
                     from public.events e
                     where d between e.day and coalesce(e.end_day, e.day) and e.status in ('acompte', 'confirme')),
    'event_requests', (select count(*) from public.events where status = 'demande'),
    'issues_open', (select count(*) from public.issues where status <> 'done'),
    'issues_urgent', (select count(*) from public.issues where status <> 'done' and urgent),
    'procedures_unread', (select count(*) from public.procedures p
                          where p.active and p.must_read
                            and not exists (select 1 from public.procedure_reads r where r.procedure_id = p.id and r.profile_id = me)),
    -- Échéances dans les 30 jours ou dépassées : seulement pour le gérant.
    'deadlines_due', case when public.is_gerant()
                          then (select count(*) from public.deadlines where active and due_date <= d + 30) end);
end $$;

-- ---------- Sécurité : droits et RLS --------------------------------------------
alter table public.recipes         enable row level security;
alter table public.recipe_items    enable row level security;
alter table public.issues          enable row level security;
alter table public.deadlines       enable row level security;
alter table public.deadline_done   enable row level security;
alter table public.procedures      enable row level security;
alter table public.procedure_reads enable row level security;

revoke all on public.recipes, public.recipe_items, public.issues, public.deadlines, public.deadline_done,
              public.procedures, public.procedure_reads from anon, authenticated;
-- Lecture par toute l'équipe, y compris dans une session à code PIN.
grant select on public.recipes, public.recipe_items, public.issues, public.procedures, public.procedure_reads to anon, authenticated;
-- Échéances : le gérant seulement, avec son compte.
grant select, insert, update, delete on public.deadlines to authenticated;
grant select on public.deadline_done to authenticated;
grant update (active) on public.procedures to authenticated;
grant delete on public.recipes, public.issues to authenticated;

create policy "fiches: lecture" on public.recipes
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "fiches: suppression par le gerant" on public.recipes
  for delete to authenticated using ((select public.is_gerant()));
create policy "ingredients: lecture" on public.recipe_items
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);

create policy "pannes: lecture" on public.issues
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "pannes: suppression par le gerant" on public.issues
  for delete to authenticated using ((select public.is_gerant()));

create policy "echeances: tout pour le gerant" on public.deadlines
  for all to authenticated using ((select public.is_gerant())) with check ((select public.is_gerant()));
create policy "echeances faites: lecture par le gerant" on public.deadline_done
  for select to authenticated using ((select public.is_gerant()));

create policy "procedures: lecture" on public.procedures
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "procedures: retrait par le gerant" on public.procedures
  for update to authenticated using ((select public.is_gerant())) with check ((select public.is_gerant()));
-- Chacun voit ses lectures ; le gérant voit celles de toute l'équipe.
create policy "lectures: lecture" on public.procedure_reads
  for select to anon, authenticated
  using (profile_id = (select public.my_profile_id()) or (select public.is_gerant()));

revoke all on function
  public.report_issue(text, text, text, boolean), public.set_issue_status(uuid, text, text), public.ack_procedure(uuid)
  from public;
grant execute on function
  public.report_issue(text, text, text, boolean), public.set_issue_status(uuid, text, text), public.ack_procedure(uuid)
  to anon, authenticated;
revoke all on function
  public.save_recipe(uuid, jsonb, jsonb), public.complete_deadline(uuid, date, text),
  public.save_procedure(uuid, text, text, text, boolean, boolean)
  from public, anon;
grant execute on function
  public.save_recipe(uuid, jsonb, jsonb), public.complete_deadline(uuid, date, text),
  public.save_procedure(uuid, text, text, text, boolean, boolean)
  to authenticated;

-- ---------- Modèles de procédures, à adapter à la Nuba ------------------------
insert into public.procedures (title, category, body, must_read, position) values
  ('Bienvenue dans l''équipe', 'Accueil',
   E'Modèle à adapter.\n\nTon premier jour :\n- Présentation de l''équipe et visite des lieux : salle, bar, cuisine, réserve, vestiaire.\n- Où pointer : sur ton téléphone avec le QR code de la borne, ou sur l''iPad avec ton code PIN.\n- Où trouver ton planning, les checklists et les fiches techniques : dans l''appli.\n\nÀ qui t''adresser :\n- Une question sur ton planning, un retard, une absence : préviens le gérant le plus tôt possible.\n- Une panne ou un danger : signale-le tout de suite dans l''appli, rubrique Maintenance.', true, 1),
  ('Hygiène : les gestes de base', 'Hygiène',
   E'Modèle à adapter à ton plan de maîtrise sanitaire.\n\n- Lave-toi les mains à l''arrivée, après les toilettes, après avoir touché des déchets ou des produits crus, et aussi souvent que nécessaire.\n- Tenue propre, cheveux attachés, pas de bijoux aux mains en cuisine.\n- Relève les températures des enceintes froides le matin et le soir dans l''appli. Hors de la cible, note l''action corrective.\n- Étiquette chaque préparation et chaque produit entamé avec sa date limite.\n- Malade ou blessé à la main : préviens le gérant avant de prendre ton poste.', true, 2),
  ('Allergènes : répondre à un client', 'Service',
   E'Modèle à adapter.\n\n- Ne réponds jamais de mémoire : consulte le tableau des allergènes dans l''appli, rubrique Fiches techniques.\n- En cas de doute, demande à la cuisine ou au bar avant de répondre.\n- Signale l''allergie sur la commande et préviens la personne qui prépare.\n- Si tu ne peux pas garantir l''absence d''un allergène, dis-le clairement au client.', true, 3);

commit;
