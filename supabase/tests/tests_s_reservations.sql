-- Tests de la migration 0007 (réservations). Joués en dernier, sur la même base.
\set ON_ERROR_STOP on
\set boss  '''{"sub":"00000000-0000-0000-0000-000000000001"}'''
\set theo  '''{"sub":"00000000-0000-0000-0000-000000000002"}'''
\set intru '''{"sub":"00000000-0000-0000-0000-000000000003"}'''
reset role;
reset request.headers;
-- Prochain mardi (ouvert) et prochain lundi (fermé), strictement après aujourd'hui.
create temp table t_res as select
  (current_date + 1 + ((2 - extract(isodow from current_date + 1)::int + 7) % 7))::date as d_tue,
  (current_date + 1 + ((1 - extract(isodow from current_date + 1)::int + 7) % 7))::date as d_mon,
  null::uuid as id, null::text as code, null::text as ticket;
grant select, update on t_res to anon, authenticated;

-- 1. La page publique : règles, créneaux, réservation
set role anon;
set request.jwt.claims = '';
do $$
declare
  tue date := (select d_tue from t_res); mon date := (select d_mon from t_res);
  info jsonb := public.booking_info();
  slots jsonb := public.booking_slots(tue, 2);
  r jsonb;
begin
  assert (info ->> 'online_enabled')::boolean and (info ->> 'max_party_online')::int = 9, 'règles par défaut';
  assert info -> 'open_weekdays' = '[2, 3, 4, 5, 6, 7]'::jsonb, 'fermé le lundi : ' || (info -> 'open_weekdays')::text;
  assert jsonb_array_length(slots) = 21 and slots ->> 0 = '12:00' and slots ->> 20 = '22:00', 'mardi : de 12 h à 22 h, toutes les 30 min : ' || slots::text;
  assert public.booking_slots(mon, 2) = '[]'::jsonb, 'aucun créneau le lundi';
  assert public.booking_slots(tue, 10) = '[]'::jsonb, 'pas de réservation en ligne à 10';
  assert public.booking_slots(current_date + 200, 2) = '[]'::jsonb, 'pas de réservation trop loin dans le temps';
  assert jsonb_array_length(public.booking_slots(tue + 3, 2)) = 22, 'vendredi : jusqu''à 22 h 30';
  assert public.booking_slots(tue + 5, 2) ->> -1 = '14:00', 'dimanche : dernier créneau à 14 h';

  assert (public.book_table(tue, '20:10', 4, 'Camille', '0611223344', '', '', '')) ->> 'error' = 'slot', 'un horaire hors créneau est refusé';
  assert (public.book_table(mon, '20:00', 4, 'Camille', '0611223344', '', '', '')) ->> 'error' = 'slot', 'un jour fermé est refusé';
  assert (public.book_table(tue, '20:00', 10, 'Camille', '0611223344', '', '', '')) ->> 'error' = 'party', 'à 10, il faut appeler';
  assert (public.book_table(tue, '20:00', 4, 'C', '0611223344', '', '', '')) ->> 'error' = 'contact', 'un nom est demandé';
  assert (public.book_table(tue, '20:00', 4, 'Camille', '12', '', '', '')) ->> 'error' = 'contact', 'un téléphone est demandé';
  assert (public.book_table(tue, '20:00', 4, 'Camille', '0611223344', '', '', 'robot')) ->> 'error' = 'contact', 'le champ piège arrête un robot';

  r := public.book_table(tue, '20:00', 4, '  Camille R. ', '06 11 22 33 44', ' Camille@Exemple.fr ', 'Anniversaire', '');
  assert (r ->> 'ok')::boolean and (r ->> 'code') ~ '^[0-9a-f]{20}$', 'la réservation doit passer : ' || r::text;
  update t_res set id = (r ->> 'id')::uuid, code = r ->> 'code';
  assert (select count(*) from public.reservations) = 0, 'le public ne lit pas les réservations';
  assert public.my_booking((r ->> 'id')::uuid, 'mauvais') is null, 'sans le bon code, pas de détail';
  assert (public.my_booking((r ->> 'id')::uuid, r ->> 'code')) ->> 'slot' = '20:00', 'le client retrouve sa réservation par son lien';
  begin
    insert into public.reservations (day, slot, party, name) values (tue, '21:00', 2, 'Pirate');
    raise exception 'TEST: une réservation a pu être écrite sans passer par book_table';
  exception when insufficient_privilege then null; end;
  begin
    perform public.save_reservation(null, tue, '21:00', 2, 'Pirate', '', '', '', 'telephone', '');
    raise exception 'TEST: le public a pu utiliser la saisie de l''équipe';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
  assert (select name = 'Camille R.' and phone = '0611223344' and email = 'camille@exemple.fr' and source = 'en_ligne' and status = 'confirmed' and created_by is null
          from public.reservations where id = (select id from t_res)), 'les coordonnées sont nettoyées et la source notée';
