-- Tests de la migration 0028 : le dossier des salariés copié depuis le Drive. Noms et fichiers inventés.
\set ON_ERROR_STOP on
\set boss   '''{"sub":"00000000-0000-0000-0000-000000000001"}'''
\set theo   '''{"sub":"00000000-0000-0000-0000-000000000002"}'''
\set ines   '''{"sub":"00000000-0000-0000-0000-000000000005"}'''
\set compta '''{"sub":"00000000-0000-0000-0000-000000000017"}'''
reset role;
reset request.headers;
insert into auth.users (id, email, email_confirmed_at) values ('00000000-0000-0000-0000-000000000017', 'drive@compta.fr', now());
insert into public.accountants (email, name) values ('drive@compta.fr', 'Cabinet drive');
update public.profiles set active = true where email in ('theo@nuba.fr', 'ines@nuba.fr');
delete from public.drive_files where true;
delete from public.drive_tickets where true;
update public.merc_sync set key_hash = sha256(convert_to('cle_drive', 'UTF8')), created_at = now() where id;
insert into storage.buckets (id, name, public) values ('staff-docs', 'staff-docs', false) on conflict (id) do nothing;
create temp table t_drive as select (select id from public.profiles where email = 'theo@nuba.fr') as theo,
  (select id from public.profiles where email = 'ines@nuba.fr') as ines;
grant select on t_drive to anon, authenticated;
-- Inès a le lien de son dossier dans sa fiche ; Théo sera reconnu par son nom.
insert into public.profile_folders (profile_id, url) select ines, 'https://drive.google.com/drive/folders/DossierInes0001' from t_drive
  on conflict (profile_id) do update set url = excluded.url;

do $$ begin
  assert public._drive_mime('application/pdf') = 'application/pdf' and public._drive_mime('image/svg+xml') = 'application/octet-stream'
     and public._drive_mime(null) = 'application/octet-stream', 'types acceptés';
  assert public._drive_path('FichierTest01', '2026-11-20T10:00:00Z') = 'drive/FichierTest01/1795168800000', 'chemin d''une version';
end $$;

-- 1. Le script envoie la liste du Drive
set role anon;
set request.jwt.claims = '';
do $$
declare r jsonb;
begin
  assert public.drive_plan('mauvaise', '{}') ->> 'error' = 'key', 'clé refusée';
  assert public.drive_plan('cle_drive', '{"brand": "autre", "files": []}') ->> 'error' = 'payload', 'contenu illisible';
  r := public.drive_plan('cle_drive', '{"brand": "documents",
    "tops": [{"id": "DossierTheo0001", "name": "THÉO MARTIN"}, {"id": "DossierInes0001", "name": "Dossier d''Inès"},
             {"id": "DossierPresta01", "name": "PRESTATAIRE TEST (PRESTATAIRE)"}, {"id": "DossierFiches01", "name": "FICHES DE POSTE"}],
    "files": [
      {"id": "FichierDpae0001", "folder": ["THÉO MARTIN", "DPAE"], "name": "DPAE Théo.pdf", "mime": "application/pdf", "size": 1200, "modified": "2026-11-01T09:00:00.000Z"},
      {"id": "FichierPaie0001", "folder": ["THÉO MARTIN", "BULLETINS DE PAIE"], "name": "Paie octobre.pdf", "mime": "application/pdf", "size": 900, "modified": "2026-11-02T09:00:00.000Z"},
      {"id": "FichierIdent001", "folder": ["Dossier d''Inès", "PIECES D''IDENTITE"], "name": "Carte.jpg", "mime": "image/jpeg", "size": 500, "modified": "2026-11-03T09:00:00.000Z"},
      {"id": "FichierFiche001", "folder": ["FICHES DE POSTE"], "name": "Serveur.svg", "mime": "image/svg+xml", "size": 100, "modified": "2026-11-04T09:00:00.000Z"},
      {"id": "x", "folder": [], "name": "id illisible", "modified": "2026-11-04T09:00:00.000Z"}],
    "problems": ["Trop lourd pour l''appli (plus de 45 Mo) : FICHES DE POSTE / Vidéo.mp4"]}');
  assert (r ->> 'ok')::boolean and (r -> 'counts' ->> 'new')::int = 4 and jsonb_array_length(r -> 'upload') = 4 and jsonb_array_length(r -> 'remove') = 0,
    'premier envoi : ' || r::text;
