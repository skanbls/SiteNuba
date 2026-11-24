-- Tests de la migration 0022 : demandes à valider, e-mails de l'équipe, rappels, mise en page. Données inventées.
\set ON_ERROR_STOP on
\set boss '''{"sub":"00000000-0000-0000-0000-000000000001"}'''
\set theo '''{"sub":"00000000-0000-0000-0000-000000000002"}'''
reset role;
reset request.headers;
-- Un service d'envoi qui marche (les tests de la 0010 l'ont laissé « en panne »).
create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}',
  headers jsonb default '{"Content-Type": "application/json"}', timeout_milliseconds int default 5000) returns bigint
language plpgsql security definer as $$
declare v bigint;
begin
  insert into net.sent (url, body, headers) values ($1, $2, $4) returning id into v;
  return v;
end $$;
delete from net.sent;
insert into vault.decrypted_secrets (name, decrypted_secret) values ('brevo_api_key', 'xkeysib-test') on conflict (name) do nothing;
update public.email_settings set enabled = true, sender_email = 'reservation@nuba.fr', notify_email = 'boss@nuba.fr',
  confirm_booking = true, notify_booking = true, remind_booking = true where true;
update public.booking_settings set online_enabled = true, capacity_per_slot = null, review_from = 6 where true;
-- Les réservations des tests précédents ne comptent plus dans le garde-fou « 20 en 10 minutes ».
update public.reservations set created_at = created_at - interval '1 day' where true;
-- Prochain mercredi, au moins trois jours après aujourd'hui.
create temp table t_rz as select
  (current_date + 3 + ((3 - extract(isodow from current_date + 3)::int + 7) % 7))::date as d_wed,
  null::uuid as pending, null::text as pcode, null::uuid as other, null::uuid as phone_id, null::text as link;
grant select, update on t_rz to anon, authenticated;

-- 1. La mise en page : logo, bouton, texte échappé ; la version texte
do $$
declare
  h text := public._email_html('Essai', E'Bonjour <b>Léa</b> & co,\n\nVotre table :\nmardi.\n\n[[Voir ma réservation|https://app.test/#/reservation?r=1&c=2]]\n\nSite : https://nuba.test/menu', 'https://app.test/');
  t text := public._email_text(E'Bonjour,\n\n[[Voir ma réservation|https://app.test/#/r?c=2]]');
begin
  assert h like '%<img src="https://app.test/email-logo.png"%', 'le logo vient de l''appli';
  assert h like '%&lt;b&gt;Léa&lt;/b&gt; &amp; co%' and h not like '%<b>Léa%', 'le texte est échappé';
  assert h like '%<a href="https://app.test/#/reservation?r=1&amp;c=2" style="display:inline-block%>Voir ma réservation</a>%', 'le bouton : ' || h;
  assert h like '%<a href="https://nuba.test/menu" style="color:#113F24">https://nuba.test/menu</a>%', 'un lien simple devient cliquable';
  assert h like '%<p style="margin:0 0 16px">Votre table :<br>mardi.</p>%', 'paragraphes et retours à la ligne';
  assert h not like '%[[%', 'plus de crochets dans la version mise en page';
  assert t = E'Bonjour,\n\nVoir ma réservation : https://app.test/#/r?c=2', 'version texte : ' || t;
end $$;

-- 2. En ligne : au-delà du seuil, une demande à valider ; elle garde sa place
set role anon;
set request.jwt.claims = '';
do $$
declare
  wed date := (select d_wed from t_rz);
  r jsonb;
begin
  assert (public.booking_info() ->> 'review_from')::int = 6, 'la page publique connaît le seuil';
  r := public.book_table(wed, '20:00', 4, 'Inès Petit', '0600000101', 'ines.petit@exemple.fr', '', '');
  assert (r ->> 'ok')::boolean and r ->> 'status' = 'confirmed' and (r ->> 'emailed')::boolean, 'à 4, confirmée tout de suite : ' || r::text;
  update t_rz set other = (r ->> 'id')::uuid;
  r := public.book_table(wed, '20:00', 7, 'Jules Martin', '0600000102', 'jules@exemple.fr', 'Anniversaire', '');
  assert (r ->> 'ok')::boolean and r ->> 'status' = 'pending' and (r ->> 'emailed')::boolean, 'à 7, une demande : ' || r::text;
  update t_rz set pending = (r ->> 'id')::uuid, pcode = r ->> 'code';
  assert public.my_booking((r ->> 'id')::uuid, r ->> 'code') ->> 'status' = 'pending', 'le client voit que sa demande attend';
