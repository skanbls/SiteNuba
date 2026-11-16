-- Tests de la migration 0001 sur une base locale (voir scripts/test-db.sh).
-- Chaque bloc échoue bruyamment si une règle de sécurité ou de pointage ne tient pas.
\set ON_ERROR_STOP on
\set boss  '''{"sub":"00000000-0000-0000-0000-000000000001"}'''
\set theo  '''{"sub":"00000000-0000-0000-0000-000000000002"}'''
\set intru '''{"sub":"00000000-0000-0000-0000-000000000003"}'''
\set flou  '''{"sub":"00000000-0000-0000-0000-000000000004"}'''
\set ines  '''{"sub":"00000000-0000-0000-0000-000000000005"}'''

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('00000000-0000-0000-0000-000000000001', 'Boss@Nuba.fr',        now(), '{"first_name":"Sam"}'),
  ('00000000-0000-0000-0000-000000000002', 'theo@nuba.fr',        now(), '{}'),
  ('00000000-0000-0000-0000-000000000003', 'intrus@ailleurs.fr',  now(), '{}'),
  ('00000000-0000-0000-0000-000000000004', 'pasconfirme@nuba.fr', null,  '{}'),
  ('00000000-0000-0000-0000-000000000005', 'ines@nuba.fr',        now(), '{}');

-- 1. Le premier compte devient gérant ----------------------------------
set role authenticated;
set request.jwt.claims = :boss;
do $$
declare p public.profiles;
begin
  select * into p from public.me();
  assert p.role = 'gerant' and p.first_name = 'Sam' and p.email = 'boss@nuba.fr', 'le premier compte doit devenir gérant';
  assert (select count(*) from public.me()) = 1, 'me() doit être stable';
end $$;

-- 2. Un inconnu ne voit rien et ne peut rien ----------------------------
set request.jwt.claims = :intru;
do $$
declare r jsonb; s uuid;
begin
  assert (select count(*) from public.me()) = 0, 'un inconnu ne doit pas obtenir de profil';
  assert (select count(*) from public.profiles) = 0, 'un inconnu ne doit pas lire l''équipe';
  assert (select count(*) from public.sites) = 0, 'un inconnu ne doit pas lire les lieux';
  assert (select count(*) from public.time_entries) = 0, 'un inconnu ne doit pas lire les pointages';
  r := public.punch(gen_random_uuid(), '000000', 'in');
  assert r ->> 'error' = 'no_profile', 'un inconnu ne doit pas pointer';
end $$;

-- 3. Le gérant compose l'équipe -----------------------------------------
set request.jwt.claims = :boss;
insert into public.profiles (email, first_name, last_name, role, job, weekly_hours) values
  ('  Theo@Nuba.FR ', ' Théo ', 'Martin', 'equipier', 'Serveur', 30),
  ('ines@nuba.fr', 'Inès', 'Durand', 'responsable', 'Responsable salle', 35),
  ('pasconfirme@nuba.fr', 'Flou', '', 'equipier', '', 35);
do $$
begin
  assert exists (select 1 from public.profiles where email = 'theo@nuba.fr' and first_name = 'Théo'), 'e-mail et prénom doivent être normalisés';
  begin
    update public.profiles set role = 'equipier' where email = 'boss@nuba.fr';
    raise exception 'TEST: le dernier gérant a pu se rétrograder';
  exception when sqlstate 'P0001' then
    if sqlerrm like 'TEST:%' then raise; end if;
  end;
end $$;

-- 4. Rattachement à l'inscription --------------------------------------
set request.jwt.claims = :theo;
do $$
declare p public.profiles;
begin
  select * into p from public.me();
  assert p.first_name = 'Théo' and p.role = 'equipier', 'Théo doit être rattaché à sa fiche';
  assert (select count(*) from public.profiles) = 4, 'un membre doit voir l''équipe';
end $$;
set request.jwt.claims = :flou;
do $$ begin
  assert (select count(*) from public.me()) = 0, 'une adresse non confirmée ne doit pas être rattachée';
end $$;
set request.jwt.claims = :ines;
do $$ begin
  assert (select role from public.me()) = 'responsable', 'Inès doit être responsable';
end $$;

