-- Tests de la migration 0010 (accès délégués, dossiers Drive, e-mails). Joués en dernier.
\set ON_ERROR_STOP on
\set boss  '''{"sub":"00000000-0000-0000-0000-000000000001"}'''
\set theo  '''{"sub":"00000000-0000-0000-0000-000000000002"}'''
\set ines  '''{"sub":"00000000-0000-0000-0000-000000000005"}'''
reset role;
reset request.headers;
-- Les réservations et demandes en ligne des tests précédents ne doivent pas déclencher les garde-fous de rafale.
update public.reservations set created_at = created_at - interval '1 hour' where source = 'en_ligne';
update public.events set created_at = created_at - interval '1 hour' where source = 'en_ligne';
create temp table t_adm as
  select (current_date + ((9 - extract(isodow from current_date)::int) % 7) + 7)::date as d_tue,
         null::uuid as id, null::text as code, null::text as v;
grant select, update on t_adm to anon, authenticated;

-- 1. Sans accès, une responsable ne modifie rien
set role authenticated;
set request.jwt.claims = :ines;
do $$
declare me public.profiles;
begin
  select * into me from public.me();
  assert me.role = 'responsable', 'Inès est responsable';
  assert not public.can('checklists') and not public.can('stocks'), 'aucun accès au départ';
  begin perform public.save_checklist(null, 'Pirate', 'service', 'daily', '[]'); raise exception 'TEST: une responsable sans accès a écrit une checklist';
  exception when insufficient_privilege then null; end;
  update public.products set threshold = 99;
  assert not exists (select 1 from public.products where threshold = 99), 'sans accès, pas de modification du catalogue';
  begin perform public.set_rights(me.id, array['checklists']); raise exception 'TEST: une responsable s''est donné un accès';
  exception when insufficient_privilege then null; end;
  begin insert into public.profile_rights (profile_id, area) values (me.id, 'checklists'); raise exception 'TEST: un accès a été écrit directement';
  exception when insufficient_privilege then null; end;
end $$;

-- 2. Le gérant donne des accès, seulement à un responsable
set request.jwt.claims = :boss;
do $$
declare ines uuid := (select id from public.profiles where email = 'ines@nuba.fr'); theo uuid := (select id from public.profiles where email = 'theo@nuba.fr');
begin
  assert public.can('checklists') and public.can('reservations') and public.can('nimporte'), 'le gérant peut tout';
  begin perform public.set_rights(theo, array['checklists']); raise exception 'TEST: un accès a été donné à un équipier';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
  begin perform public.set_rights(ines, array['tout']); raise exception 'TEST: une zone inconnue a été acceptée';
  exception when check_violation then null; end;
  perform public.set_rights(ines, array['checklists', 'stocks', 'maintenance', 'planning']);
  perform public.set_rights(ines, array['checklists', 'stocks', 'maintenance']);
  assert (select array_agg(area order by area) from public.profile_rights where profile_id = ines) = array['checklists', 'maintenance', 'stocks'], 'la liste remplace la précédente';
  insert into public.deadlines (title, category, due_date) values ('Contrôle électrique', 'controle', current_date + 10);
  insert into public.deadlines (title, category, due_date, profile_id) values ('Visite médicale', 'document', current_date + 5, theo);
end $$;
set request.jwt.claims = :theo;
do $$ begin
  assert (select count(*) from public.profile_rights) = 0, 'un équipier ne lit pas les accès des autres';
  assert not public.can('checklists'), 'un équipier n''a aucun accès';
end $$;

-- 3. La responsable tient ses zones, et seulement elles
set request.jwt.claims = :ines;
do $$
declare
  me uuid := public.my_profile_id();
  c uuid; n_done int;