end $$;
reset role;
do $$
declare c net.sent; a net.sent;
begin
  select * into strict c from net.sent where body -> 'to' -> 0 ->> 'email' = 'jules@exemple.fr';
  assert c.body ->> 'subject' = 'Votre demande de réservation à la Nuba'
     and c.body ->> 'textContent' like '%pas encore confirmée%'
     and c.body ->> 'textContent' like '%Voir ou annuler ma demande : https://skanbls.github.io/SiteNuba/#/reservation?r=%'
     and c.body ->> 'htmlContent' like '%https://skanbls.github.io/SiteNuba/email-logo.png%', 'demande reçue, avec le logo : ' || c.body::text;
  select * into strict a from net.sent where body ->> 'subject' like 'Demande à valider : Jules Martin%';
  assert a.body -> 'to' -> 0 ->> 'email' = 'boss@nuba.fr' and a.body ->> 'textContent' like '%Répondre à la demande : %#/reservations%', 'la Nuba est prévenue : ' || a.body::text;
  assert exists (select 1 from net.sent where body -> 'to' -> 0 ->> 'email' = 'ines.petit@exemple.fr' and body ->> 'subject' like 'Votre réservation à la Nuba, %'),
    'la réservation à 4 reçoit sa confirmation';
  assert (select kind from public.email_outbox where to_email = 'ines.petit@exemple.fr') = 'reservation', 'même nom qu''avant dans le journal';
  update public.booking_settings set capacity_per_slot = 12 where true;
  delete from net.sent;
end $$;
set role anon;
do $$ begin
  assert not public.booking_slots((select d_wed from t_rz), 2) ? '20:00', 'la demande (7) et la réservation (4) occupent le créneau de 12';
  begin perform public.decide_booking((select pending from t_rz), true, ''); raise exception 'TEST: le public a validé une demande';
  exception when insufficient_privilege then null; end;
  begin perform public.send_booking_reminders(); raise exception 'TEST: le public a lancé les rappels';
  exception when insufficient_privilege then null; end;
  begin perform public._booking_link((select pending from t_rz)); raise exception 'TEST: le public a fabriqué un lien';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
update public.booking_settings set capacity_per_slot = null where true;

-- 3. L'équipe accepte une demande, en refuse une autre
set role authenticated;
set request.jwt.claims = :theo;
do $$
declare
  wed date := (select d_wed from t_rz);
  r jsonb;
begin
  perform public.decide_booking((select pending from t_rz), true, 'Nous vous installons en terrasse.');
  assert (select status from public.reservations where id = (select pending from t_rz)) = 'confirmed', 'la demande est confirmée';
  begin perform public.decide_booking((select pending from t_rz), false, ''); raise exception 'TEST: une demande a reçu deux réponses';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
  begin perform public.decide_booking((select other from t_rz), false, ''); raise exception 'TEST: une réservation confirmée a été refusée comme une demande';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
end $$;
reset role;
do $$
declare c net.sent; v_code text;
begin
  select * into strict c from net.sent;
  assert c.body -> 'to' -> 0 ->> 'email' = 'jules@exemple.fr'
     and c.body ->> 'subject' = 'Votre réservation est confirmée : ' || public._fr_day((select d_wed from t_rz)) || ' à 20 h'
     and c.body ->> 'textContent' like '%Nous vous installons en terrasse.%'
     and c.body ->> 'textContent' like '%Voir ou annuler ma réservation : %', 'e-mail « confirmée » : ' || c.body::text;
  -- Le lien de cet e-mail ouvre la réservation, comme celui de la page publique.
  v_code := substring(c.body ->> 'textContent' from '&c=([0-9a-f]{20})');
  assert public.my_booking((select pending from t_rz), v_code) ->> 'status' = 'confirmed', 'le nouveau lien marche';
  assert public.my_booking((select pending from t_rz), (select pcode from t_rz)) ->> 'status' = 'confirmed', 'l''ancien aussi';
  assert public.my_booking((select pending from t_rz), 'faux') is null, 'pas un faux';
  delete from net.sent;
