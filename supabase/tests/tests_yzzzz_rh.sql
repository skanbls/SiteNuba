-- Tests de la migration 0020 : motifs d'absence, documents de l'équipe, récap comptable,
-- lien Zelty, cases de la liste de courses. Données inventées.
\set ON_ERROR_STOP on
\set boss   '''{"sub":"00000000-0000-0000-0000-000000000001"}'''
\set theo   '''{"sub":"00000000-0000-0000-0000-000000000002"}'''
\set ines   '''{"sub":"00000000-0000-0000-0000-000000000005"}'''
\set compta '''{"sub":"00000000-0000-0000-0000-000000000014"}'''
reset role;
reset request.headers;
insert into auth.users (id, email, email_confirmed_at) values ('00000000-0000-0000-0000-000000000014', 'rh@compta.fr', now());
insert into public.accountants (email, name) values ('rh@compta.fr', 'Cabinet RH');
update public.email_settings set enabled = true, sender_email = 'appli@nuba.fr', notify_email = 'boss@nuba.fr', notify_documents = true where id;
insert into vault.decrypted_secrets (name, decrypted_secret) values ('brevo_api_key', 'cle-de-test') on conflict (name) do nothing;
delete from net.sent;
create temp table t_rh (k text, v text);
grant select, insert, update, delete on t_rh to anon, authenticated;
insert into t_rh values ('theo', (select id::text from public.profiles where email = 'theo@nuba.fr')),
                        ('ines', (select id::text from public.profiles where email = 'ines@nuba.fr'));

-- 1. Motifs d'absence : la demande, la demi-journée, et le motif caché aux collègues
set role authenticated;
set request.jwt.claims = :theo;
do $$
declare me uuid := (select v::uuid from t_rh where k = 'theo');
begin
  insert into public.leave_requests (profile_id, start_date, end_date, reason) values (me, current_date + 10, current_date + 12, 'conges_payes');
  insert into public.leave_requests (profile_id, start_date, end_date, reason, part) values (me, current_date + 20, current_date + 20, 'evenement_familial', 'am');
  begin insert into public.leave_requests (profile_id, start_date, end_date, reason, part) values (me, current_date + 30, current_date + 31, 'conges_payes', 'pm');
    raise exception 'TEST: une demi-journée sur deux jours a été acceptée';
  exception when check_violation then null; end;
  begin insert into public.leave_requests (profile_id, start_date, end_date, reason) values (me, current_date, current_date, 'vacances_au_soleil');
    raise exception 'TEST: un motif inconnu a été accepté';
  exception when check_violation then null; end;
  begin insert into public.leave_requests (profile_id, start_date, end_date, reason, status) values (me, current_date, current_date, 'maladie', 'approved');
    raise exception 'TEST: un équipier a validé sa propre absence';
  exception when insufficient_privilege then null; end;
end $$;
set request.jwt.claims = :boss;
do $$ begin
  insert into public.leave_requests (profile_id, start_date, end_date, reason, status, decided_at)
    values ((select v::uuid from t_rh where k = 'ines'), current_date + 1, current_date + 3, 'enfant_malade', 'approved', now());
end $$;
set request.jwt.claims = :theo;
do $$ begin
  assert (select count(*) from public.leave_requests where profile_id = (select v::uuid from t_rh where k = 'ines')) = 0, 'un équipier ne lit pas le motif des absences des autres';
  assert exists (select 1 from jsonb_array_elements(public.team_absences(current_date)) a
                 where a ->> 'profile_id' = (select v from t_rh where k = 'ines') and not a ? 'reason'), 'mais il sait qu''Inès est absente';
  assert exists (select 1 from public.leave_requests where reason = 'evenement_familial' and part = 'am')
     and not exists (select 1 from public.leave_requests where profile_id <> (select v::uuid from t_rh where k = 'theo')), 'il lit les siennes, et seulement les siennes';
end $$;
set request.jwt.claims = :ines;
do $$ begin
  assert exists (select 1 from public.leave_requests where reason = 'evenement_familial'), 'une responsable lit les motifs de l''équipe';
end $$;

