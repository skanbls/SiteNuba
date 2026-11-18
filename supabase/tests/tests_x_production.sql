-- Tests de la migration 0011 (mercuriales synchronisées). Joués en dernier.
\set ON_ERROR_STOP on
\set boss  '''{"sub":"00000000-0000-0000-0000-000000000001"}'''
\set theo  '''{"sub":"00000000-0000-0000-0000-000000000002"}'''
\set ines  '''{"sub":"00000000-0000-0000-0000-000000000005"}'''
reset role;
reset request.headers;
create temp table t_prod (k text, payload jsonb);
grant select, update on t_prod to anon, authenticated;
-- Une mercuriale Saveurs Nomades réduite, au format envoyé par le script Google.
insert into t_prod (payload) values ($json${
  "brand": "saveurs_nomades", "file": "MERCURIALE SAVEURS NOMADES",
  "ingredients": [
    {"name": "Patate douce", "category": "FRUITS / LEGUMES", "supplier": "Primeur", "purchase_price": 2, "purchase_unit": "kg", "piece_weight": "", "recipe_unit_price": 0.002, "recipe_unit": "g"},
    {"name": "Beurre", "category": "CREMERIE", "supplier": "Metro", "purchase_price": "6,40", "purchase_unit": "kg", "recipe_unit_price": 0.0064, "recipe_unit": "g", "allergens": "Lait"},
    {"name": "Cuisse de poulet s/os", "supplier": "Boucherie", "purchase_price": 7.2, "purchase_unit": "kg", "recipe_unit_price": 0.0072, "recipe_unit": "g"},
    {"name": "Oeufs", "supplier": "Metro", "purchase_price": 0.272, "purchase_unit": "pièce", "recipe_unit_price": 0.272, "recipe_unit": "pièce"},
    {"name": "Persil", "supplier": "Metro", "purchase_price": 0.9, "purchase_unit": "pièce", "piece_weight": 50, "recipe_unit_price": 0.018, "recipe_unit": "g"}
  ],
  "recipes": [
    {"name": "Purée de patate douce", "category": "BASE", "portions": 1, "portion_weight": 245, "cost_portion": 0.61, "cost_portion_losses": 0.75, "status": "OK", "label": "Patate douce, Beurre, Sel", "allergens": "Lait"},
    {"name": "Poulet Moutarde Miel (Mariné)", "category": "PROTEINE", "portions": 1, "cost_portion": 0.95, "status": "OK"},
    {"name": "Brownie", "category": "Dessert", "portions": "10", "cost_portion": 0.7, "sale_price": 1.8, "cost_pct": 0.411, "status": "OK"},
    {"name": "", "category": "vide"}
  ],
  "lines": [
    {"recipe": "Purée de patate douce", "ingredient": "Patate douce", "quantity": 200, "unit": "g", "supplier": "Primeur", "loss": 0.25},
    {"recipe": "Purée de patate douce", "ingredient": "Beurre", "quantity": "15", "unit": "g", "supplier": "Metro", "allergens": "Lait", "loss": "0,05"},
    {"recipe": "Poulet Moutarde Miel (Mariné)", "ingredient": "Cuisse de poulet s/os", "quantity": 118, "unit": "g", "supplier": "Boucherie", "loss": 0.05},
    {"recipe": "Brownie", "ingredient": "Oeufs", "quantity": 5, "unit": "pièce", "supplier": "Metro", "loss": 0.05},
    {"recipe": "Brownie", "ingredient": "Beurre", "quantity": 200, "unit": "g", "loss": 0.05},
    {"recipe": "Fiche oubliée", "ingredient": "Persil", "quantity": 20, "unit": "g"},
    {"recipe": "Brownie", "ingredient": "Ligne vide", "quantity": 0},
    {"recipe": "", "ingredient": "Sans recette", "quantity": 3}
  ],
  "roles": [
    {"recipe": "Purée de patate douce", "role": "BASE"},
    {"recipe": "poulet moutarde miel (mariné)", "role": "Protéine"}
  ],
  "orders": [
    {"day": "2026-11-18", "formula": "Sur mesure", "dish": "Purée de patate douce + Poulet Moutarde Miel (Mariné)", "portions": 120, "check": "OK", "factor_base": 0.85, "factor_protein": "0,72", "factor_vegetable": 0, "factor_sauce": ""},
    {"day": "18/11/2026", "formula": "Dessert", "dish": "Brownie", "portions": "80", "check": "OK"},
    {"day": "", "dish": "Sans date", "portions": 10},
    {"day": "2026-11-25", "dish": "Brownie", "portions": 0}
  ]
}$json$::jsonb);