end $$;
set role anon;
do $$
declare r jsonb := public.book_table((select d_wed from t_rz), '21:00', 8, 'Karim', '0600000103', 'karim@exemple.fr', '', '');
begin
  assert r ->> 'status' = 'pending', 'une autre demande';
  update t_rz set phone_id = (r ->> 'id')::uuid;
end $$;
reset role;
delete from net.sent;
set role authenticated;
set request.jwt.claims = :theo;
do $$ begin
  perform public.decide_booking((select phone_id from t_rz), false, 'Le restaurant est privatisé ce soir-là.');
  assert (select status from public.reservations where id = (select phone_id from t_rz)) = 'declined', 'la demande est refusée';
end $$;
reset role;
do $$
declare c net.sent;
begin
  select * into strict c from net.sent;
  assert c.body -> 'to' -> 0 ->> 'email' = 'karim@exemple.fr' and c.body ->> 'subject' = 'Votre demande de réservation à la Nuba'
     and c.body ->> 'textContent' like '%nous ne pouvons pas vous accueillir%privatisé ce soir-là.%'
     and c.body ->> 'textContent' not like '%#/reservation?%', 'refus poli, sans lien : ' || c.body::text;
  delete from net.sent;
end $$;
set role anon;
do $$ begin
  assert public.booking_slots((select d_wed from t_rz), 8) ? '21:00', 'une demande refusée libère sa place';
end $$;
reset role;

-- 4. Réservation prise au téléphone : confirmation si on le demande, e-mail si elle change
set role authenticated;
set request.jwt.claims = :theo;
do $$
declare
  wed date := (select d_wed from t_rz);
  a uuid; b uuid;
begin
  a := public.save_reservation(null, wed, '12:30', 3, 'Lucie', '0600000104', ' Lucie@Exemple.fr ', '', 'telephone', '', true);
  b := public.save_reservation(null, wed, '13:00', 2, 'Marc', '0600000105', 'marc@exemple.fr', '', 'telephone', '', false);
  perform public.save_reservation(null, current_date - 1, '13:00', 2, 'Passé', '', 'passe@exemple.fr', '', 'telephone', '', true);
  perform public.save_reservation(null, wed, '13:00', 2, 'Sans adresse', '0600000106', '', '', 'telephone', '', true);
  -- Changer la note ne prévient pas ; changer l'heure, si.
  perform public.save_reservation(a, wed, '12:30', 3, 'Lucie', '0600000104', 'lucie@exemple.fr', 'Chaise haute', 'telephone', 'T4', true);
  perform public.save_reservation(a, wed, '13:00', 3, 'Lucie', '0600000104', 'lucie@exemple.fr', 'Chaise haute', 'telephone', 'T4', true);
  perform public.save_reservation(b, wed, '13:30', 2, 'Marc', '0600000105', 'marc@exemple.fr', '', 'telephone', '', false);
end $$;
reset role;
do $$ begin
  assert (select count(*) from net.sent) = 2, 'une confirmation et une modification, rien d''autre : ' || (select string_agg(body ->> 'subject', ' | ') from net.sent);
  assert exists (select 1 from net.sent where body -> 'to' -> 0 ->> 'email' = 'lucie@exemple.fr'
                 and body ->> 'subject' like 'Votre réservation à la Nuba, %12 h 30' and body ->> 'textContent' like '%pour 3 personnes.%'
                 and body ->> 'textContent' like '%#/reservation?r=%'), 'confirmation de la réservation prise au téléphone';
  assert exists (select 1 from net.sent where body -> 'to' -> 0 ->> 'email' = 'lucie@exemple.fr'
                 and body ->> 'subject' like 'Votre réservation à la Nuba a changé : %13 h'), 'e-mail de modification';
  assert not exists (select 1 from net.sent where body ->> 'subject' like '%Réservation en ligne%'), 'pas d''alerte pour une réservation de l''équipe';
  delete from net.sent;
end $$;

-- 5. Rappel la veille, à partir de 10 h, une seule fois
do $$
declare
  wed date := (select d_wed from t_rz);
  at9  timestamptz := ((wed - 1) + time '09:00') at time zone 'Europe/Paris';
  at10 timestamptz := ((wed - 1) + time '10:30') at time zone 'Europe/Paris';
  late uuid;