-- 2. Documents : chacun dépose dans son dossier, le gérant partout, personne d'autre
set request.jwt.claims = :theo;
do $$
declare me text := (select v from t_rh where k = 'theo');
begin
  insert into storage.objects (bucket_id, name, owner) values ('staff-docs', me || '/arret.pdf', auth.uid());
  insert into storage.objects (bucket_id, name, owner) values ('staff-docs', me || '/cni.jpg', auth.uid());
  begin insert into storage.objects (bucket_id, name, owner) values ('staff-docs', (select v from t_rh where k = 'ines') || '/faux.pdf', auth.uid());
    raise exception 'TEST: un équipier a déposé dans le dossier d''une autre';
  exception when insufficient_privilege then null; end;
  begin perform public.add_staff_document((select v::uuid from t_rh where k = 'ines'), 'autre', '', (select v from t_rh where k = 'ines') || '/x.pdf', 'x.pdf', 'application/pdf', 10, null, null, '');
    raise exception 'TEST: un équipier a enregistré un document pour une autre';
  exception when insufficient_privilege then null; end;
  begin perform public.add_staff_document(me::uuid, 'identite', '', me || '/absent.pdf', 'absent.pdf', 'application/pdf', 10, null, null, '');
    raise exception 'TEST: un document sans fichier a été enregistré';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
  begin perform public.add_staff_document(me::uuid, 'arret', '', me || '/arret.pdf', 'arret.pdf', 'application/pdf', 10, null, null, '');
    raise exception 'TEST: un arrêt sans date a été accepté';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
  perform public.add_staff_document(me::uuid, 'arret', 'Arrêt', me || '/arret.pdf', 'arret.pdf', 'application/pdf', 1000,
                                    current_date + 40, current_date + 44, 'Envoyé du téléphone');
  perform public.add_staff_document(me::uuid, 'identite', 'Carte d''identité', me || '/cni.jpg', 'cni.jpg', 'image/jpeg', 2000, null, null, '');
  assert (select count(*) from public.staff_documents) = 2, 'il voit ses deux documents';
  assert exists (select 1 from public.leave_requests where reason = 'maladie' and status = 'approved'
                 and start_date = current_date + 40 and end_date = current_date + 44 and document_id is not null), 'l''arrêt est une absence maladie du planning';
  begin delete from public.staff_documents where true; exception when insufficient_privilege then null; end;
  assert (select count(*) from public.staff_documents) = 2, 'il ne supprime pas ce qu''il a envoyé';
end $$;
reset role;
do $$ begin
  -- La file d'envoi : le faux service d'envoi du banc peut être « en panne », l'e-mail est quand même noté.
  assert (select count(*) from public.email_outbox where kind = 'document' and to_email = 'rh@compta.fr') = 2, 'la comptable reçoit un e-mail par document';
  assert (select count(*) from public.email_outbox where kind = 'document' and to_email = 'boss@nuba.fr') = 1, 'le gérant est prévenu de l''arrêt';
  assert not exists (select 1 from public.email_outbox where kind = 'document' and body like '%Envoyé du téléphone%'), 'la note ne part pas par e-mail';
  assert (select subject from public.email_outbox where kind = 'document' and to_email = 'rh@compta.fr' limit 1) = 'Nouveau document : Théo Martin', 'objet de l''e-mail';
end $$;

-- Une responsable et les collègues ne voient ni les fiches ni les fichiers
set role authenticated;
set request.jwt.claims = :ines;
do $$ begin
  assert (select count(*) from public.staff_documents) = 0, 'une responsable ne lit pas les documents des autres';
  assert (select count(*) from storage.objects where bucket_id = 'staff-docs') = 0, 'ni leurs fichiers';
  begin perform public.team_documents(); raise exception 'TEST: une responsable a lu tous les documents';
  exception when insufficient_privilege then null; end;
end $$;

-- Le gérant voit tout, dépose pour quelqu'un, supprime
set request.jwt.claims = :boss;
do $$
declare d jsonb;
begin
  insert into storage.objects (bucket_id, name, owner) values ('staff-docs', (select v from t_rh where k = 'theo') || '/dpae.pdf', auth.uid());
  perform public.add_staff_document((select v::uuid from t_rh where k = 'theo'), 'dpae', 'DPAE', (select v from t_rh where k = 'theo') || '/dpae.pdf', 'dpae.pdf', 'application/pdf', 500, null, null, '');
  d := public.team_documents();
  assert jsonb_array_length(d -> 'documents') = 3, 'le gérant voit les trois documents';
  assert exists (select 1 from jsonb_array_elements(d -> 'people') p where p ->> 'first_name' = 'Théo'), 'avec les noms';
  assert (select count(*) from storage.objects where bucket_id = 'staff-docs') = 3, 'et les fichiers';
end $$;

-- La comptable : tous les documents et les fichiers, sans pouvoir déposer
set request.jwt.claims = :compta;
do $$ begin
  assert public.accountant_me() is not null, 'la comptable est reconnue';
  assert (select count(*) from public.staff_documents) = 3, 'elle lit tous les documents';
  assert (select count(*) from storage.objects where bucket_id = 'staff-docs') = 3, 'et ouvre leurs fichiers';
  assert jsonb_array_length(public.team_documents() -> 'documents') = 3, 'avec les noms de chacun';
  begin insert into storage.objects (bucket_id, name) values ('staff-docs', (select v from t_rh where k = 'theo') || '/pirate.pdf');
    raise exception 'TEST: la comptable a déposé un fichier';
  exception when insufficient_privilege then null; end;
  begin perform public.add_staff_document((select v::uuid from t_rh where k = 'theo'), 'autre', '', 'x', 'x', '', 1, null, null, '');
    raise exception 'TEST: la comptable a enregistré un document';
  exception when insufficient_privilege then null; end;
