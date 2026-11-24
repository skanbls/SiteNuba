-- Tests de la migration 0024 : programmation du site. Données inventées, au format envoyé par le script Google.
\set ON_ERROR_STOP on
\set boss '''{"sub":"00000000-0000-0000-0000-000000000001"}'''
\set theo '''{"sub":"00000000-0000-0000-0000-000000000002"}'''
\set ines '''{"sub":"00000000-0000-0000-0000-000000000005"}'''
reset role;
reset request.headers;
delete from public.merc_sync_log;
create temp table t_site (k text, payload jsonb);
grant select, update on t_site to anon, authenticated;
insert into t_site (payload) select jsonb_build_object(
  'brand', 'site', 'file', 'Contenu du site (essai)',
  'programme', jsonb_build_array(
    jsonb_build_object('Date', to_char(current_date + 10, 'DD/MM/YYYY'), 'Type', 'DJ set', 'Titre', 'Nuit Essai', 'Description', 'Disco   et house.',
                       'Horaire', '22h → 2h', 'Entrée', 'Entrée libre', 'Visible', '', 'Affiche', 'https://drive.google.com/file/d/AfficheInventee123/view'),
    jsonb_build_object('Date', to_char(current_date + 12, 'YYYY-MM-DD'), 'Type', 'Concert', 'Titre', 'Live Essai', 'Horaire', 'dès 20h30', 'Visible', 'OUI', 'Affiche', 'javascript:alert(1)'),
    jsonb_build_object('Date', to_char(current_date + 13, 'DD/MM/YYYY'), 'Type', 'Quiz', 'Titre', 'Masquée', 'Visible', 'NON'),
    jsonb_build_object('Date', '', 'Type', 'Quiz', 'Titre', 'Sans date'),
    jsonb_build_object('Date', to_char(current_date + 11, 'DD/MM/YYYY'), 'Type', 'Expo', 'Titre', 'Rencontre Essai', 'Horaire', '18h30 → 20h30'),
    jsonb_build_object('Date', to_char(current_date + 10, 'DD/MM/YYYY'), 'Type', 'DJ set', 'Titre', 'Nuit Essai'),
    jsonb_build_object('Date', to_char(current_date - 5, 'DD/MM/YYYY'), 'Type', 'Quiz', 'Titre', 'Quiz passé', 'Horaire', '20h30')),
  'weekly', jsonb_build_array(
    jsonb_build_object('Jour', 'Jeudi', 'Rendez-vous', 'Quiz essai', 'Horaire', 'dès 20h30', 'Visible', 'OUI'),
    jsonb_build_object('Jour', 'Samedi', 'Rendez-vous', 'Caché', 'Horaire', '', 'Visible', 'NON'),
    jsonb_build_object('Jour', 'Tous les jours', 'Rendez-vous', 'Happy hour essai', 'Horaire', '18h – 20h')),
  'expo', jsonb_build_object('Afficher l''exposition', 'OUI', 'Titre', 'Expo Essai', 'Artiste', 'Artiste inventé, peintures', 'Présentation', 'Un texte.',
                             'Début', to_char(current_date - 3, 'DD/MM/YYYY'), 'Fin', to_char(current_date + 30, 'DD/MM/YYYY'), 'Accès', 'Entrée libre',
                             'Œuvres en vente', 'En vente au bar'),
  'works', jsonb_build_array(
    jsonb_build_object('Titre', 'Toile A', 'Technique', 'Acrylique', 'Dimensions', '80 × 60 cm', 'Image', 'https://exemple.fr/toile-a.jpg', 'Visible', ''),
    jsonb_build_object('Titre', 'Toile B', 'Technique', 'Pastel', 'Dimensions', '', 'Image', '', 'Visible', 'OUI'),
    jsonb_build_object('Titre', 'Toile cachée', 'Visible', 'NON')));

