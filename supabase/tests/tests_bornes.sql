-- Tests de la migration 0003 (relier une borne par code). Joués après tests.sql, sur la même base.
\set ON_ERROR_STOP on
\set boss '''{"sub":"00000000-0000-0000-0000-000000000001"}'''
\set ines '''{"sub":"00000000-0000-0000-0000-000000000005"}'''

-- 1. Le gérant crée une borne et reçoit un code ; une responsable ne peut pas
set role authenticated;
set request.jwt.claims = :boss;
create temp table t_pair as select public.add_kiosk((select id from public.sites limit 1), 'iPad cuisine') as r;
grant select, insert, update, delete on t_pair to anon, authenticated;
do $$ begin
  assert (select (r ->> 'code') ~ '^[0-9]{6}$' and (r ->> 'id') is not null from t_pair), 'la création doit donner un code à 6 chiffres';
end $$;
set request.jwt.claims = :ines;
do $$ begin
  begin
    perform public.add_kiosk((select id from public.sites limit 1), 'pirate');
    raise exception 'TEST: une responsable a pu créer une borne';
  exception when insufficient_privilege then null; end;
  begin
    perform public.start_kiosk_pairing((select (r ->> 'id')::uuid from t_pair));
    raise exception 'TEST: une responsable a pu obtenir un code de liaison';
  exception when insufficient_privilege then null; end;
end $$;

-- 2. L'appareil, sans compte, échange le code contre le jeton ; le code ne sert qu'une fois
set role anon;
set request.jwt.claims = '';
do $$
declare
  good text := (select r ->> 'code' from t_pair);
  bad  text := lpad(((good::int + 1) % 1000000)::text, 6, '0');
  c jsonb;
begin
  assert (public.claim_kiosk(bad)) ->> 'error' = 'code', 'un mauvais code doit être refusé';
  c := public.claim_kiosk(' ' || good || ' ');
  assert (c ->> 'ok')::boolean and (c ->> 'token') ~ '^[0-9a-f]{64}$' and c ->> 'label' = 'iPad cuisine', 'le bon code doit donner le jeton : ' || c::text;
  assert (public.kiosk_code(c ->> 'token')) ->> 'site_name' = 'La Nuba', 'le jeton obtenu doit afficher le code de pointage';
  assert (public.claim_kiosk(good)) ->> 'error' = 'code', 'un code ne sert qu''une fois';
  update t_pair set r = r || jsonb_build_object('token', c ->> 'token');
  begin
    perform public.start_kiosk_pairing((select (r ->> 'id')::uuid from t_pair));
    raise exception 'TEST: un visiteur anonyme a pu obtenir un code de liaison';
  exception when insufficient_privilege then null; end;
end $$;

-- 3. Relier un autre appareil remplace le premier
set role authenticated;
set request.jwt.claims = :boss;
update t_pair set r = r || jsonb_build_object('code2', public.start_kiosk_pairing((r ->> 'id')::uuid));
set role anon;
set request.jwt.claims = '';
do $$
declare c jsonb;
begin
  assert (public.kiosk_code((select r ->> 'token' from t_pair))) is not null, 'tant que le nouveau code n''est pas utilisé, le premier appareil marche encore';
  c := public.claim_kiosk((select r ->> 'code2' from t_pair));
  assert (c ->> 'ok')::boolean, 'le second appareil doit se relier';
  assert public.kiosk_code((select r ->> 'token' from t_pair)) is null, 'le premier appareil ne doit plus afficher le code de pointage';
  assert (public.kiosk_code(c ->> 'token')) is not null, 'le second appareil affiche le code de pointage';
end $$;

-- 4. Un code expiré ou celui d'une borne désactivée est refusé
set role authenticated;
set request.jwt.claims = :boss;
update t_pair set r = r || jsonb_build_object('code3', public.start_kiosk_pairing((r ->> 'id')::uuid));
reset role;
update public.kiosks set pair_expires_at = now() - interval '1 minute' where id = (select (r ->> 'id')::uuid from t_pair);
set role anon;
do $$ begin
  assert (public.claim_kiosk((select r ->> 'code3' from t_pair))) ->> 'error' = 'code', 'un code expiré doit être refusé';
end $$;
reset role;
update public.kiosks set pair_expires_at = now() + interval '5 minutes', revoked_at = now() where id = (select (r ->> 'id')::uuid from t_pair);
set role anon;
do $$ begin
  assert (public.claim_kiosk((select r ->> 'code3' from t_pair))) ->> 'error' = 'code', 'le code d''une borne désactivée doit être refusé';
end $$;

-- 5. Limitation des essais
reset role;
update public.kiosks set revoked_at = null where id = (select (r ->> 'id')::uuid from t_pair);
delete from public.kiosk_pair_failures;
set role anon;
do $$ begin
  for i in 1..20 loop perform public.claim_kiosk('abcdef'); end loop;
  assert (public.claim_kiosk((select r ->> 'code3' from t_pair))) ->> 'error' = 'too_many', 'vingt erreurs doivent bloquer les essais';
  begin
    perform * from public.kiosk_pair_failures;
    raise exception 'TEST: un visiteur anonyme a pu lire les essais';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
delete from public.kiosk_pair_failures;
update public.kiosks set revoked_at = now() where revoked_at is null;
