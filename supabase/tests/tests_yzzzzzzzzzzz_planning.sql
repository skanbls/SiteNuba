-- Tests de la migration 0027 : planning depuis le fichier, changements annoncés. Données inventées.
\set ON_ERROR_STOP on
\set boss '''{"sub":"00000000-0000-0000-0000-000000000001"}'''
\set theo '''{"sub":"00000000-0000-0000-0000-000000000002"}'''
\set ines '''{"sub":"00000000-0000-0000-0000-000000000005"}'''
reset role;
reset request.headers;
update public.profiles set active = true where email in ('theo@nuba.fr', 'ines@nuba.fr');
delete from public.shifts where true;
delete from public.shift_changes where true;
delete from public.leave_requests where true;
update public.merc_sync set key_hash = sha256(convert_to('cle_planning', 'UTF8')), created_at = now() where id;
update public.email_settings set enabled = true, sender_email = 'appli@nuba.fr', notify_planning = true where true;
delete from public.email_outbox where kind = 'planning';
create temp table t_plan as select public.service_day() + 2 as d, null::uuid as theo, null::uuid as ines;
grant select on t_plan to anon, authenticated;
update t_plan set theo = (select id from public.profiles where email = 'theo@nuba.fr'), ines = (select id from public.profiles where email = 'ines@nuba.fr');

-- 0. Les noms
do $$ begin
  assert public._name_key('Margo SALVA (apprentie)') = 'margo salva' and public._name_key('Luce CAMUS--MIZZI') = 'luce camus mizzi'
     and public._name_key(' Inès  Durand ') = 'ines durand', 'noms réduits';
  assert public._profile_by_name('Théo MARTIN (serveur)') = (select theo from t_plan), 'nom complet';
  assert public._profile_by_name('INES') = (select ines from t_plan), 'prénom seul, unique';
  assert public._profile_by_name('Commis soir (Hayder ou remplaçant)') is null, 'inconnu';
end $$;

-- 1. Le script envoie le planning
set role anon;
set request.jwt.claims = '';
do $$
declare
  d date := (select d from t_plan);
  r jsonb;
begin
  assert public.sync_planning('mauvaise', '{}') ->> 'error' = 'key', 'clé refusée';
  assert public.sync_planning('cle_planning', '{"brand": "planning", "from": "2026-01-01", "to": "2025-01-01", "shifts": []}') ->> 'error' = 'payload', 'période impossible';
  r := public.sync_planning('cle_planning', jsonb_build_object('brand', 'planning', 'from', d, 'to', d + 6, 'shifts', jsonb_build_array(
    jsonb_build_object('name', 'Théo MARTIN', 'day', d, 'start', '10:00', 'end', '14:00', 'area', 'Salle', 'note', ''),
    jsonb_build_object('name', 'Théo MARTIN', 'day', d, 'start', '18:30', 'end', '00:30', 'area', 'Salle', 'note', 'pause 30 min'),
    jsonb_build_object('name', 'Inès DURAND (responsable)', 'day', d + 1, 'start', '17:00', 'end', '23:00', 'area', 'Bar', 'note', ''),
    jsonb_build_object('name', 'Inès DURAND (responsable)', 'day', d + 2, 'start', '17:00', 'end', '23:00', 'area', 'Bar', 'note', ''),
    jsonb_build_object('name', 'Commis soir (Hayder ou remplaçant)', 'day', d, 'start', '18:00', 'end', '23:00', 'area', 'Cuisine', 'note', ''),
    jsonb_build_object('name', 'Théo MARTIN', 'day', d + 30, 'start', '10:00', 'end', '14:00', 'area', 'Salle', 'note', ''))));
  assert (r ->> 'ok')::boolean and (r -> 'counts' ->> 'added')::int = 4 and (r -> 'counts' ->> 'problems')::int = 1, 'premier envoi : ' || r::text;
end $$;
reset role;
do $$
declare d date := (select d from t_plan);
begin
  assert (select count(*) from public.shifts where source = 'sheet') = 4, 'quatre services, rien hors période';
  assert (select ends_at - starts_at from public.shifts where profile_id = (select theo from t_plan) and note = 'pause 30 min') = interval '6 hours', 'le soir passe minuit';
  assert (select problems ->> 0 from public.planning_sync) like 'Pas dans l''équipe de l''appli : Commis soir%', 'le nom inconnu est signalé';
  assert (select count(*) from public.shift_changes where kind = 'added') = 4, 'quatre ajouts à annoncer';
end $$;