-- 0. Lecture des cellules
do $$ begin
  assert public._site_time('20h30 → 23h', 1) = '20:30' and public._site_time('20h30 → 23h', 2) = '23:00', 'deux heures dans un horaire';
  assert public._site_time('dès 21h', 1) = '21:00' and public._site_time('21:15 - 2:00', 2) = '02:00', 'autres écritures';
  assert public._site_time('25h', 1) is null and public._site_time('', 1) is null and public._site_time('Entrée libre', 1) is null, 'pas d''heure';
  assert public._site_weekday('Jeudi') = 4 and public._site_weekday(' dimanches ') = 7 and public._site_weekday('Tous les jours') is null, 'jours de la semaine';
  assert public._site_kind('DJ set') = 'soiree' and public._site_kind('Concert acoustique') = 'concert' and public._site_kind('Expo') = 'exposition'
     and public._site_kind('Soirée à thème') = 'soiree', 'types';
end $$;

-- 1. La clé, avec le lien du contenu du site : le gérant seul
set role authenticated;
set request.jwt.claims = :ines;
do $$ begin
  begin perform public.merc_new_key('', '', '', '', ''); raise exception 'TEST: une responsable a créé une clé';
  exception when insufficient_privilege then null; end;
end $$;
set request.jwt.claims = :boss;
update t_site set k = public.merc_new_key('', '', '', '', 'https://docs.google.com/spreadsheets/d/Site_Invente-123/edit');
do $$ begin
  assert (select sheet_url from public.merc_sources where brand = 'site') like 'https://docs.google.com/spreadsheets/d/Site_Invente-123%', 'lien du contenu du site enregistré';
end $$;

-- 2. Le script envoie le contenu du site
set role anon;
set request.jwt.claims = '';
do $$
declare r jsonb;
begin
  assert (public.sync_site('au_hasard', (select payload from t_site))) ->> 'error' = 'key', 'clé inventée refusée';
  assert (public.sync_site((select k from t_site), '{"brand": "nuba", "programme": []}')) ->> 'error' = 'brand', 'une autre source passe ailleurs';
  assert (public.sync_site((select k from t_site), '{"brand": "site", "programme": {}}')) ->> 'error' = 'payload', 'contenu illisible';
  r := public.sync_site((select k from t_site), (select payload from t_site));
  assert (r ->> 'ok')::boolean and (r -> 'counts' ->> 'events')::int = 4 and (r -> 'counts' ->> 'weekly')::int = 2
     and (r -> 'counts' ->> 'expo')::boolean and (r -> 'counts' ->> 'skipped')::int = 2, 'envoi accepté : ' || r::text;
  assert (select count(*) from public.events) = 0, 'le public ne lit pas les événements';
end $$;
reset role;
do $$
declare e public.events;
begin
  select * into strict e from public.events where title = 'Nuit Essai';
  assert e.kind = 'soiree' and e.category = 'DJ set' and e.day = current_date + 10 and e.start_time = '22:00' and e.schedule = '22h → 2h'
     and e.entry = 'Entrée libre' and e.details = 'Disco et house.' and e.status = 'confirme' and e.source = 'site'
     and e.poster_url = 'https://drive.google.com/file/d/AfficheInventee123/view', 'la soirée : ' || row_to_json(e)::text;
  assert (select count(*) from public.event_tasks where event_id = e.id) = 4, 'une liste de préparation de soirée';
  assert (select kind = 'concert' and start_time = '20:30' and poster_url = '' from public.events where title = 'Live Essai'), 'le concert, sans lien douteux';
  assert (select kind from public.events where title = 'Rencontre Essai') = 'exposition', 'la rencontre de l''exposition';
  assert not exists (select 1 from public.events where title in ('Masquée', 'Sans date')), 'ni ligne masquée ni ligne sans date';
  assert (select count(*) from public.events where title = 'Nuit Essai') = 1, 'pas de doublon';
  select * into strict e from public.events where title = 'Expo Essai';
  assert e.kind = 'exposition' and e.day = current_date - 3 and e.end_day = current_date + 30 and e.entry = 'Entrée libre'
     and e.details like 'Artiste inventé, peintures%Un texte.%Œuvres exposées :%Toile A, Acrylique, 80 × 60 cm%Toile B, Pastel%'
     and e.details not like '%cachée%' and e.poster_url = 'https://exemple.fr/toile-a.jpg', 'l''exposition : ' || row_to_json(e)::text;
  assert (select array_agg(title order by position) from public.site_weekly) = array['Quiz essai', 'Happy hour essai']
     and (select weekday from public.site_weekly where position = 1) = 4
     and (select weekday from public.site_weekly where position = 2) is null, 'les rendez-vous de la semaine';
  assert (select synced_at is not null and file_name = 'Contenu du site (essai)' from public.merc_sources where brand = 'site'), 'réception notée';
  assert (select message from public.merc_sync_log where brand = 'site' and ok order by id desc limit 1)
         like '4 soirée(s), 2 rendez-vous de la semaine, exposition « Expo Essai »%', 'journal';
