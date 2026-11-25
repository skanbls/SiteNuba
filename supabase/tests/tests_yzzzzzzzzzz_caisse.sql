-- Tests de la migration 0026 : fermeture de caisse. Montants inventés.
\set ON_ERROR_STOP on
\set boss   '''{"sub":"00000000-0000-0000-0000-000000000001"}'''
\set theo   '''{"sub":"00000000-0000-0000-0000-000000000002"}'''
\set ines   '''{"sub":"00000000-0000-0000-0000-000000000005"}'''
\set compta '''{"sub":"00000000-0000-0000-0000-000000000016"}'''
reset role;
reset request.headers;
insert into auth.users (id, email, email_confirmed_at) values ('00000000-0000-0000-0000-000000000016', 'caisse@compta.fr', now());
insert into public.accountants (email, name) values ('caisse@compta.fr', 'Cabinet caisse');
update public.profiles set active = true where email in ('theo@nuba.fr', 'ines@nuba.fr');
delete from public.profile_rights where area = 'caisse';
delete from public.cash_closings where true;
update public.email_settings set enabled = true, sender_email = 'appli@nuba.fr', notify_email = 'boss@nuba.fr', notify_closing = true where true;
delete from public.email_outbox where kind = 'fermeture_caisse';
create temp table t_caisse as select public.service_day() as d;
grant select on t_caisse to anon, authenticated;

-- 0. Calculs
do $$ begin
  assert public._eur(1234.5) = '1 234,50 €' and public._eur(-2, true) = '-2,00 €' and public._eur(3, true) = '+3,00 €' and public._eur(0.5) = '0,50 €', 'montants en français';
  assert public._cash_total('{"5000": 4, "2000": 5, "1000": 3, "500": 1, "200": 1, "50": 1}') = 337.50, 'les coupures';
  assert public._cash_total('{"5000": 1, "333": 4, "abc": 2, "10": -3}') = 50.00, 'une coupure inconnue ou un nombre négatif ne compte pas';
  assert public._cash_total('{}') is null, 'rien de compté';
end $$;

-- 1. Théo ferme la caisse du jour
set role authenticated;
set request.jwt.claims = :theo;
do $$
declare
  r jsonb := public.cash_closing_get(null);
  c jsonb;
begin
  assert (r ->> 'day')::date = (select d from t_caisse) and r -> 'closing' = 'null'::jsonb and (r ->> 'can_edit')::boolean, 'rien encore : ' || r::text;
  -- Une photo du Z, avant la clôture.
  perform public.set_closing_photo(null, 'image/jpeg', 'QUJDRA==');
  assert public.closing_photo((select d from t_caisse)) ->> 'data' = 'QUJDRA==', 'il revoit la photo du jour';
  begin perform public.set_closing_photo(null, 'application/pdf', 'QUJD'); raise exception 'TEST: un PDF a été accepté';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
  r := public.save_cash_closing(null, '{"z_number": "Z-0042", "z_total": 1000, "z_covers": 40, "z_tickets": 31, "z_cash": 200, "z_card": 700, "z_meal": 100,
        "float_start": 150, "cash_counts": {"5000": 4, "2000": 5, "1000": 3, "500": 1, "200": 1, "50": 1},
        "expenses": [{"label": "Glaçons", "amount": 12.5}, {"label": "", "amount": 99}],
        "float_end": 150, "card_counted": 699, "meal_counted": 100}', false);
  c := r -> 'closing';
  assert c ->> 'status' = 'draft' and (c ->> 'cash_counted')::numeric = 337.50 and (c ->> 'expenses_total')::numeric = 12.50
     and (c ->> 'cash_expected')::numeric = 337.50 and (c ->> 'cash_gap')::numeric = 0 and (c ->> 'card_gap')::numeric = -1
     and (c ->> 'bank_deposit')::numeric = 187.50 and (c ->> 'has_photo')::boolean, 'brouillon calculé : ' || c::text;
  begin perform public.save_cash_closing(null, (r -> 'closing') || '{"card_counted": null}', true); raise exception 'TEST: clôture sans le terminal CB';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
  r := public.save_cash_closing(null, (r -> 'closing'), true);
  assert r -> 'closing' ->> 'status' = 'closed' and r ->> 'closed_by_name' = 'Théo' and not (r ->> 'can_edit')::boolean, 'clôturée : ' || r::text;
  begin perform public.save_cash_closing(null, '{"z_total": 1}', false); raise exception 'TEST: une caisse clôturée a été changée par un équipier';
  exception when insufficient_privilege then null; end;
  begin perform public.cash_closing_get((select d - 1 from t_caisse)); raise exception 'TEST: un équipier a ouvert un autre jour';
  exception when insufficient_privilege then null; end;
  assert (select count(*) from public.cash_closings) = 0, 'un équipier ne lit pas l''historique';