-- 1. Sans clé, rien ne passe
set role anon;
set request.jwt.claims = '';
do $$ begin
  assert (public.sync_mercuriale('', (select payload from t_prod))) ->> 'error' = 'key', 'sans clé, refusé';
  assert (public.sync_mercuriale('nuba_au_hasard', (select payload from t_prod))) ->> 'error' = 'key', 'une clé inventée est refusée';
  begin perform public.merc_new_key('', ''); raise exception 'TEST: le public a créé une clé';
  exception when insufficient_privilege then null; end;
  assert (select count(*) from public.merc_recipes) = 0 and (select count(*) from public.merc_sources) = 0, 'le public ne lit rien';
end $$;

-- 2. Seul le gérant crée la clé
set role authenticated;
set request.jwt.claims = :theo;
do $$ begin
  begin perform public.merc_new_key('', ''); raise exception 'TEST: un équipier a créé une clé';
  exception when insufficient_privilege then null; end;
  begin perform public.merc_status(); raise exception 'TEST: un équipier a lu l''état de la synchronisation';
  exception when insufficient_privilege then null; end;
end $$;
set request.jwt.claims = :ines;
do $$ begin
  begin perform public.merc_new_key('', ''); raise exception 'TEST: une responsable a créé une clé';
  exception when insufficient_privilege then null; end;
end $$;
set request.jwt.claims = :boss;
do $$ begin
  begin perform public.merc_new_key('https://exemple.fr/feuille', ''); raise exception 'TEST: une adresse qui n''est pas une feuille Google a été acceptée';
  exception when check_violation then null; end;
end $$;
update t_prod set k = public.merc_new_key('https://docs.google.com/spreadsheets/d/AbC_123-x/edit#gid=0', '');
do $$ begin
  assert (select k from t_prod) ~ '^nuba_[0-9a-f]{64}$', 'clé : ' || (select k from t_prod);
  assert (select sheet_url from public.merc_sources where brand = 'saveurs_nomades') like 'https://docs.google.com/spreadsheets/d/AbC_123-x%', 'le lien de la mercuriale est gardé';
  begin perform * from public.merc_sync_log; raise exception 'TEST: le journal est lisible directement';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
  assert (select count(*) from public.merc_sync_log where not ok) = 2, 'les clés refusées sont notées';
  assert (select key_hash <> convert_to((select k from t_prod), 'UTF8') from public.merc_sync), 'la clé n''est pas gardée en clair';
end $$;

-- 3. Le script envoie la mercuriale avec la clé
set role anon;
set request.jwt.claims = '';
do $$
declare r jsonb := public.sync_mercuriale((select k from t_prod), (select payload from t_prod));
begin
  assert (r ->> 'ok')::boolean, 'la synchronisation passe : ' || r::text;
  assert r -> 'counts' = '{"lines": 6, "orders": 2, "recipes": 3, "ingredients": 5}'::jsonb, 'comptes : ' || (r -> 'counts')::text;
  assert (public.sync_mercuriale((select k from t_prod), (select payload from t_prod) || '{"brand": "autre"}')) ->> 'error' = 'brand', 'marque inconnue refusée';
  assert (public.sync_mercuriale((select k from t_prod), (select payload from t_prod) - 'lines')) ->> 'error' = 'payload', 'contenu incomplet refusé';
end $$;
reset role;
do $$ begin
  assert (select portions = 10 and status = 'OK' and role = '' from public.merc_recipes where name = 'Brownie'), 'portions lues dans un texte';
  assert (select role from public.merc_recipes where name = 'Purée de patate douce') = 'BASE'
     and (select role from public.merc_recipes where name = 'Poulet Moutarde Miel (Mariné)') = 'PROTEINE', 'rôles du sur mesure, quelle que soit l''écriture';
  assert (select status from public.merc_recipes where name = 'Fiche oubliée') = 'Absente de RECETTES', 'une fiche absente de RECETTES est signalée';
  assert (select quantity = 15 and loss = 0.05 from public.merc_lines where recipe = 'Purée de patate douce' and ingredient = 'Beurre'), 'nombres à virgule';
  assert (select unit from public.merc_lines where ingredient = 'Oeufs') = 'pièce', 'unité gardée';
  assert (select day = '2026-11-18' and portions = 80 from public.merc_orders where dish = 'Brownie'), 'date au format français';
  assert (select factors = '{"BASE": 0.85, "LEGUME": 0, "PROTEINE": 0.72}'::jsonb from public.merc_orders where formula = 'Sur mesure'),
    'facteurs du sur mesure : ' || (select factors::text from public.merc_orders where formula = 'Sur mesure');
  assert (select piece_weight = 50 and purchase_unit = 'pièce' from public.merc_ingredients where name = 'Persil'), 'poids d''une pièce';
  assert (select purchase_price = 6.40 from public.merc_ingredient_prices where name = 'Beurre'), 'prix d''achat';
  assert (select synced_at is not null and counts ->> 'orders' = '2' and file_name = 'MERCURIALE SAVEURS NOMADES' from public.merc_sources where brand = 'saveurs_nomades'), 'date de mise à jour';