begin
  assert (select count(*) from public.profile_rights) = 3, 'elle lit ses propres accès';
  assert public.can('checklists') and public.can('stocks') and not public.can('fiches') and not public.can('planning'), 'can() suit les accès donnés';
  c := public.save_checklist(null, 'Mise en place terrasse', 'service', 'daily', '[{"label":"Sortir les tables"}]');
  assert (select count(*) from public.checklist_items where checklist_id = c) = 1, 'avec l''accès, elle compose une checklist';
  update public.checklists set active = false where id = c;
  assert (select not active from public.checklists where id = c), 'et la retire';
  update public.products set threshold = 7 where name = 'Gin';
  assert (select threshold = 7 from public.products where name = 'Gin'), 'avec l''accès, elle règle un seuil';
  insert into public.suppliers (name) values ('Maraîcher du Faubourg');
  begin perform public.save_recipe(null, jsonb_build_object('name', 'Pirate'), '[]'); raise exception 'TEST: une fiche a été écrite sans l''accès';
  exception when insufficient_privilege then null; end;
  begin insert into public.shifts (profile_id, starts_at, ends_at) values (me, now() + interval '3 days', now() + interval '3 days 5 hours'); raise exception 'TEST: le planning a été écrit sans l''accès';
  exception when insufficient_privilege then null; end;
  update public.profiles set role = 'gerant' where id = me;
  assert (select role = 'responsable' from public.profiles where id = me), 'un accès ne donne pas la main sur l''équipe';
  update public.booking_settings set online_enabled = false;
  assert (select online_enabled from public.booking_settings), 'ni sur les réservations';
  assert (select count(*) from public.email_settings) = 0, 'ni sur les e-mails';
  begin perform public.add_kiosk((select id from public.sites limit 1), 'Pirate'); raise exception 'TEST: une borne a été créée par une responsable';
  exception when insufficient_privilege then null; end;

  -- Maintenance : contrôles et contrats, jamais les documents personnels
  assert exists (select 1 from public.deadlines where title = 'Contrôle électrique')
     and not exists (select 1 from public.deadlines where category = 'document' or profile_id is not null), 'elle voit les contrôles, pas les documents de l''équipe';
  n_done := (select count(*) from public.deadline_done);
  insert into public.deadlines (title, category, due_date, repeat_months) values ('Hotte', 'controle', current_date + 20, 6);
  begin insert into public.deadlines (title, category, due_date) values ('Carte vitale', 'document', current_date + 20); raise exception 'TEST: un document personnel a été créé';
  exception when insufficient_privilege then null; end;
  perform public.complete_deadline((select id from public.deadlines where title = 'Contrôle électrique'), null, 'Fait');
  assert (select count(*) from public.deadline_done) = n_done + 1, 'elle classe une échéance';
  assert (public.today_tasks() ->> 'deadlines_due')::int = 1, 'son accueil compte ses échéances, ici la hotte : ' || (public.today_tasks() ->> 'deadlines_due');
end $$;
reset role;
do $$
declare doc uuid := (select id from public.deadlines where title = 'Visite médicale');
begin
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000005"}', true);
  set local role authenticated;
  begin perform public.complete_deadline(doc, null, ''); raise exception 'TEST: un document personnel a été classé par une responsable';
  exception when insufficient_privilege then null; end;
end $$;
set role authenticated;
set request.jwt.claims = :boss;
do $$ begin
  assert exists (select 1 from public.deadlines where title = 'Visite médicale' and active) and (public.today_tasks() ->> 'deadlines_due')::int = 2, 'le gérant voit toutes les échéances, documents compris : ' || (public.today_tasks() ->> 'deadlines_due');
end $$;

-- 4. Jamais dans une session à code PIN, même pour une responsable qui a l'accès
do $$ begin
  perform public.set_member_pin((select id from public.profiles where email = 'ines@nuba.fr'), '7391');
end $$;
update t_adm set v = (public.add_kiosk((select id from public.sites limit 1), 'iPad administration')) ->> 'code';
set role anon;
set request.jwt.claims = '';
do $$
declare
  tok text := (public.claim_kiosk((select v from t_adm))) ->> 'token';
  ines uuid := (select (e ->> 'id')::uuid from jsonb_array_elements(public.kiosk_team(tok)) e where e ->> 'first_name' = 'Inès');
begin
  update t_adm set v = (public.kiosk_login(tok, ines, '7391')) ->> 'ticket';
end $$;
select set_config('request.headers', json_build_object('x-nuba-ticket', (select v from t_adm))::text, false) \gset ignore_
do $$ begin
  assert public.my_profile_id() = (select id from public.profiles where first_name = 'Inès'), 'la session à code PIN est bien celle d''Inès';
  assert not public.can('checklists') and not public.can('stocks'), 'aucun accès délégué dans une session à code PIN';
  begin perform public.save_checklist(null, 'Pirate', 'service', 'daily', '[]'); raise exception 'TEST: une checklist a été écrite avec un code PIN';
  exception when insufficient_privilege then null; end;
  begin update public.products set threshold = 55; raise exception 'TEST: le catalogue a été modifié avec un code PIN';
  exception when insufficient_privilege then null; end;
  assert (public.today_tasks() -> 'deadlines_due') = 'null'::jsonb, 'pas d''échéances sur l''accueil d''une session à code PIN';
