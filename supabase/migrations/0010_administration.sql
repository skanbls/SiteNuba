-- =====================================================================
-- Nuba Gestion · migration 0010 · administration
--
-- À exécuter une seule fois dans Supabase, après la 0009 :
--   SQL Editor > New query > coller tout ce fichier > Run.
-- Tout passe ou rien ne passe : en cas d'erreur, la base reste comme avant.
--
-- Ce que ce script apporte :
--   1. Accès délégués : le gérant donne à un responsable le droit de tenir
--      une partie de l'appli (checklists, stocks, procédures…). La fonction
--      can('zone') remplace is_gerant() dans les règles et les fonctions
--      de ces zones. Équipe, accès, bornes, lieux et e-mails restent au gérant.
--      Un accès ne vaut qu'avec le compte par e-mail : jamais dans une session
--      à code PIN.
--   2. Créneaux de réservation calés sur la cuisine : midi 12 h – 14 h,
--      soir 19 h – 22 h (22 h 30 vendredi et samedi), dimanche 12 h – 15 h.
--   3. Lien vers le dossier Drive de chaque personne de l'équipe.
--   4. E-mails : confirmation au client, alertes à la Nuba. Rien ne part
--      tant que l'envoi n'est pas activé dans l'appli et que la clé du
--      service d'envoi n'est pas dans le coffre (Vault) de Supabase.
-- =====================================================================
begin;

-- ---------- 1. Accès délégués ----------------------------------------------
create table public.profile_rights (
  profile_id uuid not null references public.profiles (id) on delete cascade,
  area       text not null check (area in ('planning', 'pointages', 'checklists', 'hygiene', 'stocks',
                                           'reservations', 'evenements', 'fiches', 'maintenance', 'procedures')),
  granted_at timestamptz not null default now(),
  primary key (profile_id, area)
);

