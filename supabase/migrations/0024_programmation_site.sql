-- =====================================================================
-- Nuba Gestion · migration 0024 · programmation du site dans les événements
--
-- À exécuter une seule fois dans Supabase, après la 0023 :
--   SQL Editor > New query > coller tout ce fichier > Run.
-- Supabase doit répondre « Success. No rows returned ».
-- Tout passe ou rien ne passe : en cas d'erreur, la base reste comme avant.
--
-- Le fichier Google « Nuba · Contenu du site » (celui qui alimente le site web) arrive dans l'appli
-- par le même script Google que les mercuriales, toutes les dix minutes :
--   * Programmation : chaque soirée visible devient un événement (quiz, DJ set, soirée à thème,
--     concert, rencontre d'exposition…), avec son horaire, son entrée, sa description et son affiche ;
--   * Chaque semaine : les rendez-vous réguliers (quiz du jeudi…) ;
--   * Exposition et Œuvres : l'exposition en cours devient un événement sur plusieurs jours.
-- Le fichier reste la référence : une soirée retirée ou masquée (Visible = NON) disparaît de l'appli
-- tant qu'elle est à venir ; les soirées passées restent dans l'historique.
-- Dans l'appli, l'équipe garde la main sur le statut (une soirée annulée le reste), les notes et la liste de préparation.
-- =====================================================================
begin;

do $$ begin
  if to_regclass('public.events') is null or to_regclass('public.merc_sync') is null or to_regprocedure('public._mtext(jsonb, integer)') is null then
    raise exception 'Il manque une mise à jour plus ancienne. Exécute d''abord : 0008 (événements) et 0011 (production), puis relance celle-ci (0024).';
  end if;
end $$;

-- ---------- Le fichier « Contenu du site » rejoint les mercuriales ----------------------
alter table public.merc_sources drop constraint merc_sources_brand_check;
alter table public.merc_sources add constraint merc_sources_brand_check
  check (brand in ('saveurs_nomades', 'comptoir', 'nuba', 'site'));
insert into public.merc_sources (brand, label) values ('site', 'Contenu du site')
  on conflict (brand) do nothing;

-- ---------- Événements : soirées, détails du site, affiche -----------------------------
alter table public.events drop constraint events_kind_check;
alter table public.events add constraint events_kind_check
  check (kind in ('privatisation', 'soiree', 'concert', 'exposition', 'exterieur'));
alter table public.events drop constraint events_source_check;
alter table public.events add constraint events_source_check
  check (source in ('equipe', 'en_ligne', 'site'));
alter table public.events
  add column category     text not null default '' check (length(category) <= 60),
  add column schedule     text not null default '' check (length(schedule) <= 80),
  add column entry        text not null default '' check (length(entry) <= 80),
  add column poster_url   text not null default '' check (poster_url = '' or (poster_url ~ '^https://' and length(poster_url) <= 1000)),
  add column external_key text unique check (external_key is null or length(external_key) <= 400);

-- Une liste de préparation pour les soirées, comme pour les autres types.
create or replace function public._seed_event_tasks(p_event uuid, p_kind text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  labels text[] := case p_kind
    when 'privatisation' then array['Devis signé', 'Acompte encaissé', 'Menu validé avec la cuisine', 'Plan de salle envoyé au client', 'Équipe prévue au planning']
    when 'soiree' then array['Animateur ou DJ confirmé', 'Annonce publiée', 'Son et lumière vérifiés', 'Équipe prévue au planning']
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

-- ---------- Rendez-vous de chaque semaine (onglet « Chaque semaine ») ------------------
create table public.site_weekly (
  position  int primary key,
  weekday   smallint check (weekday is null or weekday between 1 and 7),
  day_label text not null default '',
  title     text not null check (length(btrim(title)) > 0),
  schedule  text not null default ''
);
alter table public.site_weekly enable row level security;
revoke all on public.site_weekly from anon, authenticated;
grant select on public.site_weekly to anon, authenticated;
create policy "rendez-vous de la semaine: lecture" on public.site_weekly
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);

-- ---------- Lecture des cellules ------------------------------------------------------
-- Le jour de la semaine écrit en toutes lettres (« Jeudi », « jeudis ») : 1 = lundi … 7 = dimanche.
create function public._site_weekday(t text) returns smallint
language sql immutable set search_path = '' as $$
  select case
    when u like 'lun%' then 1 when u like 'mar%' then 2 when u like 'mer%' then 3 when u like 'jeu%' then 4
    when u like 'ven%' then 5 when u like 'sam%' then 6 when u like 'dim%' then 7 end::smallint
  from (select lower(btrim(coalesce(t, ''))) as u) x
$$;

-- Heures écrites dans un horaire (« 20h30 → 23h », « dès 20h30 », « 21:00 - 2:00 ») : la n-ième, ou null.
create function public._site_time(t text, n int) returns time
language plpgsql immutable set search_path = '' as $$
declare m text[];
begin
  select r into m from (
    select regexp_matches(coalesce(t, ''), '(\d{1,2})\s*[hH:]\s*(\d{2})?', 'g') as r
  ) x offset greatest(n, 1) - 1 limit 1;
  if m is null or m[1]::int > 23 or coalesce(m[2], '00')::int > 59 then return null; end if;
  return make_time(m[1]::int, coalesce(m[2], '00')::int, 0);
exception when others then
  return null;
end $$;

-- Une affiche : un lien https. Un lien de partage Google Drive est gardé tel quel ; l'appli l'affiche.
create function public._site_url(v jsonb) returns text
language sql immutable set search_path = '' as $$
  select case when u ~ '^https://\S+$' and length(u) <= 1000 then u else '' end
  from (select btrim(coalesce(v #>> '{}', '')) as u) x
$$;

-- Une ligne visible ? « NON » (ou « non », « Non ») la masque ; vide ou « OUI » l'affiche.
create function public._site_visible(v jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select upper(btrim(coalesce(v #>> '{}', ''))) not in ('NON', 'N', 'NO', 'FAUX', 'FALSE')
$$;

-- Type de l'appli à partir du type écrit dans la Programmation.
create function public._site_kind(t text) returns text
language sql immutable set search_path = '' as $$
  select case
    when u ~ '(expo|vernissage)' then 'exposition'
    when u ~ '(concert|live)' then 'concert'
    when u ~ 'privati' then 'privatisation'
    else 'soiree' end
  from (select lower(coalesce(t, '')) as u) x
$$;

-- ---------- Réception du contenu du site -----------------------------------------------
-- Appelée par le script Google, avec la clé des mercuriales. p_payload :
--   { brand: 'site', file, programme: [{Date, Type, Titre, Description, Horaire, Entrée, Visible, Affiche}],
--     weekly: [{Jour, Rendez-vous, Horaire, Visible}], expo: {Champ: valeur en français}, works: [{Titre, Technique, Dimensions, Image, Visible}] }
create function public.sync_site(p_key text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s       public.merc_sync;
  r       jsonb;
  today   date := (now() at time zone 'Europe/Paris')::date;
  keys    text[] := '{}';
  v_key   text;
  v_day   date;
  v_title text;
  v_type  text;
  v_kind  text;
  v_id    uuid;
  v_new   boolean;
  n_prog  int := 0;
  n_week  int := 0;
  n_skip  int := 0;
  n_gone  int := 0;
  x       jsonb;
  e_title text;
  e_from  date;
  e_to    date;
  e_works text := '';
  e_poster text := '';
  c       jsonb;
begin
  select * into s from public.merc_sync;
  if s.key_hash is null or coalesce(p_key, '') = '' or sha256(convert_to(p_key, 'UTF8')) <> s.key_hash then
    if (select count(*) from public.merc_sync_log where not ok and at > now() - interval '1 hour') < 50 then
      insert into public.merc_sync_log (brand, ok, message) values ('site', false, 'Clé refusée');
    end if;
    return jsonb_build_object('ok', false, 'error', 'key');
  end if;
  if (select count(*) from public.merc_sync_log where ok and at > now() - interval '10 minutes') >= 30 then
    return jsonb_build_object('ok', false, 'error', 'too_many');
  end if;
  if p_payload ->> 'brand' is distinct from 'site' then
    return jsonb_build_object('ok', false, 'error', 'brand');
  end if;
  if coalesce(jsonb_typeof(p_payload -> 'programme'), '') <> 'array' or jsonb_array_length(p_payload -> 'programme') > 600
     or coalesce(jsonb_typeof(coalesce(p_payload -> 'weekly', '[]')), '') <> 'array' or jsonb_array_length(coalesce(p_payload -> 'weekly', '[]')) > 60
     or coalesce(jsonb_typeof(coalesce(p_payload -> 'works', '[]')), '') <> 'array' or jsonb_array_length(coalesce(p_payload -> 'works', '[]')) > 300
     or coalesce(jsonb_typeof(coalesce(p_payload -> 'expo', '{}')), '') <> 'object'
     or octet_length(p_payload::text) > 900000 then
    return jsonb_build_object('ok', false, 'error', 'payload');
  end if;

  begin
    -- Programmation : une soirée par ligne visible, retrouvée par sa date et son titre.
    for r in select value from jsonb_array_elements(p_payload -> 'programme') loop
      v_day := public._mdate(r -> 'Date');
      v_title := public._mtext(r -> 'Titre', 100);
      if not public._site_visible(r -> 'Visible') then continue; end if;
      if v_day is null or v_title = '' then n_skip := n_skip + 1; continue; end if;
      v_type := public._mtext(r -> 'Type', 60);
      v_kind := public._site_kind(v_type);
      v_key := 'prog:' || v_day || ':' || lower(v_title);
      if v_key = any (keys) then n_skip := n_skip + 1; continue; end if;
      keys := keys || v_key;
      v_new := not exists (select 1 from public.events where external_key = v_key);
      insert into public.events (kind, title, day, start_time, status, details, source, category, schedule, entry, poster_url, external_key)
        values (v_kind, v_title, v_day, public._site_time(public._mtext(r -> 'Horaire', 80), 1), 'confirme',
                public._mtext(r -> 'Description', 2000), 'site', v_type, public._mtext(r -> 'Horaire', 80),
                public._mtext(r -> 'Entrée', 80), public._site_url(r -> 'Affiche'), v_key)
        on conflict (external_key) do update
          set kind = excluded.kind, title = excluded.title, day = excluded.day, start_time = excluded.start_time,
              details = excluded.details, category = excluded.category, schedule = excluded.schedule,
              entry = excluded.entry, poster_url = excluded.poster_url
        returning id into v_id;
      if v_new then perform public._seed_event_tasks(v_id, v_kind); end if;
      n_prog := n_prog + 1;
    end loop;

    -- Exposition en cours : un événement sur plusieurs jours, avec la liste des œuvres visibles.
    x := coalesce(p_payload -> 'expo', '{}');
    e_title := public._mtext(x -> 'Titre', 100);
    e_from := public._mdate(x -> 'Début');
    e_to := public._mdate(x -> 'Fin');
    if upper(public._mtext(x -> 'Afficher l''exposition', 10)) = 'OUI' and e_title <> '' and e_from is not null then
      for r in select value from jsonb_array_elements(coalesce(p_payload -> 'works', '[]')) loop
        if not public._site_visible(r -> 'Visible') or public._mtext(r -> 'Titre', 100) = '' then continue; end if;
        e_works := e_works || E'\n• ' || public._mtext(r -> 'Titre', 100)
                   || coalesce(nullif(', ' || public._mtext(r -> 'Technique', 100), ', '), '')
                   || coalesce(nullif(', ' || public._mtext(r -> 'Dimensions', 40), ', '), '');
        if e_poster = '' then e_poster := public._site_url(r -> 'Image'); end if;
      end loop;
      e_poster := coalesce(nullif(public._site_url(x -> 'Affiche'), ''), e_poster);
      v_key := 'expo:' || e_from || ':' || lower(e_title);
      keys := keys || v_key;
      v_new := not exists (select 1 from public.events where external_key = v_key);
      insert into public.events (kind, title, day, end_day, status, details, source, category, schedule, entry, poster_url, external_key)
        values ('exposition', e_title, e_from, case when e_to >= e_from then e_to end, 'confirme',
                left(concat_ws(E'\n\n',
                  nullif(public._mtext(x -> 'Artiste', 200), ''),
                  nullif(public._mtext(x -> 'Présentation', 1500), ''),
                  nullif(public._mtext(x -> 'Œuvres en vente', 200), ''),
                  nullif('Œuvres exposées :' || e_works, 'Œuvres exposées :')), 2000),
                'site', 'Exposition', '', public._mtext(x -> 'Accès', 80), e_poster, v_key)
        on conflict (external_key) do update
          set title = excluded.title, day = excluded.day, end_day = excluded.end_day, details = excluded.details,
              entry = excluded.entry, poster_url = excluded.poster_url
        returning id into v_id;
      if v_new then perform public._seed_event_tasks(v_id, 'exposition'); end if;
    end if;

    -- Ce qui n'est plus dans le fichier (ou masqué) et pas encore passé disparaît ; l'historique reste.
    delete from public.events
      where source = 'site' and external_key <> all (keys) and coalesce(end_day, day) >= today;
    get diagnostics n_gone = row_count;

    -- Chaque semaine : remplacé en entier.
    delete from public.site_weekly where true;
    for r in select value from jsonb_array_elements(coalesce(p_payload -> 'weekly', '[]')) loop
      if not public._site_visible(r -> 'Visible') or public._mtext(r -> 'Rendez-vous', 100) = '' then continue; end if;
      n_week := n_week + 1;
      insert into public.site_weekly (position, weekday, day_label, title, schedule)
        values (n_week, public._site_weekday(public._mtext(r -> 'Jour', 30)), public._mtext(r -> 'Jour', 30),
                public._mtext(r -> 'Rendez-vous', 100), public._mtext(r -> 'Horaire', 80));
    end loop;

    c := jsonb_build_object('events', n_prog, 'weekly', n_week, 'expo', e_title <> '' and e_from is not null
                            and upper(public._mtext(x -> 'Afficher l''exposition', 10)) = 'OUI', 'skipped', n_skip);
    update public.merc_sources
      set synced_at = now(), file_name = public._mtext(p_payload -> 'file', 120), counts = c
      where brand = 'site';
    delete from public.merc_sync_log where at < now() - interval '30 days';
    insert into public.merc_sync_log (brand, ok, message)
      values ('site', true, n_prog || ' soirée(s), ' || n_week || ' rendez-vous de la semaine'
                            || case when (c ->> 'expo')::boolean then ', exposition « ' || e_title || ' »' else '' end
                            || case when n_gone > 0 then ' · ' || n_gone || ' retirée(s)' else '' end
                            || case when n_skip > 0 then ' · ' || n_skip || ' ligne(s) sans date ou sans titre ignorée(s)' else '' end);
    return jsonb_build_object('ok', true, 'counts', c);
  exception when others then
    insert into public.merc_sync_log (brand, ok, message) values ('site', false, left('Envoi refusé par la base : ' || sqlerrm, 300));
    return jsonb_build_object('ok', false, 'error', 'db', 'message', sqlerrm);
  end;
end $$;

-- ---------- Nouvelle clé, avec le lien du contenu du site --------------------------------
create function public.merc_new_key(p_sn_url text, p_cm_url text, p_nuba_url text, p_dashboard_url text, p_site_url text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_key text;
begin
  if not public.is_gerant() then
    raise exception 'Réservé au gérant.' using errcode = '42501';
  end if;
  v_key := public.merc_new_key(p_sn_url, p_cm_url, p_nuba_url, p_dashboard_url);
  update public.merc_sources set sheet_url = btrim(coalesce(p_site_url, '')) where brand = 'site';
  return v_key;
end $$;

-- ---------- Droits ------------------------------------------------------------------------
revoke all on function public._site_weekday(text), public._site_time(text, int), public._site_url(jsonb),
  public._site_visible(jsonb), public._site_kind(text), public.sync_site(text, jsonb),
  public.merc_new_key(text, text, text, text, text)
  from public, anon, authenticated;
-- Le script Google appelle avec la clé publique de l'appli (rôle anon), puis la clé de synchronisation.
grant execute on function public.sync_site(text, jsonb) to anon, authenticated;
grant execute on function public.merc_new_key(text, text, text, text, text) to authenticated;

commit;