end $$;

-- 2. Capacité par créneau, limite par téléphone, annulation par le client
update public.booking_settings set capacity_per_slot = 6;
set role anon;
do $$
declare tue date := (select d_tue from t_res); id uuid := (select id from t_res); code text := (select code from t_res);
begin
  assert not (public.booking_slots(tue, 4) ? '20:00') and public.booking_slots(tue, 2) ? '20:00', 'à 20 h il reste 2 places sur 6';
  assert (public.book_table(tue, '20:00', 4, 'Julien', '0622334455', '', '', '')) ->> 'error' = 'slot', 'un créneau plein est refusé';
  assert ((public.book_table(tue, '19:00', 2, 'Camille R.', '0611223344', '', '', '')) ->> 'ok')::boolean, 'deuxième réservation du même numéro';
  assert ((public.book_table(tue + 1, '19:00', 2, 'Camille R.', '0611223344', '', '', '')) ->> 'ok')::boolean, 'troisième';
  assert (public.book_table(tue + 2, '19:00', 2, 'Camille R.', '0611223344', '', '', '')) ->> 'error' = 'too_many_phone', 'pas plus de trois réservations à venir par numéro';
  assert not public.cancel_booking(id, 'mauvais'), 'on n''annule pas sans le bon code';
  assert public.cancel_booking(id, code), 'le client annule avec son lien';
  assert not public.cancel_booking(id, code), 'une réservation annulée ne s''annule pas deux fois';
  assert public.booking_slots(tue, 4) ? '20:00', 'l''annulation libère le créneau';
end $$;
reset role;
update public.booking_settings set capacity_per_slot = null;

-- 3. L'équipe : lecture, saisie sans limite, statuts
set role authenticated;
set request.jwt.claims = :theo;
do $$
declare tue date := (select d_tue from t_res); mon date := (select d_mon from t_res); me uuid := public.my_profile_id(); v uuid;
begin
  assert (select count(*) from public.reservations) = 3, 'l''équipe lit les réservations';
  v := public.save_reservation(null, mon, '23:15', 14, '  Groupe Dupont ', '05 61 00 00 00', '', 'Privatisation à prévoir', 'telephone', 'Grande table');
  assert (select party = 14 and name = 'Groupe Dupont' and created_by = me and source = 'telephone' and table_label = 'Grande table' from public.reservations where id = v), 'l''équipe saisit sans limite de taille ni d''horaire';
  perform public.save_reservation(v, tue, '21:00', 12, 'Groupe Dupont', '', '', '', 'telephone', 'T8');
  assert (select day = tue and party = 12 and table_label = 'T8' from public.reservations where id = v), 'modification';
  perform public.set_reservation_status(v, 'seated');
  assert (select status from public.reservations where id = v) = 'seated', 'arrivés';
  begin perform public.set_reservation_status(v, 'parti'); raise exception 'TEST: un statut inconnu a été accepté';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
  begin perform public.save_reservation(null, tue, '21:00', 0, 'X', '', '', '', 'telephone', ''); raise exception 'TEST: une réservation pour 0 personne a été acceptée';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
  begin update public.reservations set party = 99; raise exception 'TEST: une réservation a été modifiée sans passer par save_reservation';
  exception when insufficient_privilege then null; end;
  update public.opening_hours set open = false where weekday = 2;
  assert (select open from public.opening_hours where weekday = 2), 'un équipier ne change pas les horaires';
  update public.booking_settings set max_party_online = 50;
  assert (select max_party_online from public.booking_settings) = 9, 'un équipier ne change pas les règles';