end $$;
reset request.headers;

-- 5. Retirer un accès, changer de rôle
set role authenticated;
set request.jwt.claims = :boss;
do $$
declare ines uuid := (select id from public.profiles where email = 'ines@nuba.fr');
begin
  perform public.set_rights(ines, array['stocks']);
  update public.profiles set role = 'equipier' where id = ines;
  assert (select count(*) from public.profile_rights where profile_id = ines) = 0, 'quitter le rôle de responsable retire les accès';
  update public.profiles set role = 'responsable' where id = ines;
  assert (select count(*) from public.profile_rights where profile_id = ines) = 0, 'et ils ne reviennent pas tout seuls';
end $$;
set request.jwt.claims = :ines;
do $$ begin
  assert not public.can('stocks'), 'accès retiré';
  update public.products set threshold = 99;
  assert not exists (select 1 from public.products where threshold = 99), 'sans accès, plus de modification';
end $$;

-- 6. Dossier Drive : pour le gérant seulement
set request.jwt.claims = :boss;
do $$
declare theo uuid := (select id from public.profiles where email = 'theo@nuba.fr');
begin
  insert into public.profile_folders (profile_id, url) values (theo, 'https://drive.google.com/drive/folders/abc123');
  begin insert into public.profile_folders (profile_id, url) values (public.my_profile_id(), 'javascript:alert(1)'); raise exception 'TEST: un lien qui n''est pas une adresse https a été accepté';
  exception when check_violation then null; end;
end $$;
set request.jwt.claims = :ines;
do $$ begin
  assert (select count(*) from public.profile_folders) = 0, 'les dossiers ne sont lus que par le gérant';
end $$;

-- 7. E-mails : rien ne part tant que le gérant n'a pas activé l'envoi
set role anon;
set request.jwt.claims = '';
do $$
declare r jsonb := public.book_table((select d_tue from t_adm), '20:00', 2, 'Aline', '0600000001', 'aline@exemple.fr', '', '');
begin
  assert (r ->> 'ok')::boolean and not (r ->> 'emailed')::boolean, 'réservation sans e-mail quand l''envoi est coupé : ' || r::text;
end $$;
reset role;
do $$ begin
  assert (select count(*) from public.email_outbox) = 0 and (select count(*) from net.sent) = 0, 'aucun e-mail préparé';
end $$;
set role authenticated;
set request.jwt.claims = :theo;
do $$ begin
  update public.email_settings set enabled = true;
  begin perform public.email_log(); raise exception 'TEST: un équipier a lu le journal des e-mails';
  exception when insufficient_privilege then null; end;
  begin perform public.send_test_email(); raise exception 'TEST: un équipier a envoyé un essai';
  exception when insufficient_privilege then null; end;
  begin perform * from public.email_outbox; raise exception 'TEST: un équipier a lu les e-mails';
  exception when insufficient_privilege then null; end;
end $$;
set request.jwt.claims = :boss;
do $$
declare r jsonb;
begin
  assert (select not enabled from public.email_settings), 'un équipier n''active pas l''envoi';
  begin perform public.send_test_email(); raise exception 'TEST: un essai est parti alors que l''envoi est coupé';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
  begin update public.email_settings set sender_email = 'pas une adresse'; raise exception 'TEST: une adresse fausse a été acceptée';
  exception when check_violation then null; end;
  update public.email_settings set enabled = true, sender_email = 'reservation@nuba.fr', notify_email = 'boss@nuba.fr';
  -- La clé n'est pas encore dans le coffre : l'essai échoue et dit pourquoi.
  r := public.send_test_email();
  assert not (r ->> 'ok')::boolean and r ->> 'error' like '%brevo_api_key%', 'sans clé, l''essai explique ce qui manque : ' || r::text;
end $$;
reset role;
insert into vault.decrypted_secrets (name, decrypted_secret) values ('brevo_api_key', ' xkeysib-test ');
set role authenticated;
set request.jwt.claims = :boss;
do $$
declare r jsonb := public.send_test_email();
begin
  assert (r ->> 'ok')::boolean and r ->> 'to' = 'boss@nuba.fr', 'l''essai part vers l''adresse des alertes : ' || r::text;
