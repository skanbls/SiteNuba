-- Tests de la migration 0008 (événements et fichier clients). Joués en dernier, sur la même base.
\set ON_ERROR_STOP on
\set boss  '''{"sub":"00000000-0000-0000-0000-000000000001"}'''
\set theo  '''{"sub":"00000000-0000-0000-0000-000000000002"}'''
\set intru '''{"sub":"00000000-0000-0000-0000-000000000003"}'''
reset role;
reset request.headers;

-- 1. Une demande arrive par la page publique
set role anon;
set request.jwt.claims = '';
do $$
declare r jsonb;
begin
  assert (public.request_private_event('privatisation', current_date + 30, 40, 'A', '', '0611223344', '', '', '')) ->> 'error' = 'contact', 'un nom est demandé';
  assert (public.request_private_event('privatisation', current_date + 30, 40, 'Nadia Benali', '', '06', '', '', '')) ->> 'error' = 'contact', 'un téléphone est demandé';
  assert (public.request_private_event('concert', current_date + 30, 40, 'Nadia Benali', '', '0611223344', '', '', '')) ->> 'error' = 'kind', 'seules privatisations et prestations extérieures se demandent en ligne';
  assert (public.request_private_event('privatisation', current_date - 1, 40, 'Nadia Benali', '', '0611223344', '', '', '')) ->> 'error' = 'day', 'pas de demande dans le passé';
  assert (public.request_private_event('privatisation', current_date + 30, 0, 'Nadia Benali', '', '0611223344', '', '', '')) ->> 'error' = 'guests', 'un nombre de personnes est demandé';
  assert (public.request_private_event('privatisation', current_date + 30, 40, 'Nadia Benali', '', '0611223344', '', '', 'robot')) ->> 'error' = 'contact', 'le champ piège arrête un robot';
  r := public.request_private_event('privatisation', current_date + 30, 40, ' Nadia Benali ', '', '06 11 22 33 44', ' Nadia@Exemple.fr ', 'Anniversaire, budget 30 € par personne', '');
  assert (r ->> 'ok')::boolean, 'la demande doit passer : ' || r::text;
  r := public.request_private_event('exterieur', current_date + 60, 80, 'Nadia Benali', 'Atelier Garonne', '0611223344', '', 'Cocktail d''entreprise', '');
  assert (r ->> 'ok')::boolean, 'seconde demande du même numéro';
  assert (select count(*) from public.events) = 0 and (select count(*) from public.customers) = 0, 'le public ne lit ni les événements ni les clients';
  begin perform public.save_customer(null, 'Pirate', 'particulier', '', '', '', ''); raise exception 'TEST: le public a créé une fiche client';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
  assert (select count(*) from public.customers) = 1, 'deux demandes du même téléphone : une seule fiche client';
  assert (select name = 'Nadia Benali' and phone = '0611223344' and email = 'nadia@exemple.fr' and kind = 'particulier' from public.customers), 'la fiche est nettoyée';
  assert (select count(*) from public.events where status = 'demande' and source = 'en_ligne' and customer_id is not null) = 2, 'les demandes arrivent rattachées au client';
  assert (select count(*) from public.event_tasks) = 10, 'chaque demande reçoit sa liste de préparation';
end $$;

-- 2. L'équipe consulte, note une demande, tient le fichier clients, coche la préparation
set role authenticated;
set request.jwt.claims = :theo;
do $$
declare me uuid := public.my_profile_id(); c uuid; e uuid; t uuid;
begin
  assert (select count(*) from public.events) = 2 and (select count(*) from public.customers) = 1, 'l''équipe lit événements et clients';
  c := public.save_customer(null, '  Trio Django ', 'artiste', '', '06 99 88 77 66', 'Trio@Exemple.fr', 'Jazz manouche');
  assert (select name = 'Trio Django' and kind = 'artiste' and email = 'trio@exemple.fr' and created_by = me from public.customers where id = c), 'l''équipe ajoute une fiche';
  perform public.save_customer(c, 'Trio Django', 'artiste', '', '0699887766', '', 'Jazz manouche, 3 musiciens');
  assert (select note from public.customers where id = c) = 'Jazz manouche, 3 musiciens', 'l''équipe modifie une fiche';
  begin perform public.save_customer(null, '  ', 'artiste', '', '', '', ''); raise exception 'TEST: une fiche sans nom a été acceptée';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
  update public.customers set active = false where id = c;
  assert (select active from public.customers where id = c), 'un équipier ne retire pas une fiche';

  e := public.request_event('concert', 'Concert du trio Django', current_date + 10, null, c, 'Rappeler pour la date');
  assert (select status = 'demande' and source = 'equipe' and created_by = me from public.events where id = e), 'l''équipe note une demande';
  begin perform public.save_event(e, jsonb_build_object('kind', 'concert', 'title', 'X', 'day', current_date + 10, 'status', 'confirme')); raise exception 'TEST: un équipier a confirmé un événement';
  exception when insufficient_privilege then null; end;
  delete from public.events;
  assert (select count(*) from public.events) = 3, 'un équipier ne supprime pas d''événement';
  select id into t from public.event_tasks where event_id = e order by position limit 1;
  perform public.tick_event_task(t, true);
  assert (select done_by = me and done_at is not null from public.event_tasks where id = t), 'la préparation cochée est signée';
  perform public.tick_event_task(t, false);
  assert (select done_by is null and done_at is null from public.event_tasks where id = t), 'on peut décocher';
  begin insert into public.event_tasks (event_id, label) values (e, 'Pirate'); raise exception 'TEST: un équipier a ajouté une tâche';
  exception when insufficient_privilege then null; end;
  assert ((public.today_tasks()) ->> 'event_requests')::int = 3, 'trois demandes attendent le gérant';