end $$;
set request.jwt.claims = :intru;
do $$ begin
  assert (select count(*) from public.reservations) = 0 and (select count(*) from public.booking_settings) = 0, 'un inconnu ne lit rien';
  begin perform public.set_reservation_status(gen_random_uuid(), 'seated'); raise exception 'TEST: un inconnu a changé un statut';
  exception when insufficient_privilege then null; end;
end $$;

-- 4. Le gérant règle les horaires et peut couper la réservation en ligne
set request.jwt.claims = :boss;
update public.opening_hours set last_slot = '21:00', break_from = '15:00', break_to = '19:00' where weekday = 2;
set role anon;
set request.jwt.claims = '';
do $$
declare tue date := (select d_tue from t_res); slots jsonb := public.booking_slots((select d_tue from t_res), 2);
begin
  assert slots ->> -1 = '21:00' and not slots ? '15:00' and not slots ? '18:30' and slots ? '14:30' and slots ? '19:00', 'dernier créneau et coupure de l''après-midi : ' || slots::text;
end $$;
set role authenticated;
set request.jwt.claims = :boss;
update public.opening_hours set last_slot = '22:00', break_from = null, break_to = null where weekday = 2;
update public.booking_settings set online_enabled = false;
set role anon;
set request.jwt.claims = '';
do $$ declare tue date := (select d_tue from t_res); begin
  assert public.booking_slots(tue, 2) = '[]'::jsonb, 'réservation en ligne coupée : aucun créneau';
  assert (public.book_table(tue, '20:00', 2, 'Julien', '0622334455', '', '', '')) ->> 'error' = 'disabled', 'réservation en ligne coupée';
end $$;
reset role;
update public.booking_settings set online_enabled = true;

-- 5. Envois en rafale
set role anon;
do $$
declare tue date := (select d_tue from t_res); r jsonb;
begin
  for i in 1..17 loop
    r := public.book_table(tue + 1, '12:00', 1, 'Rafale ' || i, '07000000' || lpad(i::text, 2, '0'), '', '', '');
    assert (r ->> 'ok')::boolean, 'réservation ' || i || ' : ' || r::text;
  end loop;
  assert (public.book_table(tue + 1, '12:30', 1, 'De trop', '0799999999', '', '', '')) ->> 'error' = 'too_many', 'vingt réservations en dix minutes déclenchent le garde-fou';
end $$;
reset role;
delete from public.reservations where name like 'Rafale %';

-- 6. Sur l'iPad, par code PIN, et l'accueil
set role authenticated;
set request.jwt.claims = :boss;
update t_res set ticket = (public.add_kiosk((select id from public.sites limit 1), 'iPad accueil')) ->> 'code';
set role anon;
set request.jwt.claims = '';
do $$
declare
  tok text := (public.claim_kiosk((select ticket from t_res))) ->> 'token';
  hugo uuid := (select (e ->> 'id')::uuid from jsonb_array_elements(public.kiosk_team(tok)) e where e ->> 'first_name' = 'Hugo');
begin
  update t_res set ticket = (public.kiosk_login(tok, hugo, '8642')) ->> 'ticket';
end $$;
select set_config('request.headers', json_build_object('x-nuba-ticket', (select ticket from t_res))::text, false) \gset ignore_
do $$
declare me uuid := public.my_profile_id(); d date := public.service_day(); v uuid; t jsonb;
begin
  assert (select count(*) from public.reservations) = 4, 'la session à code PIN lit les réservations';
  v := public.save_reservation(null, d, '20:30', 5, 'Table du soir', '', '', '', 'sur_place', '');
  assert (select created_by = me from public.reservations where id = v), 'la saisie est signée Hugo';
  perform public.save_reservation(null, d, '21:00', 2, 'Annulée', '', '', '', 'telephone', '');
  perform public.set_reservation_status((select id from public.reservations where name = 'Annulée'), 'cancelled');
  t := public.today_tasks();
  assert (t ->> 'bookings')::int = 1 and (t ->> 'covers')::int = 5, 'l''accueil compte les réservations du jour, sans les annulées : ' || t::text;
  begin update public.booking_settings set online_enabled = false; raise exception 'TEST: une session à code PIN a changé les règles';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
reset request.headers;
update public.kiosks set revoked_at = now() where revoked_at is null;