end $$;

-- 3. L'équipe lit tout, avec son compte comme avec le code PIN ; elle coche la préparation
set role authenticated;
set request.jwt.claims = :theo;
do $$ begin
  assert (select count(*) from public.events where source = 'site') = 5, 'un équipier voit la programmation';
  assert (select count(*) from public.site_weekly) = 2, 'et les rendez-vous de la semaine';
  perform public.tick_event_task((select id from public.event_tasks where event_id = (select id from public.events where title = 'Rencontre Essai') order by position limit 1), true);
  begin insert into public.site_weekly (position, title) values (99, 'Pirate'); raise exception 'TEST: écriture directe';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
update public.events set status = 'annule' where title = 'Live Essai';

-- 4. Le fichier change : une soirée retirée, une autre renommée ; l'exposition est masquée
update t_site set payload = jsonb_set(jsonb_set(payload, '{programme}', jsonb_build_array(
    jsonb_build_object('Date', to_char(current_date + 12, 'YYYY-MM-DD'), 'Type', 'Concert', 'Titre', 'Live Essai', 'Horaire', 'dès 21h'),
    jsonb_build_object('Date', to_char(current_date + 11, 'DD/MM/YYYY'), 'Type', 'Expo', 'Titre', 'Rencontre Essai', 'Description', 'Nouveau texte'),
    jsonb_build_object('Date', to_char(current_date + 14, 'DD/MM/YYYY'), 'Type', 'Soirée à thème', 'Titre', 'Bal Essai'))),
  '{expo,Afficher l''exposition}', '"NON"');
set role anon;
do $$
declare r jsonb := public.sync_site((select k from t_site), (select payload from t_site));
begin
  assert (r ->> 'ok')::boolean and not (r -> 'counts' ->> 'expo')::boolean, 'second envoi : ' || r::text;
end $$;
reset role;
do $$ begin
  assert not exists (select 1 from public.events where title in ('Nuit Essai', 'Expo Essai')), 'retirées du fichier, à venir ou en cours : retirées de l''appli';
  assert exists (select 1 from public.events where title = 'Quiz passé'), 'une soirée passée reste dans l''historique';
  assert (select status = 'annule' and start_time = '21:00' from public.events where title = 'Live Essai'), 'l''annulation par l''équipe tient ; l''horaire suit le fichier';
  assert (select details = 'Nouveau texte' from public.events where title = 'Rencontre Essai'), 'la description suit le fichier';
  assert (select count(*) from public.event_tasks t join public.events e on e.id = t.event_id where e.title = 'Rencontre Essai' and t.done_at is not null) = 1,
    'la préparation cochée par l''équipe reste';
  assert exists (select 1 from public.events where title = 'Bal Essai' and kind = 'soiree'), 'nouvelle soirée';
  assert (select message from public.merc_sync_log where brand = 'site' and ok order by id desc limit 1) like '%2 retirée(s)%', 'journal des retraits';
end $$;

-- Remise en état
reset role;
delete from public.events where source = 'site';
delete from public.site_weekly where true;
delete from public.merc_sync_log where true;
update public.merc_sources set sheet_url = '', synced_at = null, file_name = '', counts = '{}' where brand = 'site';
update public.merc_sync set key_hash = null, created_at = null where id;
