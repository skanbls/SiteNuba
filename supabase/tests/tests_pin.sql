-- Tests de la migration 0004 (iPad partagé, code PIN). Joués après tests.sql et tests_bornes.sql.
\set ON_ERROR_STOP on
\set boss  '''{"sub":"00000000-0000-0000-0000-000000000001"}'''
\set intru '''{"sub":"00000000-0000-0000-0000-000000000003"}'''
\set ines  '''{"sub":"00000000-0000-0000-0000-000000000005"}'''

-- Une borne reliée, et un extra sans adresse e-mail
set role authenticated;
set request.jwt.claims = :boss;
create temp table t_pin as select public.add_kiosk((select id from public.sites limit 1), 'iPad test PIN') as k, null::text as token, null::text as ticket;
grant select, update on t_pin to anon, authenticated;
insert into public.profiles (first_name, role, job, contract, email) values ('Hugo', 'equipier', 'Extra bar', 'extra', '  ');
do $$ begin
  assert (select email is null from public.profiles where first_name = 'Hugo'), 'une fiche sans e-mail doit être acceptée';
end $$;
set role anon;
set request.jwt.claims = '';
update t_pin set token = (public.claim_kiosk(k ->> 'code')) ->> 'token';

-- 1. Choisir un code PIN : règles et droits
set role authenticated;
set request.jwt.claims = :boss;
do $$
declare hugo uuid := (select id from public.profiles where first_name = 'Hugo'); ines uuid := (select id from public.profiles where email = 'ines@nuba.fr');
begin
  begin perform public.set_my_pin('12'); raise exception 'TEST: un code de 2 chiffres a été accepté';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
  begin perform public.set_my_pin('abcd'); raise exception 'TEST: un code en lettres a été accepté';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
  begin perform public.set_my_pin('0000'); raise exception 'TEST: 0000 a été accepté';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
  perform public.set_my_pin('9753');
  perform public.set_member_pin(hugo, '2580');
  perform public.set_member_pin(ines, '4321');
  assert (select count(*) from public.profiles where has_pin) = 3, 'has_pin doit suivre les codes donnés';
  perform public.set_member_pin(ines, null);
  assert not (select has_pin from public.profiles where id = ines), 'retirer un code doit se voir';
  perform public.set_member_pin(ines, '4321');
end $$;
set request.jwt.claims = :ines;
do $$
declare hugo uuid := (select id from public.profiles where first_name = 'Hugo');
begin
  begin perform public.set_member_pin(hugo, '7777'); raise exception 'TEST: une responsable a pu changer le code d''un autre';
  exception when insufficient_privilege then null; end;
  begin perform * from public.profile_pins; raise exception 'TEST: les codes PIN sont lisibles';
  exception when insufficient_privilege then null; end;
  begin perform * from public.kiosk_sessions; raise exception 'TEST: les sessions sont lisibles';
  exception when insufficient_privilege then null; end;
  begin perform public._pin_hash(hugo, '2580'); raise exception 'TEST: _pin_hash est appelable';
  exception when insufficient_privilege then null; end;
end $$;

-- 2. Sur la borne : la liste des prénoms, puis l'ouverture par code PIN
set role anon;
set request.jwt.claims = '';
do $$
declare
  tok text := (select token from t_pin);
  hugo uuid := (select (e ->> 'id')::uuid from jsonb_array_elements(public.kiosk_team((select token from t_pin))) e where e ->> 'first_name' = 'Hugo');
  r jsonb;
begin
  assert public.kiosk_team('mauvais') is null, 'sans jeton de borne, pas de liste';
  assert hugo is not null, 'la borne doit lister l''équipe active';
  assert (select count(*) from jsonb_array_elements(public.kiosk_team(tok)) e where e ->> 'first_name' = 'Théo') = 0, 'un membre désactivé ne doit pas apparaître';
  assert (public.kiosk_login('mauvais', hugo, '2580')) ->> 'error' = 'kiosk', 'pas d''ouverture sans borne valide';
  assert (public.kiosk_login(tok, hugo, '0000')) ->> 'error' = 'pin', 'un mauvais code doit être refusé';
  for i in 1..3 loop perform public.kiosk_login(tok, hugo, '0000'); end loop;
  assert (public.kiosk_login(tok, hugo, '0000')) ->> 'error' = 'locked', 'cinq erreurs doivent bloquer le code';
  assert (public.kiosk_login(tok, hugo, '2580')) ->> 'error' = 'locked', 'un code bloqué refuse même le bon code';