end $$;
reset role;
do $$
declare s net.sent;
begin
  select * into s from net.sent order by id desc limit 1;
  assert s.url = 'https://api.brevo.com/v3/smtp/email', 'adresse du service d''envoi';
  assert s.headers ->> 'api-key' = 'xkeysib-test' and s.headers ->> 'Content-Type' = 'application/json', 'la clé part dans l''en-tête : ' || s.headers::text;
  assert s.body -> 'sender' ->> 'email' = 'reservation@nuba.fr' and s.body -> 'to' -> 0 ->> 'email' = 'boss@nuba.fr'
         and s.body ->> 'subject' like 'Essai%' and length(s.body ->> 'textContent') > 20, 'contenu de l''e-mail : ' || s.body::text;
  delete from net.sent;
end $$;

-- 8. Réservation en ligne : confirmation au client et alerte à la Nuba
set role anon;
set request.jwt.claims = '';
do $$
declare r jsonb := public.book_table((select d_tue from t_adm), '20:30', 4, 'Bruno', '0600000002', ' Bruno@Exemple.fr ', 'Anniversaire', '');
begin
  assert (r ->> 'ok')::boolean and (r ->> 'emailed')::boolean, 'la réservation annonce son e-mail : ' || r::text;
  update t_adm set id = (r ->> 'id')::uuid, code = r ->> 'code';
  r := public.book_table((select d_tue from t_adm), '21:00', 2, 'Chloé', '0600000003', '', '', '');
  assert (r ->> 'ok')::boolean and not (r ->> 'emailed')::boolean, 'sans adresse, pas de confirmation par e-mail';
  r := public.book_table((select d_tue from t_adm), '21:00', 2, 'Dan', '0600000004', 'pas-une-adresse', '', '');
  assert (r ->> 'ok')::boolean and not (r ->> 'emailed')::boolean, 'une adresse fausse ne bloque pas la réservation';
end $$;
reset role;
do $$
declare
  t record := (select t from t_adm t);
  c net.sent; a net.sent;
begin
  assert (select count(*) from net.sent) = 4, 'une confirmation et trois alertes : ' || (select count(*) from net.sent);
  select * into c from net.sent where body -> 'to' -> 0 ->> 'email' = 'bruno@exemple.fr';
  assert c.body ->> 'subject' = 'Votre réservation à la Nuba, ' || public._fr_day(t.d_tue) || ' à 20 h 30', 'objet de la confirmation : ' || (c.body ->> 'subject');
  assert c.body ->> 'textContent' like '%pour 4 personnes.%'
         and c.body ->> 'textContent' like '%https://skanbls.github.io/SiteNuba/#/reservation?r=' || t.id || '&c=' || t.code || '%', 'la confirmation porte le lien du client : ' || (c.body ->> 'textContent');
  select * into a from net.sent where body ->> 'subject' like 'Réservation en ligne : Bruno%';
  assert a.body -> 'to' -> 0 ->> 'email' = 'boss@nuba.fr' and a.body ->> 'textContent' like '%0600000002%' and a.body ->> 'textContent' like '%Anniversaire%', 'l''alerte donne les coordonnées : ' || (a.body ->> 'textContent');
  assert public._fr_day(date '2026-11-01') = 'dimanche 1er novembre' and public._fr_time('20:00') = '20 h' and public._fr_time('12:05') = '12 h 05', 'dates et heures en français';
  delete from net.sent;
end $$;

-- 9. Annulations : par le client (deux e-mails), par l'équipe (un seul)
set role anon;
do $$ begin
  assert public.cancel_booking((select id from t_adm), (select code from t_adm)), 'le client annule avec son lien';
end $$;
reset role;
do $$ begin
  assert (select count(*) from net.sent) = 2
     and exists (select 1 from net.sent where body -> 'to' -> 0 ->> 'email' = 'bruno@exemple.fr' and body ->> 'subject' like '%annulée%')
     and exists (select 1 from net.sent where body -> 'to' -> 0 ->> 'email' = 'boss@nuba.fr' and body ->> 'subject' like 'Annulation par le client : Bruno%'),
     'annulation par le client : un e-mail pour lui, une alerte pour la Nuba';
  delete from net.sent;
end $$;
set role authenticated;
set request.jwt.claims = :boss;
do $$ begin
  perform public.set_reservation_status((select id from public.reservations where name = 'Aline'), 'cancelled');
  perform public.set_reservation_status((select id from public.reservations where name = 'Chloé'), 'seated');