-- 2. Un service ajouté dans l'appli qui chevauche ; un congé ; un second envoi qui change, retire et garde
insert into public.shifts (profile_id, starts_at, ends_at, area)
  select ines, ((d + 3) + time '16:00') at time zone 'Europe/Paris', ((d + 3) + time '20:00') at time zone 'Europe/Paris', 'Bar' from t_plan;
insert into public.leave_requests (profile_id, start_date, end_date, status) select theo, d + 4, d + 4, 'approved' from t_plan;
set role anon;
do $$
declare
  d date := (select d from t_plan);
  r jsonb;
begin
  r := public.sync_planning('cle_planning', jsonb_build_object('brand', 'planning', 'from', d, 'to', d + 6, 'shifts', jsonb_build_array(
    jsonb_build_object('name', 'Théo MARTIN', 'day', d, 'start', '10:00', 'end', '14:00', 'area', 'Bar', 'note', ''),
    jsonb_build_object('name', 'Inès DURAND', 'day', d + 1, 'start', '17:00', 'end', '23:00', 'area', 'Bar', 'note', ''),
    jsonb_build_object('name', 'Inès DURAND', 'day', d + 3, 'start', '18:00', 'end', '23:00', 'area', 'Bar', 'note', ''),
    jsonb_build_object('name', 'Théo MARTIN', 'day', d + 4, 'start', '10:00', 'end', '14:00', 'area', 'Salle', 'note', ''))));
  assert (r -> 'counts' ->> 'added')::int = 0 and (r -> 'counts' ->> 'updated')::int = 1 and (r -> 'counts' ->> 'removed')::int = 2
     and (r -> 'counts' ->> 'problems')::int = 1, 'second envoi : ' || r::text;
end $$;
reset role;
do $$ begin
  assert (select area from public.shifts where source = 'sheet' and profile_id = (select theo from t_plan)) = 'Bar', 'le poste suit le fichier';
  assert (select count(*) from public.shifts where profile_id = (select ines from t_plan) and source = 'app') = 1, 'le service de l''appli reste';
  assert (select problems ->> 0 from public.planning_sync) like '%déjà un service%', 'le chevauchement est signalé';
  assert (select counts ->> 'on_leave' from public.planning_sync) = '1', 'pas de service un jour de congé';
  assert (select count(*) from public.shift_changes where kind = 'removed') = 2 and (select count(*) from public.shift_changes where kind = 'changed') = 1,
    'retraits et changement annoncés';
  assert not exists (select 1 from public.planning_skips), 'les retraits du fichier ne sont pas des retraits de l''équipe';
end $$;

-- 3. Modifié dans l'appli : il devient un service de l'appli
set role authenticated;
set request.jwt.claims = :boss;
update public.shifts set starts_at = starts_at + interval '30 minutes' where source = 'sheet' and profile_id = (select theo from t_plan);
reset role;
do $$ begin
  assert (select source = 'app' and sheet_key is null from public.shifts where profile_id = (select theo from t_plan) and area = 'Bar'), 'détaché du fichier';
end $$;
-- Supprimé dans l'appli : le service d'Inès du fichier.
set role authenticated;
set request.jwt.claims = :boss;
delete from public.shifts where source = 'sheet' and profile_id = (select ines from t_plan);
-- Le fichier n'a pas changé : ni l'un ni l'autre ne revient.
set role anon;
set request.jwt.claims = '';
do $$
declare
  d date := (select d from t_plan);
  r jsonb;
begin
  r := public.sync_planning('cle_planning', jsonb_build_object('brand', 'planning', 'from', d, 'to', d + 6, 'shifts', jsonb_build_array(
    jsonb_build_object('name', 'Théo MARTIN', 'day', d, 'start', '10:00', 'end', '14:00', 'area', 'Bar', 'note', ''),
    jsonb_build_object('name', 'Inès DURAND', 'day', d + 1, 'start', '17:00', 'end', '23:00', 'area', 'Bar', 'note', ''))));
  assert (r -> 'counts' ->> 'added')::int = 0 and (r -> 'counts' ->> 'removed')::int = 0, 'l''appli garde la main : ' || r::text;
end $$;
reset role;
do $$ begin
  assert (select count(*) from public.shifts where profile_id = (select theo from t_plan) and ((starts_at at time zone 'Europe/Paris') - interval '5 hours')::date = (select d from t_plan)) = 1,
    'Théo : seulement le service déplacé';
  assert not exists (select 1 from public.shifts where profile_id = (select ines from t_plan) and source = 'sheet'), 'Inès : pas recréé';
  assert (select count(*) from public.planning_skips) = 2, 'deux lignes du fichier laissées à l''appli';