end $$;
reset role;
update public.profile_pins set locked_until = null, failures = 0;
set role anon;
do $$
declare
  tok text := (select token from t_pin);
  hugo uuid := (select id from public.profiles where false);
  r jsonb;
begin
  hugo := (select (e ->> 'id')::uuid from jsonb_array_elements(public.kiosk_team(tok)) e where e ->> 'first_name' = 'Hugo');
  r := public.kiosk_login(tok, hugo, '2580');
  assert (r ->> 'ok')::boolean and (r ->> 'ticket') ~ '^[0-9a-f]{64}$', 'le bon code doit ouvrir une session : ' || r::text;
  update t_pin set ticket = r ->> 'ticket';
  -- Sans ticket, rien n'est visible.
  assert (select count(*) from public.profiles) = 0 and (select count(*) from public.me()) = 0, 'sans ticket, rien ne doit être visible';
  assert not public.has_ticket_header(), 'aucun en-tête de ticket à ce stade';
end $$;

-- 3. Avec le ticket : les droits d'un équipier, pas plus
select set_config('request.headers', json_build_object('x-nuba-ticket', (select ticket from t_pin))::text, false) \gset ignore_
do $$
declare
  me public.profiles;
  n int;
begin
  assert public.has_ticket_header(), 'l''en-tête du ticket doit être vu';
  select * into me from public.me();
  assert me.first_name = 'Hugo' and me.role = 'equipier', 'la session doit être celle de Hugo, en équipier';
  assert public.my_profile_id() = me.id and not public.is_gerant() and not public.is_manager(), 'une session à code PIN n''est jamais gérant ni responsable';
  assert (select count(*) from public.profiles) > 1, 'la session voit l''équipe';
  assert (select count(*) from public.sites) > 0, 'la session voit les lieux';
  assert (select count(*) from public.time_entries) = 0, 'Hugo ne voit pas les pointages des autres';

  -- Pointer sur la borne
  assert ((public.punch_kiosk('in')) ->> 'ok')::boolean, 'arrivée sur la borne';
  assert (public.punch_kiosk('in')) ->> 'error' = 'already_in', 'pas de double arrivée';
  assert ((public.punch_break('start')) ->> 'ok')::boolean and ((public.punch_break('end')) ->> 'ok')::boolean, 'pause sur la borne';
  assert ((public.punch_kiosk('out')) ->> 'ok')::boolean, 'départ sur la borne';
  assert (select count(*) from public.time_entries where source = 'borne' and clock_out is not null and site_id is not null) = 1, 'le pointage doit être marqué « borne », avec son lieu';

  -- Demander un congé pour soi, pas pour un autre
  insert into public.leave_requests (profile_id, start_date, end_date) values (me.id, current_date + 3, current_date + 3);
  begin
    insert into public.leave_requests (profile_id, start_date, end_date) values ((select id from public.profiles where email = 'ines@nuba.fr'), current_date + 3, current_date + 3);
    raise exception 'TEST: une session a pu demander un congé pour quelqu''un d''autre';
  exception when insufficient_privilege then null; end;

  -- Rien du gérant
  begin insert into public.shifts (profile_id, starts_at, ends_at) values (me.id, now(), now() + interval '2 hours'); raise exception 'TEST: une session à code PIN a pu écrire le planning';
  exception when insufficient_privilege then null; end;
  begin perform public.save_time_entry(null, me.id, null, now() - interval '2 hours', now(), 0, ''); raise exception 'TEST: une session à code PIN a pu corriger un pointage';
  exception when insufficient_privilege then null; end;
  begin perform public.add_kiosk((select id from public.sites limit 1), 'x'); raise exception 'TEST: une session à code PIN a pu créer une borne';
  exception when insufficient_privilege then null; end;
  begin perform public.set_member_pin(me.id, '5555'); raise exception 'TEST: une session à code PIN a pu donner un code';
  exception when insufficient_privilege then null; end;
  begin update public.profiles set role = 'gerant' where id = me.id; raise exception 'TEST: une session à code PIN a pu modifier une fiche';
  exception when insufficient_privilege then null; end;
  begin perform public.punch(gen_random_uuid(), '000000', 'in'); raise exception 'TEST: punch est appelable sans compte';
  exception when insufficient_privilege then null; end;
  begin perform * from public.kiosks; raise exception 'TEST: une session à code PIN a pu lire les bornes';
  exception when insufficient_privilege then null; end;