begin
  -- Une réservation prise la veille au soir : pas de rappel, le client vient de recevoir sa confirmation.
  insert into public.reservations (day, slot, party, name, email, source, created_at)
    values (wed, '20:30', 2, 'Tardif', 'tardif@exemple.fr', 'telephone', at10 - interval '2 hours') returning id into late;
  assert public.send_booking_reminders(at9) = 0, 'pas avant 10 h';
  assert public.send_booking_reminders(at10 + interval '10 hours') = 0, 'pas le soir après 20 h';
  perform public.send_booking_reminders(at10 - interval '1 day');
  assert not exists (select 1 from net.sent where body -> 'to' -> 0 ->> 'email' like any (array['ines.petit@%', 'jules@%', 'lucie@%', 'marc@%'])), 'pas l''avant-veille';
  delete from net.sent;
  assert public.send_booking_reminders(at10) = 4, 'Inès, Jules, Lucie et Marc : ' || (select string_agg(body -> 'to' -> 0 ->> 'email', ', ') from net.sent);
  assert public.send_booking_reminders(at10 + interval '1 hour') = 0, 'une seule fois';
  assert not exists (select 1 from net.sent where body -> 'to' -> 0 ->> 'email' in ('karim@exemple.fr', 'tardif@exemple.fr')), 'ni la demande refusée ni la réservation de la veille';
  assert (select body ->> 'subject' from net.sent where body -> 'to' -> 0 ->> 'email' = 'marc@exemple.fr') = 'À demain à la Nuba !'
     and (select body ->> 'textContent' from net.sent where body -> 'to' -> 0 ->> 'email' = 'marc@exemple.fr') like '%13 h 30, pour 2 personnes.%Un empêchement ?%Voir ou annuler ma réservation : %',
     'le rappel';
  update t_rz set link = substring((select body ->> 'textContent' from net.sent where body -> 'to' -> 0 ->> 'email' = 'marc@exemple.fr') from '&c=([0-9a-f]{20})'),
    phone_id = (select id from public.reservations where name = 'Marc' and day = wed);
  assert (select reminded_at from public.reservations where name = 'Marc' and day = wed) = at10, 'le rappel est noté';
  delete from net.sent;
  update public.reservations set reminded_at = null where day = wed;
  update public.email_settings set remind_booking = false where true;
  assert public.send_booking_reminders(at10) = 0, 'rappels coupés dans les réglages';
  update public.email_settings set remind_booking = true where true;
  delete from public.reservations where id = late;
end $$;

-- 6. Le client annule avec le lien du rappel
set role anon;
set request.jwt.claims = '';
do $$ begin
  assert public.cancel_booking((select phone_id from t_rz), (select link from t_rz)),
    'le lien du rappel annule';
end $$;
reset role;
do $$ begin
  assert exists (select 1 from net.sent where body -> 'to' -> 0 ->> 'email' = 'marc@exemple.fr' and body ->> 'subject' like '%annulée%'), 'Marc reçoit l''annulation';
  assert exists (select 1 from net.sent where body ->> 'subject' like 'Annulation par le client : Marc%'), 'la Nuba est prévenue';
  delete from net.sent;
end $$;

-- 7. L'état des rappels : pour le gérant seulement
set role authenticated;
set request.jwt.claims = :boss;
do $$ begin
  assert public.reminders_status() ->> 'scheduled' = 'false', 'sans pg_cron, pas de tâche planifiée : ' || public.reminders_status()::text;
  assert not public.schedule_booking_reminders(), 'sans pg_cron, le bouton répond non, sans erreur';
end $$;
set request.jwt.claims = :theo;
do $$ begin
  begin perform public.reminders_status(); raise exception 'TEST: un équipier lit l''état des rappels';
  exception when insufficient_privilege then null; end;
  begin perform public.schedule_booking_reminders(); raise exception 'TEST: un équipier planifie les rappels';
  exception when insufficient_privilege then null; end;
end $$;

-- Remise en état
reset role;
delete from public.reservations where day = (select d_wed from t_rz) or name = 'Passé';
delete from net.sent;
delete from public.email_outbox where true;
update public.booking_settings set review_from = null, capacity_per_slot = null where true;
update public.email_settings set enabled = false, sender_email = '' where true;