end $$;
reset role;
do $$ begin
  assert (select count(*) from public.email_outbox where kind = 'fermeture_caisse' and to_email = 'boss@nuba.fr'
          and subject like 'Caisse du % : 1 000,00 € TTC'
          and body like '%Caisse fermée par Théo.%40 couverts · ticket moyen 25,00 €%Écart espèces : 0,00 €%écart CB : -1,00 €%Remise en banque : 187,50 €%') = 1,
    'le gérant reçoit le récapitulatif : ' || coalesce((select body from public.email_outbox where kind = 'fermeture_caisse'), 'rien');
end $$;

-- 2. Le gérant corrige la veille ; un écart demande une explication
set role authenticated;
set request.jwt.claims = :boss;
do $$
declare
  y date := (select d - 1 from t_caisse);
  p jsonb := '{"z_total": 500, "z_cash": 100, "z_card": 400, "float_start": 150, "cash_counts": {"5000": 4, "1000": 4}, "float_end": 150, "card_counted": 400}';
begin
  begin perform public.save_cash_closing(y, p, true); raise exception 'TEST: un écart sans explication';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
  assert (public.save_cash_closing(y, p || '{"note": "Rendu de monnaie erroné"}', true) -> 'closing' ->> 'cash_gap')::numeric = -10, 'écart de -10 €';
  assert (select count(*) from public.cash_closings) = 2, 'le gérant lit l''historique';
  assert public.closing_photo((select d from t_caisse)) is not null, 'et les photos';
end $$;
reset role;
do $$ begin
  assert exists (select 1 from public.email_outbox where kind = 'fermeture_caisse' and subject like 'Écart de caisse, %'), 'l''objet signale l''écart';
end $$;

-- 3. Une responsable avec l'accès « Caisse » ; la comptable lit
insert into public.profile_rights (profile_id, area) select id, 'caisse' from public.profiles where email = 'ines@nuba.fr';
set role authenticated;
set request.jwt.claims = :ines;
do $$ begin
  assert (select count(*) from public.cash_closings) = 2, 'la responsable de la caisse lit l''historique';
  perform public.cash_closing_get((select d - 1 from t_caisse));
end $$;
set request.jwt.claims = :compta;
do $$ begin
  assert public.accountant_me() is not null, 'la comptable est reconnue';
  assert (select count(*) from public.cash_closings) = 2, 'la comptable lit les fermetures';
  assert public.closing_photo((select d from t_caisse)) is not null, 'et la photo du Z';
  begin perform public.save_cash_closing(null, '{}', false); raise exception 'TEST: la comptable a écrit une fermeture';
  exception when insufficient_privilege then null; end;
end $$;
set role anon;
set request.jwt.claims = '';
do $$ begin
  begin perform public.cash_closing_get(null); raise exception 'TEST: un inconnu a ouvert la caisse';
  exception when insufficient_privilege then null; end;
  begin perform public.closing_photo((select d from t_caisse)); raise exception 'TEST: un inconnu a vu le Z';
  exception when insufficient_privilege then null; end;
end $$;

-- 4. Les semaines terminées, pour « Saisie hebdo »
reset role;
delete from public.cash_closings where true;
update public.merc_sync set key_hash = sha256(convert_to('cle_caisse', 'UTF8')), created_at = now() where id;
insert into public.cash_closings (day, status, z_total, z_card, card_counted, z_covers)
  select date_trunc('week', (select d from t_caisse))::date - 7 + i, 'closed', 100 * (i + 1), 50, case when i = 0 then 60 end, 10
  from generate_series(0, 2) i;
insert into public.cash_closings (day, status, z_total, z_card, z_covers)
  values (date_trunc('week', (select d from t_caisse))::date - 14, 'draft', 999, 999, 99);
set role anon;
do $$
declare
  r jsonb := public.closings_weekly('cle_caisse');
  w jsonb;
begin
  assert public.closings_weekly('mauvaise') ->> 'error' = 'key', 'clé refusée';
  select e into w from jsonb_array_elements(r -> 'weeks') e where (e ->> 'week')::date = date_trunc('week', (select d from t_caisse))::date - 7;
  assert (w ->> 'ca_ttc')::numeric = 600 and (w ->> 'card')::numeric = 160 and (w ->> 'covers')::int = 30 and (w ->> 'days')::int = 3,
    'la semaine dernière : ' || coalesce(w::text, r::text);
  assert not exists (select 1 from jsonb_array_elements(r -> 'weeks') e where (e ->> 'week')::date >= date_trunc('week', (select d from t_caisse))::date),
    'pas la semaine en cours';
  assert not exists (select 1 from jsonb_array_elements(r -> 'weeks') e where (e ->> 'ca_ttc')::numeric = 999), 'pas un brouillon';
end $$;

-- Remise en état
reset role;
delete from public.cash_closings where true;
delete from public.profile_rights where area = 'caisse';
delete from public.accountants where email = 'caisse@compta.fr';
delete from public.email_outbox where kind = 'fermeture_caisse';
update public.merc_sync set key_hash = null, created_at = null where id;
update public.email_settings set enabled = false, sender_email = '' where true;