end $$;

-- 3. Le gérant chiffre, confirme, complète la préparation
set request.jwt.claims = :boss;
do $$
declare e uuid := (select id from public.events where kind = 'privatisation'); n uuid; d date := public.service_day();
begin
  perform public.save_event(e, jsonb_build_object('kind', 'privatisation', 'title', 'Anniversaire de Nadia', 'day', current_date + 30, 'start_time', '19:30',
    'guests', 40, 'status', 'acompte', 'customer_id', (select customer_id from public.events where id = e), 'amount', 1280, 'deposit', 384, 'deposit_paid', true,
    'details', 'Cocktail dînatoire, 32 € par personne', 'note', '2 végétariens'));
  assert (select title = 'Anniversaire de Nadia' and status = 'acompte' and amount = 1280 and deposit_paid and start_time = '19:30' and source = 'en_ligne' from public.events where id = e), 'le gérant chiffre et fait avancer la demande';
  insert into public.event_tasks (event_id, label, position) values (e, 'Gâteau apporté par le client : prévoir le frigo', 9);
  assert (select count(*) from public.event_tasks where event_id = e) = 6, 'le gérant complète la préparation';
  n := public.save_event(null, jsonb_build_object('kind', 'exposition', 'title', 'Lignes de nuit', 'day', d, 'end_day', d + 20, 'status', 'confirme', 'details', '3 artistes, commission de 20 %'));
  assert (select count(*) from public.event_tasks where event_id = n) = 4, 'un nouvel événement reçoit sa préparation type';
  begin perform public.save_event(null, jsonb_build_object('kind', 'mariage', 'title', 'X', 'day', d)); raise exception 'TEST: un type inconnu a été accepté';
  exception when check_violation then null; end;
  begin perform public.save_event(null, jsonb_build_object('kind', 'concert', 'title', 'X', 'day', d, 'end_day', d - 1)); raise exception 'TEST: une fin avant le début a été acceptée';
  exception when check_violation then null; end;
  assert jsonb_array_length((public.today_tasks()) -> 'events_today') = 1 and (public.today_tasks()) -> 'events_today' -> 0 ->> 'title' = 'Lignes de nuit', 'l''exposition en cours figure à l''accueil';
  update public.customers set active = false where name = 'Trio Django';
  assert not (select active from public.customers where name = 'Trio Django'), 'le gérant retire une fiche';
  delete from public.events where kind = 'exterieur';
  assert (select count(*) from public.events) = 3 and (select count(*) from public.event_tasks) = 15, 'supprimer un événement supprime sa préparation';
end $$;

-- 4. Un inconnu ne voit rien ; garde-fou contre les rafales
set request.jwt.claims = :intru;
do $$ begin
  assert (select count(*) from public.events) = 0 and (select count(*) from public.customers) = 0 and (select count(*) from public.event_tasks) = 0, 'un inconnu ne lit rien';
  begin perform public.request_event('concert', 'X', current_date, 1, null, ''); raise exception 'TEST: un inconnu a noté une demande';
  exception when insufficient_privilege then null; end;
end $$;
set role anon;
set request.jwt.claims = '';
do $$
declare r jsonb;
begin
  for i in 1..9 loop
    r := public.request_private_event('privatisation', current_date + 40, 20, 'Rafale ' || i, '', '07000001' || lpad(i::text, 2, '0'), '', '', '');
    assert (r ->> 'ok')::boolean, 'demande ' || i || ' : ' || r::text;
  end loop;
  assert (public.request_private_event('privatisation', current_date + 40, 20, 'De trop', '', '0799999998', '', '', '')) ->> 'error' = 'too_many', 'dix demandes en dix minutes déclenchent le garde-fou';
end $$;
reset role;
delete from public.events where title like '%Rafale%';
delete from public.customers where name like 'Rafale%';

-- 5. Sur l'iPad, par code PIN
set role authenticated;
set request.jwt.claims = :boss;
create temp table t_evt as select (public.add_kiosk((select id from public.sites limit 1), 'iPad événements')) ->> 'code' as v;
grant select, update on t_evt to anon, authenticated;
set role anon;
set request.jwt.claims = '';
do $$
declare
  tok text := (public.claim_kiosk((select v from t_evt))) ->> 'token';
  hugo uuid := (select (e ->> 'id')::uuid from jsonb_array_elements(public.kiosk_team(tok)) e where e ->> 'first_name' = 'Hugo');
begin
  update t_evt set v = (public.kiosk_login(tok, hugo, '8642')) ->> 'ticket';
end $$;
select set_config('request.headers', json_build_object('x-nuba-ticket', (select v from t_evt))::text, false) \gset ignore_
do $$
declare me uuid := public.my_profile_id(); t uuid;
begin
  assert (select count(*) from public.events) = 3 and (select count(*) from public.customers) = 2, 'la session à code PIN lit événements et clients';
  select id into t from public.event_tasks limit 1;
  perform public.tick_event_task(t, true);
  assert (select done_by = me from public.event_tasks where id = t), 'la session à code PIN coche la préparation';
  perform public.save_customer(null, 'Client du bar', 'particulier', '', '0612121212', '', '');
  perform public.request_event('privatisation', 'Pot de départ', current_date + 15, 25, null, '');
  begin perform public.save_event(null, jsonb_build_object('kind', 'concert', 'title', 'X', 'day', current_date)); raise exception 'TEST: une session à code PIN a créé un événement confirmé';
  exception when insufficient_privilege then null; end;
  begin delete from public.events; raise exception 'TEST: une session à code PIN a supprimé des événements';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
reset request.headers;
update public.kiosks set revoked_at = now() where revoked_at is null;