-- Vrai pour le gérant, et pour un responsable connecté avec son compte qui a reçu cet accès.
-- Toujours faux dans une session à code PIN (elle n'a pas de compte).
create function public.can(p_area text) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_gerant() or exists (
    select 1
    from public.profiles p
    join public.profile_rights r on r.profile_id = p.id and r.area = p_area
    where p.user_id = (select auth.uid()) and p.active and p.role = 'responsable')
$$;

-- Le gérant fixe la liste des accès d'un responsable.
create function public.set_rights(p_profile uuid, p_areas text[]) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_gerant() then
    raise exception 'Réservé au gérant.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_profile and role = 'responsable') then
    raise exception 'Les accès se donnent à un responsable : change d''abord son rôle.' using errcode = 'P0001';
  end if;
  delete from public.profile_rights where profile_id = p_profile and area <> all (coalesce(p_areas, '{}'));
  insert into public.profile_rights (profile_id, area)
    select p_profile, a from unnest(coalesce(p_areas, '{}')) a
    on conflict do nothing;
end $$;

-- Quelqu'un qui n'est plus responsable perd ses accès.
create function public.profiles_drop_rights() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.profile_rights where profile_id = new.id;
  return new;
end $$;
create trigger profiles_drop_rights after update of role on public.profiles
  for each row when (old.role = 'responsable' and new.role <> 'responsable')
  execute function public.profiles_drop_rights();

alter table public.profile_rights enable row level security;
revoke all on public.profile_rights from anon, authenticated;
grant select on public.profile_rights to authenticated;
create policy "acces: lecture" on public.profile_rights
  for select to authenticated
  using (profile_id = (select public.my_profile_id()) or (select public.is_gerant()));

revoke all on function public.can(text), public.set_rights(uuid, text[]), public.profiles_drop_rights() from public, anon, authenticated;
grant execute on function public.can(text) to anon, authenticated;
grant execute on function public.set_rights(uuid, text[]) to authenticated;

-- Les verrous « gérant seulement » des migrations 0001 à 0009 deviennent « gérant, ou responsable
-- qui a l'accès ». Le texte des fonctions et des règles est repris tel quel depuis la base, seul
-- is_gerant() y est remplacé par can('zone'). Si une fonction ou une règle attendue manque,
-- le script s'arrête et rien n'est changé.
do $$
declare
  old_path text := current_setting('search_path');
  f   record;
  def text;
  n   int := 0;
begin
  -- Sans chemin de recherche, la base rend le texte des règles avec le nom complet des fonctions.
  perform set_config('search_path', '', true);

  for f in
    select * from (values
      ('decide_leave', 'planning'), ('decide_swap', 'planning'),
      ('save_time_entry', 'pointages'),
      ('tick_item', 'checklists'), ('save_checklist', 'checklists'),
      ('cancel_order', 'stocks'),
      ('save_event', 'evenements'),
      ('save_recipe', 'fiches'),
      ('save_procedure', 'procedures')) as t (fn, area)
  loop
    select pg_get_functiondef(p.oid) into strict def
      from pg_catalog.pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.proname = f.fn;
    if position('public.is_gerant()' in def) = 0 then
      raise exception 'Fonction % : verrou du gérant introuvable.', f.fn;
    end if;
    execute replace(def, 'public.is_gerant()', format('public.can(%L)', f.area));
  end loop;

  for f in
    select pol.polname, c.relname, t.area,
           pg_get_expr(pol.polqual, pol.polrelid) as q,
           pg_get_expr(pol.polwithcheck, pol.polrelid) as w
    from (values
      ('shifts', 'planning'), ('leave_requests', 'planning'), ('shift_swaps', 'planning'),
      ('time_entries', 'pointages'), ('time_entry_audit', 'pointages'),
      ('checklists', 'checklists'),
      ('cold_units', 'hygiene'), ('temp_readings', 'hygiene'), ('trace_items', 'hygiene'), ('oil_logs', 'hygiene'),
      ('suppliers', 'stocks'), ('products', 'stocks'),
      ('booking_settings', 'reservations'), ('opening_hours', 'reservations'),
      ('customers', 'evenements'), ('events', 'evenements'), ('event_tasks', 'evenements'),
      ('recipes', 'fiches'),
      ('issues', 'maintenance'),
      ('procedures', 'procedures'), ('procedure_reads', 'procedures')) as t (tbl, area)
    join pg_catalog.pg_class c on c.relnamespace = 'public'::regnamespace and c.relname = t.tbl
    join pg_catalog.pg_policy pol on pol.polrelid = c.oid
    where coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') like '%is_gerant()%'
       or coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') like '%is_gerant()%'
  loop
    execute format('alter policy %I on public.%I', f.polname, f.relname)
      || coalesce(' using (' || regexp_replace(f.q, '(public\.)?is_gerant\(\)', format('public.can(%L)', f.area), 'g') || ')', '')
      || coalesce(' with check (' || regexp_replace(f.w, '(public\.)?is_gerant\(\)', format('public.can(%L)', f.area), 'g') || ')', '');
    n := n + 1;
  end loop;
  if n <> 30 then
    raise exception 'Règles de sécurité : % modifiées au lieu de 30. La base ne correspond pas aux migrations 0001 à 0009.', n;
  end if;

  perform set_config('search_path', old_path, true);
end $$;

-- Échéances : un responsable qui a l'accès « maintenance » tient les contrôles et les contrats,
-- jamais les documents personnels de l'équipe, qui restent au gérant.
drop policy "echeances: tout pour le gerant" on public.deadlines;
create policy "echeances: gestion" on public.deadlines
  for all to authenticated
  using ((select public.is_gerant()) or ((select public.can('maintenance')) and profile_id is null and category <> 'document'))
  with check ((select public.is_gerant()) or ((select public.can('maintenance')) and profile_id is null and category <> 'document'));
drop policy "echeances faites: lecture par le gerant" on public.deadline_done;
create policy "echeances faites: lecture" on public.deadline_done
  for select to authenticated
  using ((select public.is_gerant())
         or ((select public.can('maintenance')) and exists (select 1 from public.deadlines d where d.id = deadline_id)));

create or replace function public.complete_deadline(p_id uuid, p_done_on date, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  d   public.deadlines;
  day date := coalesce(p_done_on, (now() at time zone 'Europe/Paris')::date);
begin
  if not public.can('maintenance') then
    raise exception 'Réservé au gérant et aux responsables qui ont cet accès.' using errcode = '42501';
  end if;
  select * into d from public.deadlines where id = p_id and active for update;
  if not found then raise exception 'Échéance introuvable.' using errcode = 'P0001'; end if;
  if not public.is_gerant() and (d.profile_id is not null or d.category = 'document') then
    raise exception 'Réservé au gérant.' using errcode = '42501';
  end if;
  insert into public.deadline_done (deadline_id, done_on, done_by, note)
    values (p_id, day, public.my_profile_id(), btrim(coalesce(p_note, '')));
  if d.repeat_months is null then
    update public.deadlines set active = false where id = p_id;
  else
    update public.deadlines set due_date = (day + make_interval(months => d.repeat_months))::date where id = p_id;
  end if;
end $$;

-- Accueil : les échéances à venir s'affichent aussi au responsable qui a l'accès.
create or replace function public.today_tasks() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  d  date := public.service_day();
  sl text := public._slot();
  me uuid := public.my_profile_id();
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
    -- Échéances dans les 30 jours ou dépassées : pour le gérant, et pour le responsable qui a l'accès
    -- (sans les documents personnels de l'équipe).
    'deadlines_due', case when public.can('maintenance')
                          then (select count(*) from public.deadlines x
                                where x.active and x.due_date <= d + 30
                                  and (public.is_gerant() or (x.profile_id is null and x.category <> 'document'))) end);
end $$;

-- ---------- 2. Créneaux de réservation calés sur la cuisine ---------------------
-- Cuisine : 12 h – 14 h 30 et 19 h – 22 h 30 du mardi au jeudi, jusqu'à 23 h vendredi et samedi.
-- Dernière réservation 30 minutes avant la fermeture de la cuisine ; le dimanche, une heure avant
-- la fermeture. Seuls les jours restés sur les horaires d'origine sont changés.
update public.opening_hours set break_from = '14:30', break_to = '19:00'
  where weekday between 2 and 6 and first_slot = '12:00' and break_from is null
    and last_slot = case when weekday in (5, 6) then time '22:30' else time '22:00' end;
update public.opening_hours set last_slot = '15:00'
  where weekday = 7 and first_slot = '12:00' and last_slot = '14:00' and break_from is null;

-- ---------- 3. Dossier Drive de chaque personne ---------------------------------
-- Les documents de l'équipe restent dans le Drive du gérant : l'appli garde seulement le lien.
create table public.profile_folders (
  profile_id uuid primary key references public.profiles (id) on delete cascade,
  url        text not null check (url ~ '^https://[^\s]+$' and length(url) <= 500),
  updated_at timestamptz not null default now()
);
alter table public.profile_folders enable row level security;
revoke all on public.profile_folders from anon, authenticated;
grant select, insert, update, delete on public.profile_folders to authenticated;
create policy "dossiers: gerant" on public.profile_folders
  for all to authenticated using ((select public.is_gerant())) with check ((select public.is_gerant()));

-- ---------- 4. E-mails ------------------------------------------------------
-- L'envoi passe par pg_net (requêtes sortantes de la base) vers le service Brevo.
-- La clé de Brevo se range dans le coffre de Supabase sous le nom brevo_api_key : elle n'est
-- jamais dans l'appli ni dans ce dépôt.
do $$ begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_net indisponible ici : les e-mails ne partiront pas (%).', sqlerrm;
end $$;

create table public.email_settings (
  id              boolean primary key default true check (id),
  enabled         boolean not null default false,
  sender_name     text not null default 'La Nuba' check (length(btrim(sender_name)) > 0 and sender_name !~ '[\r\n]'),
  sender_email    text not null default '' check (sender_email = '' or sender_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  notify_email    text not null default '' check (notify_email = '' or notify_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  app_url         text not null default 'https://skanbls.github.io/SiteNuba/' check (app_url ~ '^https?://[^\s]+/$'),
  signature       text not null default 'L''équipe de la Nuba',
  confirm_booking boolean not null default true,
  notify_booking  boolean not null default true,
  notify_event    boolean not null default true
);
insert into public.email_settings default values;

create table public.email_outbox (
  id         bigint generated always as identity primary key,
  kind       text not null,
  to_email   text not null,
  subject    text not null,
  body       text not null,
  status     text not null default 'queued' check (status in ('queued', 'sent', 'accepted', 'failed')),
  request_id bigint,
  error      text not null default '',
  created_at timestamptz not null default now()
);
create index email_outbox_recent on public.email_outbox (created_at desc);

create function public._fr_day(d date) returns text
language sql immutable set search_path = '' as $$
  select (array['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'])[extract(isodow from d)::int]
    || ' ' || case when extract(day from d) = 1 then '1er' else extract(day from d)::int::text end
    || ' ' || (array['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août',
                     'septembre', 'octobre', 'novembre', 'décembre'])[extract(month from d)::int]
$$;

create function public._fr_time(t time) returns text
language sql immutable set search_path = '' as $$
  select extract(hour from t)::int::text || ' h' || case when extract(minute from t) > 0 then ' ' || to_char(t, 'MI') else '' end
$$;

-- Prépare un e-mail et le confie au service d'envoi. Renvoie vrai s'il est parti.
-- Ne lève jamais d'erreur : un e-mail qui échoue ne doit pas bloquer une réservation.
create function public._email_queue(p_kind text, p_to text, p_subject text, p_body text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  s     public.email_settings;
  v_id  bigint;
  v_key text;
  v_req bigint;
  v_err text := '';
begin
  select * into s from public.email_settings;
  if not s.enabled or s.sender_email = '' then return false; end if;
  if coalesce(p_to, '') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then return false; end if;

  delete from public.email_outbox where created_at < now() - interval '60 days';
  insert into public.email_outbox (kind, to_email, subject, body)
    values (p_kind, lower(p_to), left(regexp_replace(p_subject, '[\r\n]+', ' ', 'g'), 200), p_body)
    returning id into v_id;

  if (select count(*) from public.email_outbox where created_at > now() - interval '24 hours') > 250 then
    v_err := 'Plafond de 250 e-mails par jour atteint.';
  elsif to_regprocedure('net.http_post(text, jsonb, jsonb, jsonb, integer)') is null then
    v_err := 'L''extension pg_net n''est pas activée dans Supabase.';
  elsif to_regclass('vault.decrypted_secrets') is null then
    v_err := 'Le coffre (Vault) n''est pas activé dans Supabase.';
  else
    begin
      execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1' into v_key using 'brevo_api_key';
      if coalesce(btrim(v_key), '') = '' then
        v_err := 'La clé de Brevo n''est pas dans le coffre de Supabase (nom attendu : brevo_api_key).';
      else
        execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 10000)' into v_req
          using 'https://api.brevo.com/v3/smtp/email',
                jsonb_build_object(
                  'sender', jsonb_build_object('name', s.sender_name, 'email', s.sender_email),
                  'to', jsonb_build_array(jsonb_build_object('email', lower(p_to))),
                  'subject', left(regexp_replace(p_subject, '[\r\n]+', ' ', 'g'), 200),
                  'textContent', p_body),
                jsonb_build_object('api-key', btrim(v_key), 'Content-Type', 'application/json', 'Accept', 'application/json');
      end if;
    exception when others then
      v_err := left(sqlerrm, 300);
    end;
  end if;

  update public.email_outbox
    set status = case when v_err = '' then 'sent' else 'failed' end, request_id = v_req, error = v_err
    where id = v_id;
  return v_err = '';
exception when others then
  return false;
end $$;

-- Réserver en ligne : comme avant, avec en plus l'e-mail de confirmation au client.
-- Renvoie {ok:true, id, code, emailed} ou {ok:false, error}.
create or replace function public.book_table(p_day date, p_slot time, p_party int, p_name text, p_phone text, p_email text, p_note text, p_trap text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s      public.booking_settings;
  m      public.email_settings;
  v_id   uuid;
  v_code text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 20);
  tel    text := regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g');
  mail   text := lower(btrim(coalesce(p_email, '')));
  v_sent boolean := false;
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
    values (p_day, p_slot, p_party, btrim(p_name), tel, mail, left(btrim(coalesce(p_note, '')), 300),
            'en_ligne', sha256(convert_to(v_code, 'UTF8')))
    returning id into v_id;

  select * into m from public.email_settings;
  if m.confirm_booking and mail <> '' then
    v_sent := public._email_queue('reservation', mail,
      'Votre réservation à la Nuba, ' || public._fr_day(p_day) || ' à ' || public._fr_time(p_slot),
      'Bonjour ' || btrim(p_name) || ',' || E'\n\n'
      || 'Votre table est réservée à la Nuba :' || E'\n'
      || public._fr_day(p_day) || ' à ' || public._fr_time(p_slot) || ', pour ' || p_party || case when p_party > 1 then ' personnes.' else ' personne.' end || E'\n\n'
      || 'Pour consulter ou annuler votre réservation :' || E'\n'
      || m.app_url || '#/reservation?r=' || v_id || '&c=' || v_code || E'\n\n'
      || case when s.phone <> '' then 'Une question ? Appelez-nous au ' || s.phone || '.' || E'\n\n' else '' end
      || 'À bientôt,' || E'\n' || m.signature);
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'code', v_code, 'emailed', v_sent);
end $$;

-- Alerte à la Nuba pour une réservation en ligne ; e-mails d'annulation.
create function public._reservation_mail() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  m     public.email_settings;
  v_who text;
begin
  select * into m from public.email_settings;
  if not m.enabled then return null; end if;
  v_who := new.name || ', ' || public._fr_day(new.day) || ' à ' || public._fr_time(new.slot) || ', '
           || new.party || case when new.party > 1 then ' personnes' else ' personne' end;

  if tg_op = 'INSERT' then
    if new.source = 'en_ligne' and m.notify_booking then
      perform public._email_queue('alerte_reservation', m.notify_email, 'Réservation en ligne : ' || v_who,
        'Nouvelle réservation en ligne.' || E'\n\n' || v_who || E'\n'
        || 'Téléphone : ' || new.phone || E'\n'
        || case when new.email <> '' then 'E-mail : ' || new.email || E'\n' else '' end
        || case when new.note <> '' then 'Mot du client : ' || new.note || E'\n' else '' end
        || E'\n' || 'Toutes les réservations : ' || m.app_url || '#/reservations');
    end if;
  elsif new.status = 'cancelled' and old.status <> 'cancelled' and new.day >= (now() at time zone 'Europe/Paris')::date then
    if m.confirm_booking and new.email <> '' then
      perform public._email_queue('annulation', new.email, 'Votre réservation à la Nuba est annulée',
        'Bonjour ' || new.name || ',' || E'\n\n'
        || 'Votre réservation du ' || public._fr_day(new.day) || ' à ' || public._fr_time(new.slot) || ' est annulée.' || E'\n\n'
        || 'À bientôt,' || E'\n' || m.signature);
    end if;
    -- Sans personne de l'équipe derrière l'action, c'est le client qui a annulé avec son lien.
    if public.my_profile_id() is null and m.notify_booking then
      perform public._email_queue('alerte_annulation', m.notify_email, 'Annulation par le client : ' || v_who,
        'Le client a annulé sa réservation.' || E'\n\n' || v_who || E'\n' || 'Téléphone : ' || new.phone);
    end if;
  end if;
  return null;
exception when others then
  return null;
end $$;
create trigger reservations_mail_insert after insert on public.reservations
  for each row execute function public._reservation_mail();
create trigger reservations_mail_cancel after update of status on public.reservations
  for each row execute function public._reservation_mail();

-- Alerte à la Nuba pour une demande de privatisation ou de prestation envoyée en ligne.
create function public._event_mail() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  m public.email_settings;
  c public.customers;
begin
  select * into m from public.email_settings;
  if not m.enabled or not m.notify_event then return null; end if;
  select * into c from public.customers where id = new.customer_id;
  perform public._email_queue('alerte_evenement', m.notify_email,
    'Demande en ligne : ' || new.title || ', ' || public._fr_day(new.day),
    'Nouvelle demande envoyée depuis la page publique.' || E'\n\n'
    || new.title || E'\n'
    || 'Date : ' || public._fr_day(new.day) || E'\n'
    || case when new.guests is not null then 'Personnes : ' || new.guests || E'\n' else '' end
    || case when coalesce(c.company, '') <> '' then 'Société : ' || c.company || E'\n' else '' end
    || case when coalesce(c.phone, '') <> '' then 'Téléphone : ' || c.phone || E'\n' else '' end
    || case when coalesce(c.email, '') <> '' then 'E-mail : ' || c.email || E'\n' else '' end
    || case when new.note <> '' then E'\n' || new.note || E'\n' else '' end
    || E'\n' || 'À traiter ici : ' || m.app_url || '#/evenements');
  return null;
exception when others then
  return null;
end $$;
create trigger events_mail_insert after insert on public.events
  for each row when (new.source = 'en_ligne')
  execute function public._event_mail();

-- Les derniers e-mails et ce qu'ils sont devenus, pour le gérant.
create function public.email_log() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_gerant() then
    raise exception 'Réservé au gérant.' using errcode = '42501';
  end if;
  -- La réponse du service d'envoi arrive quelques secondes après : on la reporte ici.
  if to_regclass('net._http_response') is not null then
    begin
      execute $q$
        update public.email_outbox o
          set status = case when r.status_code between 200 and 299 then 'accepted' else 'failed' end,
              error = case when r.status_code between 200 and 299 then ''
                           else left(coalesce(nullif(r.error_msg, ''),
                                              'Réponse ' || coalesce(r.status_code::text, 'absente') || ' : ' || coalesce(r.content, '')), 300) end
          from net._http_response r
          where r.id = o.request_id and o.status = 'sent'
      $q$;
    exception when others then null;
    end;
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'kind', x.kind, 'to', x.to_email, 'subject', x.subject,
                                                       'status', x.status, 'error', x.error, 'at', x.created_at) order by x.id desc), '[]'::jsonb)
          from (select * from public.email_outbox order by id desc limit 20) x);