end $$;

-- 4. Ce que chacun lit
set role authenticated;
set request.jwt.claims = :theo;
do $$ begin
  assert (select count(*) from public.merc_recipes) = 4 and (select count(*) from public.merc_lines) = 6
     and (select count(*) from public.merc_orders) = 2 and (select count(*) from public.merc_ingredients) = 5, 'l''équipe lit fiches, lignes, commandes et ingrédients';
  assert (select count(*) from public.merc_ingredient_prices) = 0 and (select count(*) from public.merc_recipe_costs) = 0, 'un équipier ne lit ni prix ni coûts';
  begin insert into public.merc_orders (brand, position, day, dish, portions) values ('comptoir', 1, current_date, 'Pirate', 1); raise exception 'TEST: un équipier a écrit une commande';
  exception when insufficient_privilege then null; end;
  begin perform public.sync_mercuriale('nuba_x', '{}'); exception when others then raise exception 'TEST: un appel sans clé doit répondre, pas planter'; end;
end $$;
set request.jwt.claims = :ines;
do $$ begin
  assert (select count(*) from public.merc_recipe_costs) = 0, 'une responsable sans l''accès fiches ne lit pas les coûts';
end $$;
set request.jwt.claims = :boss;
do $$ begin
  assert (select count(*) from public.merc_recipe_costs) = 3 and (select count(*) from public.merc_ingredient_prices) = 5, 'le gérant lit coûts et prix';
  assert (select cost_pct = 0.411 and sale_price = 1.8 from public.merc_recipe_costs where name = 'Brownie'), 'coût matière';
  perform public.set_rights((select id from public.profiles where email = 'ines@nuba.fr'), array['fiches']);
end $$;
set request.jwt.claims = :ines;
do $$ begin
  assert (select count(*) from public.merc_recipe_costs) = 3, 'avec l''accès fiches, une responsable lit les coûts';
end $$;

-- 5. Session à code PIN : fiches et commandes, jamais les prix
set request.jwt.claims = :boss;
update t_prod set k = k || '|' || ((public.add_kiosk((select id from public.sites limit 1), 'iPad production')) ->> 'code');
set role anon;
set request.jwt.claims = '';
do $$
declare
  code text := split_part((select k from t_prod), '|', 2);
  tok text := (public.claim_kiosk(code)) ->> 'token';
  ines uuid := (select (e ->> 'id')::uuid from jsonb_array_elements(public.kiosk_team(tok)) e where e ->> 'first_name' = 'Inès');
begin
  update t_prod set k = split_part(k, '|', 1) || '|' || ((public.kiosk_login(tok, ines, '7391')) ->> 'ticket');
end $$;
select set_config('request.headers', json_build_object('x-nuba-ticket', split_part((select k from t_prod), '|', 2))::text, false) \gset ignore_
do $$ begin
  assert public.my_profile_id() is not null, 'session à code PIN ouverte';
  assert (select count(*) from public.merc_orders) = 2 and (select count(*) from public.merc_lines) = 6, 'la session à code PIN lit commandes et fiches';
  assert (select count(*) from public.merc_recipe_costs) = 0 and (select count(*) from public.merc_ingredient_prices) = 0, 'jamais les prix dans une session à code PIN';
end $$;
reset request.headers;
update t_prod set k = split_part(k, '|', 1);

-- 6. Un nouvel envoi remplace le précédent ; Comptoir garde ses propres fiches
do $$
declare
  k text := (select k from t_prod);
  r jsonb;
begin
  r := public.sync_mercuriale(k, jsonb_build_object('brand', 'comptoir', 'file', 'MERCURIALE COMPTOIR',
         'recipes', jsonb_build_array(jsonb_build_object('name', 'Brownie', 'category', 'Dessert', 'portions', 1)),
         'lines', jsonb_build_array(jsonb_build_object('recipe', 'Brownie', 'ingredient', 'Beurre', 'quantity', 25)),
         'orders', jsonb_build_array(jsonb_build_object('day', '2026-11-25', 'formula', 'Dessert', 'dish', 'Brownie', 'portions', 60))));
  assert (r ->> 'ok')::boolean and r -> 'counts' ->> 'ingredients' is null, 'Comptoir sans les ingrédients : ' || r::text;
  r := public.sync_mercuriale(k, (select payload from t_prod)
         || jsonb_build_object('orders', jsonb_build_array(jsonb_build_object('day', '2026-12-02', 'dish', 'Brownie', 'portions', 40))));
  assert (r ->> 'ok')::boolean, 'second envoi : ' || r::text;