-- 5. Un équipier ne peut ni modifier l'équipe ni toucher aux secrets -----
set request.jwt.claims = :theo;
do $$
declare n int; site uuid := (select id from public.sites limit 1);
begin
  begin
    insert into public.profiles (email, first_name) values ('x@x.fr', 'X');
    raise exception 'TEST: un équipier a pu ajouter un profil';
  exception when insufficient_privilege then null; end;

  update public.profiles set role = 'gerant' where email = 'theo@nuba.fr';
  get diagnostics n = row_count;
  assert n = 0, 'un équipier ne doit pas pouvoir se promouvoir';

  begin
    perform * from public.site_secrets;
    raise exception 'TEST: un équipier a pu lire les secrets';
  exception when insufficient_privilege then null; end;

  begin
    perform public._site_code(site, 1);
    raise exception 'TEST: un équipier a pu appeler _site_code';
  exception when insufficient_privilege then null; end;

  begin
    perform public.site_code(site);
    raise exception 'TEST: un équipier a pu afficher le code du lieu';
  exception when insufficient_privilege then null; end;

  begin
    perform public.create_kiosk(site, 'pirate');
    raise exception 'TEST: un équipier a pu créer une borne';
  exception when insufficient_privilege then null; end;

  assert (select count(*) from public.kiosks) = 0, 'un équipier ne doit pas lire les bornes';
end $$;

-- 6. Borne : le jeton donne le code, sans compte ------------------------
set request.jwt.claims = :boss;
create temp table t_kiosk as select public.create_kiosk((select id from public.sites limit 1), 'iPad bar') as token;
grant select on t_kiosk to anon, authenticated;
set role anon;
set request.jwt.claims = '';
do $$
declare r jsonb;
begin
  r := public.kiosk_code((select token from t_kiosk));
  assert r ->> 'site_name' = 'La Nuba' and (r ->> 'code') ~ '^[0-9]{6}$', 'la borne doit recevoir un code à 6 chiffres';
  assert (r ->> 'seconds_left')::int between 1 and 30, 'durée restante incohérente';
  assert public.kiosk_code('mauvais-jeton') is null, 'un mauvais jeton ne doit rien donner';
  assert (select count(*) from public.profiles) = 0, 'un visiteur anonyme ne doit pas lire l''équipe';
  assert (select count(*) from public.time_entries) = 0, 'un visiteur anonyme ne doit pas lire les pointages';
  begin
    perform public.punch(gen_random_uuid(), '000000', 'in');
    raise exception 'TEST: un visiteur anonyme a pu appeler punch';
  exception when insufficient_privilege then null; end;
end $$;

-- 7. Pointage : arrivée, pause, départ ----------------------------------
set role authenticated;
set request.jwt.claims = :theo;
do $$
declare
  site uuid := (select id from public.sites limit 1);
  good text := public.kiosk_code((select token from t_kiosk)) ->> 'code';
  bad  text := lpad(((good::int + 1) % 1000000)::text, 6, '0');
  r jsonb;
begin
  r := public.punch(site, bad, 'in');
  assert r ->> 'error' = 'code', 'un mauvais code doit être refusé';
  r := public.punch(site, good, 'out');
  assert r ->> 'error' = 'not_in', 'pas de départ sans arrivée';
  r := public.punch(site, good, 'in');
  assert (r ->> 'ok')::boolean and r ->> 'action' = 'in', 'l''arrivée doit passer : ' || r::text;
  r := public.punch(site, good, 'in');
  assert r ->> 'error' = 'already_in', 'pas de double arrivée';
  assert (public.punch_break('end')) ->> 'error' = 'not_paused', 'pas de fin de pause sans pause';
  assert ((public.punch_break('start')) ->> 'ok')::boolean, 'début de pause';
  assert (public.punch_break('start')) ->> 'error' = 'already_paused', 'pas de double pause';
  r := public.punch(site, good, 'out');
  assert (r ->> 'ok')::boolean and r ->> 'action' = 'out', 'le départ doit passer';
  assert (select count(*) from public.time_entries where clock_out is not null) = 1, 'la présence doit être fermée';
  assert (select count(*) from public.time_breaks where ended_at is null) = 0, 'le départ doit fermer la pause';

  begin
    update public.time_entries set clock_in = clock_in - interval '1 hour';
    raise exception 'TEST: un équipier a pu modifier ses pointages';
  exception when insufficient_privilege then null; end;
  delete from public.time_entries;
  get diagnostics r = row_count;
  assert r::int = 0, 'un équipier ne doit pas supprimer ses pointages';
end $$;

-- 8. Limitation des essais ---------------------------------------------
do $$
declare
  site uuid := (select id from public.sites limit 1);
  good text := public.kiosk_code((select token from t_kiosk)) ->> 'code';
  bad  text := lpad(((good::int + 1) % 1000000)::text, 6, '0');
begin
  for i in 1..8 loop perform public.punch(site, bad, 'in'); end loop;
  assert (public.punch(site, good, 'in')) ->> 'error' = 'too_many', 'huit erreurs doivent bloquer les essais';