end $$;
-- La ligne change dans le fichier : c'est un nouveau service.
set role anon;
do $$
declare d date := (select d from t_plan);
begin
  assert (public.sync_planning('cle_planning', jsonb_build_object('brand', 'planning', 'from', d, 'to', d + 6, 'shifts', jsonb_build_array(
    jsonb_build_object('name', 'Inès DURAND', 'day', d + 1, 'start', '17:30', 'end', '23:00', 'area', 'Bar', 'note', '')))) -> 'counts' ->> 'added')::int = 1,
    'nouvel horaire, nouveau service';
end $$;

-- 4. Chacun voit ses changements, et les marque vus
set role authenticated;
set request.jwt.claims = :theo;
do $$ begin
  assert (select count(*) from public.shift_changes) > 0 and not exists (select 1 from public.shift_changes where profile_id <> (select theo from t_plan)),
    'Théo voit les siens, rien que les siens';
  perform public.ack_shift_changes();
  assert not exists (select 1 from public.shift_changes where seen_at is null), 'vus';
end $$;

-- 5. L'e-mail récapitulatif, cinq minutes après le dernier changement
reset role;
do $$
declare n int;
begin
  assert public.send_shift_notices(now()) = 0, 'pas tout de suite';
  n := public.send_shift_notices(now() + interval '6 minutes');
  assert n = 2, 'Théo et Inès : ' || n;
  assert (select count(*) from public.email_outbox where kind = 'planning' and to_email = 'theo@nuba.fr'
          and subject like 'Ton planning a changé (%' and body like '%+ Ajouté : %' and body like '%~ Modifié : %(avant : %'
          -- Le service du soir, ajouté puis retiré avant l'e-mail, n'est pas annoncé.
          and body not like '%Retiré%' and body not like '%18 h 30%') = 1,
    'Théo : ' || coalesce((select body from public.email_outbox where kind = 'planning' and to_email = 'theo@nuba.fr'), 'rien');
  assert public.send_shift_notices(now() + interval '20 minutes') = 0, 'une seule fois';
  -- Coupé dans les réglages : marqués, sans e-mail.
  update public.email_settings set notify_planning = false where true;
  insert into public.shifts (profile_id, starts_at, ends_at) select theo, ((d + 5) + time '10:00') at time zone 'Europe/Paris', ((d + 5) + time '12:00') at time zone 'Europe/Paris' from t_plan;
  n := public.send_shift_notices(now() + interval '30 minutes');
  assert n = 0 and not exists (select 1 from public.shift_changes where emailed_at is null),
    'sans e-mail : ' || n || ' ' || coalesce((select string_agg(kind || ' ' || created_at || ' ' || profile_id, ' | ') from public.shift_changes where emailed_at is null), '');
end $$;

-- Un service ajouté puis retiré avant l'e-mail : rien à annoncer.
reset role;
update public.email_settings set notify_planning = true where true;
insert into public.shifts (profile_id, starts_at, ends_at)
  select ines, ((d + 5) + time '18:00') at time zone 'Europe/Paris', ((d + 5) + time '20:00') at time zone 'Europe/Paris' from t_plan;
delete from public.shifts where profile_id = (select ines from t_plan) and starts_at = (((select d from t_plan) + 5) + time '18:00') at time zone 'Europe/Paris';
do $$
declare before int := (select count(*) from public.email_outbox where kind = 'planning' and to_email = 'ines@nuba.fr');
begin
  assert (select count(*) from public.shift_changes where emailed_at is null and profile_id = (select ines from t_plan)) = 2, 'ajout et retrait notés';
  perform public.send_shift_notices(now() + interval '40 minutes');
  assert (select count(*) from public.email_outbox where kind = 'planning' and to_email = 'ines@nuba.fr') = before, 'ajouté puis retiré : pas d''e-mail';
  assert not exists (select 1 from public.shift_changes where emailed_at is null), 'marqués quand même';
end $$;

-- Remise en état
reset role;
delete from public.shifts where true;
delete from public.shift_changes where true;
delete from public.leave_requests where true;
delete from public.planning_skips where true;
delete from public.email_outbox where kind = 'planning';
update public.planning_sync set synced_at = null, counts = '{}', problems = '[]' where id;
update public.merc_sync set key_hash = null, created_at = null where id;
update public.email_settings set enabled = false, sender_email = '', notify_planning = true where true;