end $$;
reset role;
do $$ begin
  assert (select count(*) from public.drive_files where profile_id = (select theo from t_drive)) = 2, 'Théo, reconnu par son nom';
  assert (select profile_id from public.drive_files where id = 'FichierIdent001') = (select ines from t_drive), 'Inès, par le lien de sa fiche';
  assert (select profile_id is null and mime = 'application/octet-stream' and folder = '{"FICHES DE POSTE"}' from public.drive_files where id = 'FichierFiche001'),
    'dossier commun, type inconnu rangé « à télécharger »';
  assert (select counts ->> 'pending' = '4' and problems ->> 0 like 'Trop lourd%' and synced_at is not null from public.drive_source), 'état noté';
end $$;

-- 2. Le script dépose, seulement ce qui lui est demandé
set role anon;
do $$ begin
  insert into storage.objects (bucket_id, name) values ('staff-docs', 'drive/FichierDpae0001/1793523600000');
  insert into storage.objects (bucket_id, name) values ('staff-docs', 'drive/FichierPaie0001/1793610000000');
  begin
    insert into storage.objects (bucket_id, name) values ('staff-docs', 'drive/FichierDpae0001/999');
    raise exception 'TEST: un dépôt sans autorisation est passé';
  exception when insufficient_privilege then null; end;
  begin
    insert into storage.objects (bucket_id, name) values ('staff-docs', (select theo from t_drive)::text || '/pirate.pdf');
    raise exception 'TEST: le script a déposé dans le dossier d''une personne';
  exception when insufficient_privilege then null; end;
end $$;
do $$
declare r jsonb;
begin
  assert public.drive_done('mauvaise', '[]') ->> 'error' = 'key', 'clé refusée';
  r := public.drive_done('cle_drive', '[{"id": "FichierDpae0001", "path": "drive/FichierDpae0001/1793523600000"},
                                         {"id": "FichierIdent001", "path": "drive/FichierIdent001/1793696400000"}]');
  assert (r ->> 'copied')::int = 1, 'seul un fichier réellement déposé compte : ' || r::text;
  assert jsonb_array_length(r -> 'remove') = 0, 'rien à retirer';
end $$;
reset role;
do $$ begin
  assert (select storage_path = 'drive/FichierDpae0001/1793523600000' and pending_path is null from public.drive_files where id = 'FichierDpae0001'), 'copie prête';
  -- La paie, déposée sans accusé de réception : le ménage la reconnaît.
  assert (select storage_path = 'drive/FichierPaie0001/1793610000000' and pending_path is null from public.drive_files where id = 'FichierPaie0001'), 'reprise';
  assert (select pending_path is not null from public.drive_files where id = 'FichierIdent001'), 'pas encore déposée : en attente';
end $$;

-- 3. Qui voit quoi
set role authenticated;
set request.jwt.claims = :theo;
do $$ begin
  assert (select count(*) from public.drive_files) = 0 and (select count(*) from public.drive_source) = 0, 'un équipier ne voit rien';
  assert (select count(*) from storage.objects where name like 'drive/%') = 0, 'ni les fichiers';
end $$;
set request.jwt.claims = :ines;
do $$ begin
  assert (select count(*) from public.drive_files) = 0, 'une responsable non plus, même pour son dossier';
end $$;
set request.jwt.claims = :compta;
do $$ begin
  assert public.accountant_me() is not null, 'la comptable est reconnue';
  assert (select count(*) from public.drive_files) = 4, 'la comptable voit tout le dossier';
  assert (select count(*) from storage.objects where name like 'drive/%') = 2, 'et télécharge les copies';
end $$;
set request.jwt.claims = :boss;
do $$ begin
  assert (select count(*) from public.drive_files) = 4 and (select folder_url from public.drive_source) = '', 'le gérant aussi';
  perform public.merc_new_key('', '', '', '', '', 'https://drive.google.com/drive/folders/RacineTest0001');
  assert (select folder_url from public.drive_source) = 'https://drive.google.com/drive/folders/RacineTest0001', 'lien du dossier enregistré';
  begin perform public.merc_new_key('', '', '', '', '', 'https://exemple.fr/dossier'); raise exception 'TEST: un lien hors Drive';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
end $$;
set request.jwt.claims = :theo;
do $$ begin
  begin perform public.merc_new_key('', '', '', '', '', ''); raise exception 'TEST: un équipier a changé le lien';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