end $$;
reset role;
do $$ begin
  assert (select count(*) from public.merc_orders where brand = 'saveurs_nomades') = 1
     and (select day from public.merc_orders where brand = 'saveurs_nomades') = '2026-12-02', 'les commandes de Saveurs Nomades sont remplacées';
  assert (select count(*) from public.merc_orders where brand = 'comptoir') = 1 and (select count(*) from public.merc_recipes where brand = 'comptoir') = 1, 'celles du Comptoir restent';
  assert (select count(*) from public.merc_ingredients) = 5, 'les ingrédients restent';
end $$;

-- 7. Une nouvelle clé remplace l'ancienne ; trop d'envois sont freinés
set role authenticated;
set request.jwt.claims = :boss;
do $$
declare old text := (select k from t_prod); fresh text; st jsonb;
begin
  fresh := public.merc_new_key('', '');
  assert (public.sync_mercuriale(old, (select payload from t_prod))) ->> 'error' = 'key', 'l''ancienne clé ne marche plus';
  assert (public.sync_mercuriale(fresh, (select payload from t_prod))) ->> 'ok' = 'true', 'la nouvelle clé marche';
  st := public.merc_status();
  assert st ->> 'key_created_at' is not null and jsonb_array_length(st -> 'log') = 8 and (st -> 'log' -> 0 ->> 'ok')::boolean, 'journal pour le gérant : ' || st::text;
  update t_prod set k = fresh;
end $$;
reset role;
insert into public.merc_sync_log (brand, ok) select 'saveurs_nomades', true from generate_series(1, 30);
do $$ begin
  assert (public.sync_mercuriale((select k from t_prod), (select payload from t_prod))) ->> 'error' = 'too_many', 'trop d''envois en dix minutes';
end $$;

-- 8. Une erreur de la base annule l'envoi et laisse sa raison au journal, lisible par le gérant
delete from public.merc_sync_log;
alter table public.merc_orders add constraint test_plat_interdit check (dish <> 'Plat interdit');
set role anon;
set request.jwt.claims = '';
do $$
declare r jsonb := public.sync_mercuriale((select k from t_prod), (select payload from t_prod)
                     || jsonb_build_object('orders', jsonb_build_array(jsonb_build_object('day', '2026-12-09', 'dish', 'Plat interdit', 'portions', 10))));
begin
  assert r ->> 'error' = 'db' and r ->> 'message' like '%test_plat_interdit%', 'erreur rendue au script : ' || r::text;
end $$;
reset role;
alter table public.merc_orders drop constraint test_plat_interdit;
do $$ begin
  assert (select count(*) from public.merc_orders where brand = 'saveurs_nomades') = 2
     and not exists (select 1 from public.merc_orders where dish = 'Plat interdit')
     and (select count(*) from public.merc_ingredients) = 5, 'l''envoi refusé n''a rien changé';
  assert (select message from public.merc_sync_log where not ok) like 'Envoi refusé par la base : %test_plat_interdit%', 'la raison est au journal';
  assert public._mnum('"1,5 kg"') = 1.5 and public._mnum('"A MAJ"') is null and public._mnum('"1.2.3"') is null and public._mnum('12') = 12
     and public._mnum('"-0,25"') = -0.25 and public._mnum('null') is null, 'lecture des nombres';
end $$;
set role authenticated;
set request.jwt.claims = :boss;
do $$ begin
  assert (public.merc_status() -> 'log' -> 0 ->> 'message') like 'Envoi refusé par la base%', 'le gérant voit la raison';
end $$;
reset role;

-- 9. Dates calculées par formule : un nombre mis en forme jj/mm/aaaa (numéro de série de Google Sheets)
do $$ begin
  assert public._mdate('46344') = '2026-11-18' and public._mdate('"46174"') = '2026-06-01' and public._mdate('46344.75') = '2026-11-18', 'numéro de série';
  assert public._mdate('"2026-11-25"') = '2026-11-25' and public._mdate('"25/11/2026"') = '2026-11-25' and public._mdate('"plus tard"') is null
     and public._mdate('12') is null and public._mdate('"31/02/2026"') is null, 'autres formes de date';
end $$;
set role anon;
set request.jwt.claims = '';
do $$
declare r jsonb := public.sync_mercuriale((select k from t_prod), (select payload from t_prod)
                     || jsonb_build_object('orders', jsonb_build_array(jsonb_build_object('day', 46344, 'formula', 'Sur mesure', 'dish', 'Brownie', 'portions', 80))));
begin
  assert (r ->> 'ok')::boolean and r -> 'counts' ->> 'orders' = '1', 'une commande datée par un nombre est gardée : ' || r::text;
end $$;
reset role;
do $$ begin
  assert (select day from public.merc_orders where brand = 'saveurs_nomades') = '2026-11-18', 'à la bonne date';
end $$;

-- Remise en état
delete from public.merc_sync_log;
update public.kiosks set revoked_at = now() where revoked_at is null;