end $$;

-- 3. Récap : heures et absences par motif, sans les notes
do $$
declare r jsonb := public.hours_report(current_date, current_date + 60);
begin
  assert exists (select 1 from jsonb_array_elements(r -> 'absences') a where a ->> 'reason' = 'maladie' and (a ->> 'document')::boolean), 'l''arrêt, avec son justificatif';
  assert exists (select 1 from jsonb_array_elements(r -> 'absences') a where a ->> 'reason' = 'enfant_malade'), 'les absences saisies par le gérant';
  assert not exists (select 1 from jsonb_array_elements(r -> 'absences') a where a ->> 'reason' = 'conges_payes'), 'pas les demandes en attente';
  assert not exists (select 1 from jsonb_array_elements(r -> 'absences') a where a ? 'note'), 'sans les notes';
end $$;

-- 4. Lien Zelty : le gérant le règle, la comptable le lit, pas l'équipe
set request.jwt.claims = :boss;
update public.accounting_settings set zelty_url = 'https://zelty.exemple/tableau' where id;
do $$ begin
  begin update public.accounting_settings set zelty_url = 'javascript:alert(1)' where id; raise exception 'TEST: un lien dangereux a été accepté';
  exception when check_violation then null; end;
end $$;
set request.jwt.claims = :compta;
do $$ begin
  assert (select zelty_url from public.accounting_settings) = 'https://zelty.exemple/tableau', 'la comptable lit le lien Zelty';
  update public.accounting_settings set zelty_url = '' where id;
  assert (select zelty_url from public.accounting_settings) <> '', 'mais ne le modifie pas';
end $$;
set request.jwt.claims = :ines;
do $$ begin
  assert (select count(*) from public.accounting_settings) = 0, 'une responsable ne le lit pas';
end $$;

-- 5. Liste de courses : n'importe qui de l'équipe coche, y compris sur l'iPad (code PIN)
set request.jwt.claims = :theo;
do $$ begin
  perform public.check_shopping(current_date + 2, 'beurre|g', true);
  perform public.check_shopping(current_date + 2, 'beurre|g', true);
  perform public.check_shopping(current_date + 2, 'oeufs|piece', true);
  assert (select count(*) from public.shopping_checks where day = current_date + 2) = 2, 'deux cases cochées';
  perform public.check_shopping(current_date + 2, 'oeufs|piece', false);
  assert (select count(*) from public.shopping_checks where day = current_date + 2) = 1, 'une décochée';
  begin insert into public.shopping_checks (day, item) values (current_date, 'x'); raise exception 'TEST: une case écrite sans la fonction';
  exception when insufficient_privilege then null; end;
end $$;
set request.jwt.claims = :boss;
update t_rh set v = (public.add_kiosk((select id from public.sites limit 1), 'iPad courses')) ->> 'code' where k = 'theo';
set role anon;
set request.jwt.claims = '';
do $$
declare
  tok text := (public.claim_kiosk((select v from t_rh where k = 'theo'))) ->> 'token';
  ines uuid := (select (e ->> 'id')::uuid from jsonb_array_elements(public.kiosk_team(tok)) e where e ->> 'first_name' = 'Inès');
begin
  begin perform public.check_shopping(current_date + 2, 'sel|g', true); raise exception 'TEST: le public a coché la liste';
  exception when insufficient_privilege then null; end;
  update t_rh set v = (public.kiosk_login(tok, ines, '7391')) ->> 'ticket' where k = 'theo';
end $$;
select set_config('request.headers', json_build_object('x-nuba-ticket', (select v from t_rh where k = 'theo'))::text, false) \gset ignore_
do $$ begin
  perform public.check_shopping(current_date + 2, 'sel|g', true);
  assert (select count(*) from public.shopping_checks where day = current_date + 2) = 2, 'sur l''iPad aussi';
  assert jsonb_array_length(public.team_absences(current_date)) > 0, 'l''iPad sait qui est absent';
  begin perform count(*) from public.staff_documents; raise exception 'TEST: une session à code PIN a lu des documents';
  exception when insufficient_privilege then null; end;
  perform public.check_shopping(current_date + 2, '', false);
  assert (select count(*) from public.shopping_checks where day = current_date + 2) = 0, 'tout décocher';
end $$;
reset request.headers;

-- Remise en état
reset role;
delete from public.staff_documents where true;
delete from storage.objects where bucket_id = 'staff-docs';
delete from public.leave_requests where reason <> 'conges_payes' or start_date > current_date + 5;
delete from public.accountants;
update public.accounting_settings set zelty_url = '' where id;
update public.email_settings set enabled = false, sender_email = '', notify_email = '' where id;
delete from vault.decrypted_secrets where name = 'brevo_api_key';
delete from public.email_outbox where kind = 'document';
delete from net.sent;
update public.kiosks set revoked_at = now() where revoked_at is null;
