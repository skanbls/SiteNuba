-- Tests de la migration 0018 (en-tête des bons de livraison).
\set ON_ERROR_STOP on
\set boss   '''{"sub":"00000000-0000-0000-0000-000000000001"}'''
\set theo   '''{"sub":"00000000-0000-0000-0000-000000000002"}'''
\set ines   '''{"sub":"00000000-0000-0000-0000-000000000005"}'''
\set compta '''{"sub":"00000000-0000-0000-0000-000000000012"}'''
reset role;
reset request.headers;
insert into auth.users (id, email, email_confirmed_at) values ('00000000-0000-0000-0000-000000000012', 'bl@compta.fr', now());
insert into public.accountants (email, name) values ('bl@compta.fr', 'Cabinet');
create temp table t_bl (v text);
grant select, update, insert on t_bl to anon, authenticated;
do $$ begin
  assert (select count(*) from public.delivery_settings) = 1 and (select dlc_days = 3 and lot_days_before = 1 from public.delivery_settings), 'une seule ligne, DLC à 3 jours, lot de la veille';
end $$;

-- 1. Le public ne lit rien et ne modifie rien
set role anon;
set request.jwt.claims = '';
do $$ begin
  assert (select count(*) from public.delivery_settings) = 0, 'le public ne lit pas l''en-tête';
  begin update public.delivery_settings set sender_name = 'Pirate' where id; raise exception 'TEST: le public a modifié l''en-tête';
  exception when insufficient_privilege then null; end;
end $$;

-- 2. Le gérant remplit l'en-tête
set role authenticated;
set request.jwt.claims = :boss;
do $$ begin
  update public.delivery_settings set sender_name = '  Société test ', client_name = 'Client test', slot = ' 06h30 ', driver = 'Sam', dlc_days = 4 where id;
  assert (select sender_name = 'Société test' and slot = '06h30' and dlc_days = 4 from public.delivery_settings), 'enregistré et nettoyé';
  assert (select updated_by = (select id from public.profiles where email = 'boss@nuba.fr') and updated_at is not null from public.delivery_settings), 'signé par le gérant';
  begin update public.delivery_settings set dlc_days = 99 where id; raise exception 'TEST: une DLC de 99 jours a été acceptée';
  exception when check_violation then null; end;
  begin insert into public.delivery_settings (id) values (false); raise exception 'TEST: une deuxième ligne a été créée';
  exception when insufficient_privilege then null; end;
  begin delete from public.delivery_settings where id; raise exception 'TEST: l''en-tête a été supprimé';
  exception when insufficient_privilege then null; end;
end $$;

-- 3. L'équipe lit l'en-tête pour imprimer, sans le modifier, responsables comprises
set request.jwt.claims = :theo;
do $$ begin
  assert (select sender_name from public.delivery_settings) = 'Société test', 'un équipier lit l''en-tête';
  update public.delivery_settings set sender_name = 'Pas moi' where id;
  assert (select sender_name from public.delivery_settings) = 'Société test', 'un équipier ne le modifie pas';
end $$;
set request.jwt.claims = :ines;
do $$ begin
  update public.delivery_settings set client_name = 'Pas moi' where id;
  assert (select client_name from public.delivery_settings) = 'Client test', 'une responsable ne le modifie pas';
end $$;

-- 4. Code PIN (iPad) : lecture seulement
set request.jwt.claims = :boss;
update t_bl set v = null;
insert into t_bl values ((public.add_kiosk((select id from public.sites limit 1), 'iPad bons de livraison')) ->> 'code');
set role anon;
set request.jwt.claims = '';
do $$
declare
  tok text := (public.claim_kiosk((select v from t_bl where v is not null limit 1))) ->> 'token';
  ines uuid := (select (e ->> 'id')::uuid from jsonb_array_elements(public.kiosk_team(tok)) e where e ->> 'first_name' = 'Inès');
begin
  update t_bl set v = (public.kiosk_login(tok, ines, '7391')) ->> 'ticket' where v is not null;
end $$;
select set_config('request.headers', json_build_object('x-nuba-ticket', (select v from t_bl where v is not null limit 1))::text, false) \gset ignore_
do $$ begin
  assert public.my_profile_id() is not null, 'session à code PIN ouverte';
  assert (select slot from public.delivery_settings) = '06h30', 'la session à code PIN lit l''en-tête';
  begin update public.delivery_settings set slot = '05h00' where id; raise exception 'TEST: une session à code PIN a modifié l''en-tête';
  exception when insufficient_privilege then null; end;
end $$;
reset request.headers;

-- 5. La comptable ne le lit pas
set role authenticated;
set request.jwt.claims = :compta;
do $$ begin
  assert public.accountant_me() is not null and (select count(*) from public.delivery_settings) = 0, 'la comptable ne lit pas l''en-tête';
end $$;

-- Remise en état
reset role;
update public.delivery_settings set sender_name = '', client_name = '', slot = '', driver = '', dlc_days = 3 where id;
delete from public.accountants;
update public.kiosks set revoked_at = now() where revoked_at is null;