end $$;
reset role;
do $$ begin
  assert (select count(*) from net.sent) = 1 and (select body -> 'to' -> 0 ->> 'email' from net.sent) = 'aline@exemple.fr', 'annulation par l''équipe : seul le client est prévenu';
  delete from net.sent;
end $$;

-- 10. Demande de privatisation en ligne : alerte à la Nuba
set role anon;
set request.jwt.claims = '';
do $$
declare r jsonb := public.request_private_event('privatisation', current_date + 40, 60, 'Élodie Vidal', 'Studio Vidal', '0600000005', 'elodie@exemple.fr', 'Soirée de fin d''année', '');
begin
  assert (r ->> 'ok')::boolean, 'la demande passe : ' || r::text;
end $$;
reset role;
do $$
declare a net.sent;
begin
  select * into strict a from net.sent;
  assert a.body ->> 'subject' like 'Demande en ligne : Privatisation, Élodie Vidal%' and a.body ->> 'textContent' like '%Studio Vidal%'
         and a.body ->> 'textContent' like '%Soirée de fin d''année%' and a.body ->> 'textContent' like '%#/evenements%', 'alerte de demande : ' || a.body::text;
end $$;

-- 11. Journal : la réponse du service d'envoi est reportée
insert into net._http_response (id, status_code, content)
  select request_id, 201, '{"messageId":"x"}' from public.email_outbox where kind = 'reservation';
insert into net._http_response (id, status_code, content)
  select request_id, 401, '{"code":"unauthorized","message":"Key not found"}' from public.email_outbox where kind = 'alerte_evenement';
set role authenticated;
set request.jwt.claims = :boss;
do $$
declare l jsonb := public.email_log();
begin
  assert jsonb_array_length(l) = 10, 'le journal liste les e-mails : ' || jsonb_array_length(l);
  assert (select e ->> 'status' from jsonb_array_elements(l) e where e ->> 'kind' = 'reservation') = 'accepted', 'un e-mail accepté par le service';
  assert (select e ->> 'error' from jsonb_array_elements(l) e where e ->> 'kind' = 'alerte_evenement') like 'Réponse 401%Key not found%', 'un refus du service est expliqué';
  assert (select e ->> 'status' from jsonb_array_elements(l) e where e ->> 'kind' = 'annulation' limit 1) = 'sent', 'sans réponse, l''e-mail reste « parti »';
  assert (select e ->> 'error' from jsonb_array_elements(l) e where e ->> 'kind' = 'essai' and e ->> 'status' = 'failed') like '%brevo_api_key%', 'l''essai sans clé reste noté';
end $$;

-- 12. Un service d'envoi en panne ne bloque jamais une réservation ; les réglages coupent les envois
reset role;
delete from net.sent;
create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}',
  headers jsonb default '{"Content-Type": "application/json"}', timeout_milliseconds int default 5000) returns bigint
language plpgsql as $$ begin raise exception 'service en panne'; end $$;
set role anon;
set request.jwt.claims = '';
do $$
declare r jsonb := public.book_table((select d_tue from t_adm), '19:00', 2, 'Farid', '0600000006', 'farid@exemple.fr', '', '');
begin
  assert (r ->> 'ok')::boolean and not (r ->> 'emailed')::boolean, 'la réservation passe même si l''envoi échoue : ' || r::text;
end $$;
reset role;
do $$ begin
  assert (select count(*) from public.email_outbox where status = 'failed' and error like '%service en panne%') = 2, 'les deux échecs sont notés';
  update public.email_settings set notify_booking = false, confirm_booking = false;
end $$;
set role anon;
do $$
declare r jsonb := public.book_table((select d_tue from t_adm), '19:30', 2, 'Gaby', '0600000007', 'gaby@exemple.fr', '', '');
        n int;
begin
  assert (r ->> 'ok')::boolean and not (r ->> 'emailed')::boolean, 'confirmation coupée dans les réglages';
end $$;
reset role;
do $$ begin
  assert (select count(*) from public.email_outbox where to_email = 'gaby@exemple.fr' or subject like '%Gaby%') = 0, 'ni confirmation ni alerte quand les deux sont coupées';
end $$;

-- Remise en état
update public.email_settings set enabled = false, confirm_booking = true, notify_booking = true;
update public.kiosks set revoked_at = now() where revoked_at is null;