end $$;

-- E-mail d'essai, envoyé à l'adresse des alertes (ou à celle du gérant).
create function public.send_test_email() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s    public.email_settings;
  v_to text;
  v_ok boolean;
begin
  if not public.is_gerant() then
    raise exception 'Réservé au gérant.' using errcode = '42501';
  end if;
  select * into s from public.email_settings;
  if not s.enabled or s.sender_email = '' then
    raise exception 'Active d''abord l''envoi et indique l''adresse d''expédition, puis enregistre.' using errcode = 'P0001';
  end if;
  v_to := coalesce(nullif(s.notify_email, ''), (select email from public.profiles where id = public.my_profile_id()));
  v_ok := public._email_queue('essai', v_to, 'Essai des e-mails de Nuba Gestion',
    'Si tu lis ce message, l''appli sait envoyer des e-mails.' || E'\n\n' || s.signature);
  return jsonb_build_object('ok', v_ok, 'to', v_to,
    'error', case when v_ok then '' else coalesce((select error from public.email_outbox order by id desc limit 1), '') end);
end $$;

alter table public.email_settings enable row level security;
alter table public.email_outbox   enable row level security;
revoke all on public.email_settings, public.email_outbox from anon, authenticated;
grant select, update on public.email_settings to authenticated;
create policy "e-mails: lecture par le gerant" on public.email_settings
  for select to authenticated using ((select public.is_gerant()));
create policy "e-mails: modification par le gerant" on public.email_settings
  for update to authenticated using ((select public.is_gerant())) with check ((select public.is_gerant()));
-- email_outbox : aucun accès direct. Le gérant le lit par email_log().

revoke all on function
  public._fr_day(date), public._fr_time(time), public._email_queue(text, text, text, text),
  public._reservation_mail(), public._event_mail(), public.email_log(), public.send_test_email()
  from public, anon, authenticated;
grant execute on function public.email_log(), public.send_test_email() to authenticated;

commit;