end $$;
do $$ begin
  assert (select count(*) from public.time_entries where source = 'borne') = 1, 'le pointage sur la borne doit rester enregistré';
end $$;

-- 4. Un compte connecté passe avant le ticket ; un compte sans fiche n'hérite pas du ticket
set role authenticated;
set request.jwt.claims = :boss;
do $$ begin
  assert (select first_name from public.me()) = 'Sam' and public.is_gerant(), 'le compte connecté passe avant le ticket';
end $$;
set request.jwt.claims = :intru;
do $$ begin
  assert public.my_profile_id() is null and (select count(*) from public.me()) = 0, 'un compte sans fiche ne doit pas hériter du ticket';
  assert (select count(*) from public.profiles) = 0, 'un compte sans fiche ne voit rien, même avec un ticket';
end $$;

-- 5. Fin de session : « Terminer », expiration, borne désactivée, membre désactivé, nouveau code
set role anon;
set request.jwt.claims = '';
do $$ begin
  assert public.kiosk_keepalive(), 'la session se prolonge';
  perform public.kiosk_logout();
  assert (select count(*) from public.me()) = 0 and (select count(*) from public.profiles) = 0, 'après « Terminer », le ticket ne vaut plus rien';
  assert not public.kiosk_keepalive(), 'une session fermée ne se prolonge pas';
end $$;
do $$
declare
  tok text := (select token from t_pin);
  hugo uuid := (select (e ->> 'id')::uuid from jsonb_array_elements(public.kiosk_team((select token from t_pin))) e where e ->> 'first_name' = 'Hugo');
begin
  update t_pin set ticket = (public.kiosk_login(tok, hugo, '2580')) ->> 'ticket';
end $$;
select set_config('request.headers', json_build_object('x-nuba-ticket', (select ticket from t_pin))::text, false) \gset ignore_
do $$ begin assert (select count(*) from public.me()) = 1, 'nouvelle session ouverte'; end $$;
reset role;
update public.kiosk_sessions set expires_at = now() - interval '1 second';
set role anon;
do $$ begin assert (select count(*) from public.me()) = 0, 'une session expirée ne vaut plus rien'; end $$;
reset role;
update public.kiosk_sessions set expires_at = now() + interval '10 minutes';
update public.profiles set active = false where first_name = 'Hugo';
set role anon;
do $$ begin assert (select count(*) from public.me()) = 0, 'un membre désactivé perd sa session'; end $$;
reset role;
update public.profiles set active = true where first_name = 'Hugo';
update public.kiosks set revoked_at = now() where label = 'iPad test PIN';
set role anon;
do $$ begin assert (select count(*) from public.me()) = 0, 'une borne désactivée ferme ses sessions'; end $$;
reset role;
update public.kiosks set revoked_at = null where label = 'iPad test PIN';
set role authenticated;
set request.jwt.claims = :boss;
select public.set_member_pin((select id from public.profiles where first_name = 'Hugo'), '8642') \gset ignore_
set role anon;
set request.jwt.claims = '';
do $$ begin assert (select count(*) from public.me()) = 0, 'changer le code ferme les sessions ouvertes avec l''ancien'; end $$;

-- Ménage : les fichiers de tests suivants repartent d'un état connu.
reset role;
reset request.headers;
delete from public.leave_requests;
update public.kiosks set revoked_at = now() where revoked_at is null;