update public.merc_sync set key_hash = sha256(convert_to('cle_drive', 'UTF8')), created_at = now() where id;

-- 4. Le Drive change : un fichier modifié, un retiré, la paie enfin confirmée
set role anon;
set request.jwt.claims = '';
do $$
declare r jsonb;
begin
  r := public.drive_plan('cle_drive', '{"brand": "documents", "tops": [{"id": "DossierTheo0001", "name": "THÉO MARTIN"}],
    "files": [
      {"id": "FichierDpae0001", "folder": ["THÉO MARTIN", "DPAE"], "name": "DPAE Théo (signée).pdf", "mime": "application/pdf", "modified": "2026-11-10T09:00:00.000Z"},
      {"id": "FichierPaie0001", "folder": ["THÉO MARTIN", "BULLETINS DE PAIE"], "name": "Paie octobre.pdf", "mime": "application/pdf", "modified": "2026-11-02T09:00:00.000Z"}]}');
  assert (r -> 'counts' ->> 'updated')::int = 1 and (r -> 'counts' ->> 'removed')::int = 2, 'second envoi : ' || r::text;
  assert r -> 'upload' = '[{"id": "FichierDpae0001", "mime": "application/pdf", "path": "drive/FichierDpae0001/1794301200000"}]'::jsonb,
    'seule la nouvelle version est à déposer : ' || (r -> 'upload')::text;
  assert r -> 'remove' = '[]'::jsonb, 'rien à retirer encore : ' || (r -> 'remove')::text;
  -- La nouvelle version arrive ; l'ancienne reste téléchargeable jusque-là.
  insert into storage.objects (bucket_id, name) values ('staff-docs', 'drive/FichierDpae0001/1794301200000');
  r := public.drive_done('cle_drive', '[{"id": "FichierDpae0001", "path": "drive/FichierDpae0001/1794301200000"}]');
  assert r -> 'remove' = '["drive/FichierDpae0001/1793523600000"]'::jsonb, 'l''ancienne version est à retirer : ' || r::text;
  assert (select count(*) from storage.objects where name = 'drive/FichierDpae0001/1793523600000') = 1, 'le script voit ce qu''il doit retirer';
  delete from storage.objects where name = 'drive/FichierDpae0001/1794301200000';
end $$;
reset role;
do $$ begin
  assert exists (select 1 from storage.objects where name = 'drive/FichierDpae0001/1794301200000'), 'la copie en service ne se retire pas';
  assert (select name = 'DPAE Théo (signée).pdf' and storage_path = 'drive/FichierDpae0001/1794301200000' from public.drive_files where id = 'FichierDpae0001'), 'nouvelle copie';
  assert (select storage_path = 'drive/FichierPaie0001/1793610000000' and pending_path is null from public.drive_files where id = 'FichierPaie0001'), 'la paie ne bouge pas';
  assert not exists (select 1 from public.drive_files where id in ('FichierIdent001', 'FichierFiche001')), 'les fichiers retirés du Drive sont retirés';
end $$;
set role anon;
do $$ begin
  delete from storage.objects where name = 'drive/FichierDpae0001/1793523600000';
end $$;
reset role;
do $$ begin
  assert not exists (select 1 from storage.objects where name = 'drive/FichierDpae0001/1793523600000'), 'ancienne version retirée par le script';
end $$;

-- 5. Un dossier vu vide ne vide pas l'appli (au-delà de quelques fichiers)
insert into public.drive_files (id, name, modified_at)
  select 'FichierVide' || lpad(i::text, 4, '0'), 'f' || i, now() from generate_series(1, 6) i;
set role anon;
do $$ begin
  assert public.drive_plan('cle_drive', '{"brand": "documents", "files": []}') ->> 'error' = 'empty', 'liste vide refusée';
end $$;
reset role;
do $$ begin
  assert (select count(*) from public.drive_files) = 8, 'rien retiré';
end $$;

-- Remise en état
reset role;
delete from public.drive_files where true;
delete from public.drive_tickets where true;
delete from storage.objects where name like 'drive/%';
delete from public.profile_folders where url like '%DossierInes0001';
delete from public.accountants where email = 'drive@compta.fr';
update public.drive_source set folder_url = '', synced_at = null, counts = '{}', problems = '[]' where id;
update public.merc_sync set key_hash = null, created_at = null where id;