end $$;
reset role;
delete from public.punch_failures;

-- 9. Départ oublié ------------------------------------------------------
set role authenticated;
set request.jwt.claims = :theo;
do $$
declare
  site uuid := (select id from public.sites limit 1);
  good text := public.kiosk_code((select token from t_kiosk)) ->> 'code';
begin
  assert ((public.punch(site, good, 'in')) ->> 'ok')::boolean, 'nouvelle arrivée';
end $$;
reset role;
set nuba.via_punch = '1';
update public.time_entries set clock_in = now() - interval '20 hours' where clock_out is null;
reset nuba.via_punch;
set role authenticated;
do $$
declare
  site uuid := (select id from public.sites limit 1);
  good text := public.kiosk_code((select token from t_kiosk)) ->> 'code';
  r jsonb;
begin
  r := public.punch(site, good, 'in');
  assert (r ->> 'ok')::boolean, 'l''arrivée doit passer malgré le départ oublié : ' || r::text;
  assert (select count(*) from public.time_entries where needs_review and clock_out = clock_in) = 1, 'le départ oublié doit être signalé';
  assert (select count(*) from public.time_entries where clock_out is null) = 1, 'une seule présence ouverte';
end $$;

-- 10. Qui voit quoi, corrections et journal -----------------------------
do $$ begin
  assert (select count(*) from public.time_entries) = 3, 'Théo voit ses 3 pointages';
  assert (select count(*) from public.time_entry_audit) = 0, 'un équipier ne lit pas le journal';
end $$;
set request.jwt.claims = :ines;
do $$
declare n int;
begin
  assert (select count(*) from public.time_entries) = 3, 'une responsable voit les pointages de l''équipe';
  assert (select count(*) from public.time_breaks) = 1, 'une responsable voit les pauses';
  assert (public.site_code((select id from public.sites limit 1)) ->> 'code') ~ '^[0-9]{6}$', 'une responsable peut afficher le code';
  delete from public.time_entries;
  get diagnostics n = row_count;
  assert n = 0, 'une responsable ne supprime pas de pointage';
  begin
    perform public.save_time_entry(null, (select id from public.profiles where email = 'theo@nuba.fr'), null, now() - interval '3 hours', now(), 0, '');
    raise exception 'TEST: une responsable a pu corriger un pointage';
  exception when insufficient_privilege then null; end;
end $$;
set request.jwt.claims = :boss;
do $$
declare
  theo uuid := (select id from public.profiles where email = 'theo@nuba.fr');
  flagged uuid := (select id from public.time_entries where needs_review);
  v uuid;
begin
  assert (select count(*) from public.time_entry_audit) = 0, 'les pointages normaux ne sont pas des corrections';
  perform public.save_time_entry(flagged, theo, (select id from public.sites limit 1), now() - interval '20 hours', now() - interval '13 hours', 30, 'Départ corrigé');
  assert (select not needs_review and note = 'Départ corrigé' from public.time_entries where id = flagged), 'la correction doit lever le signalement';
  assert (select extract(epoch from sum(ended_at - started_at)) / 60 from public.time_breaks where entry_id = flagged) = 30, 'la pause corrigée doit faire 30 min';
  v := public.save_time_entry(null, theo, null, now() - interval '3 days', now() - interval '3 days' + interval '6 hours', 0, 'Oubli de pointage');
  assert (select source from public.time_entries where id = v) = 'manuel', 'un ajout du gérant est marqué manuel';
  begin
    perform public.save_time_entry(null, theo, null, now(), now() - interval '1 hour', 0, '');
    raise exception 'TEST: un départ avant l''arrivée a été accepté';
  exception when sqlstate 'P0001' then
    if sqlerrm like 'TEST:%' then raise; end if;
  end;
  delete from public.time_entries where id = v;
  assert (select count(*) from public.time_entry_audit) = 3, 'correction, ajout et suppression doivent être journalisés';
  assert (select count(*) from public.time_entry_audit where changed_by is null) = 0, 'le journal doit nommer l''auteur';
end $$;

-- 11. Révocation d'une borne et désactivation d'un membre ----------------
update public.kiosks set revoked_at = now();
update public.profiles set active = false where email = 'theo@nuba.fr';
set request.jwt.claims = :theo;
do $$ begin
  assert public.kiosk_code((select token from t_kiosk)) is null, 'une borne révoquée ne donne plus de code';
  assert (select count(*) from public.profiles) = 0, 'un membre désactivé ne lit plus l''équipe';
  assert (select count(*) from public.time_entries) = 0, 'un membre désactivé ne lit plus les pointages';
end $$;
reset role;
