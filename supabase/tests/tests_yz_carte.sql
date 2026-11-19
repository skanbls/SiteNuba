-- Tests de la migration 0017 (carte Nuba). Données inventées, au format envoyé par le script Google.
\set ON_ERROR_STOP on
\set boss   '''{"sub":"00000000-0000-0000-0000-000000000001"}'''
\set theo   '''{"sub":"00000000-0000-0000-0000-000000000002"}'''
\set ines   '''{"sub":"00000000-0000-0000-0000-000000000005"}'''
\set compta '''{"sub":"00000000-0000-0000-0000-000000000011"}'''
reset role;
reset request.headers;
delete from public.merc_sync_log;
insert into auth.users (id, email, email_confirmed_at) values ('00000000-0000-0000-0000-000000000011', 'cabinet@compta.fr', now());
insert into public.accountants (email, name) values ('cabinet@compta.fr', 'Cabinet');
create temp table t_carte (k text, payload jsonb);
grant select, update on t_carte to anon, authenticated;
insert into t_carte (payload) values ($json${
  "brand": "nuba", "file": "MERCURIALE NUBA",
  "items": [
    {"kind": "plat", "block": 1, "name": "Velouté du jour", "category": "Entrée", "status": "OK", "portions": 1, "sale_price": 7.5, "vat": 0.1,
     "allergens": "Céleri, Lait", "cost_portion": 1.4, "sale_price_ht": 6.818, "margin": 5.418, "cost_pct": 0.2053, "target_pct": "25 %", "coefficient": 5.36, "suggested_price": 6.2},
    {"kind": "plat", "block": 2, "name": "Burger maison", "category": "Plat", "status": "Quantités à saisir", "portions": "1", "sale_price": "", "vat": "10%", "allergens": "Gluten, Œufs"},
    {"kind": "plat", "block": 3, "name": "Velouté du jour", "category": "Entrée", "status": "OK"},
    {"kind": "boisson", "block": 4, "name": "Cocktail de la maison", "category": "Cocktail", "status": "OK", "portions": 1, "sale_price": 9, "vat": 0.2, "allergens": "Aucun déclaré", "cost_portion": 1.9, "cost_pct": 0.253},
    {"kind": "preparation", "block": 5, "name": "Sauce blanche (maison)", "category": "", "status": "OK", "yield_qty": 1, "yield_unit": "kg", "recipe_unit": "g",
     "allergens": "Lait", "used_in": "Burger maison", "cost_total": 4.2, "cost_unit": 4.2, "cost_recipe_unit": 0.0042},
    {"kind": "autre", "block": 6, "name": "Inconnue"},
    {"kind": "plat", "block": 7, "name": ""}
  ],
  "lines": [
    {"kind": "plat", "block": 1, "recipe": "Velouté du jour", "ingredient": "Courge", "quantity": 180, "unit": "g", "loss": 0.43, "gross": 257.4, "supplier": "Primeur", "unit_price": 0.0015, "cost": 0.386},
    {"kind": "plat", "block": 1, "recipe": "Velouté du jour", "ingredient": "Crème", "quantity": "40", "unit": "ml", "loss": "5 %", "gross": 42, "supplier": "Grossiste", "allergens": "Lait", "check": "Lait ?", "unit_price": 0.0035, "cost": 0.147},
    {"kind": "plat", "block": 2, "recipe": "Burger maison", "ingredient": "Sauce blanche (maison)", "quantity": 30, "unit": "g", "loss": 0, "supplier": "Maison", "allergens": "Lait"},
    {"kind": "plat", "block": 2, "recipe": "Burger maison", "ingredient": "Pain burger", "quantity": "", "unit": "pièce", "loss": 0, "supplier": "Boulanger", "allergens": "Gluten"},
    {"kind": "plat", "block": 3, "recipe": "Velouté du jour", "ingredient": "Doublon", "quantity": 1, "unit": "g"},
    {"kind": "boisson", "block": 4, "recipe": "Cocktail de la maison", "ingredient": "Rhum", "quantity": 4, "unit": "cl", "loss": 0.02, "gross": 4.08, "supplier": "Cave", "unit_price": 0.3, "cost": 1.22},
    {"kind": "preparation", "block": 5, "recipe": "Sauce blanche (maison)", "ingredient": "Yaourt", "quantity": 800, "unit": "g", "loss": 0.05, "gross": 840, "supplier": "Grossiste", "allergens": "Lait"},
    {"kind": "plat", "block": 1, "recipe": "Velouté du jour", "ingredient": "", "quantity": 3},
    {"kind": "plat", "block": 9, "recipe": "Sans fiche", "ingredient": "Sel", "quantity": 1}
  ]
}$json$::jsonb);

-- 1. Sans clé, rien ne passe ; une clé se crée par le gérant seul
set role anon;
set request.jwt.claims = '';
do $$ begin
  assert (public.sync_carte('', (select payload from t_carte))) ->> 'error' = 'key', 'sans clé, refusé';
  assert (public.sync_carte('nuba_au_hasard', (select payload from t_carte))) ->> 'error' = 'key', 'clé inventée refusée';
  begin perform public.merc_new_key('', '', ''); raise exception 'TEST: le public a créé une clé';
  exception when insufficient_privilege then null; end;
end $$;
set role authenticated;
set request.jwt.claims = :ines;
do $$ begin
  begin perform public.merc_new_key('', '', ''); raise exception 'TEST: une responsable a créé une clé';
  exception when insufficient_privilege then null; end;
end $$;
set request.jwt.claims = :boss;
do $$ begin
  begin perform public.merc_new_key('', '', 'https://exemple.fr/feuille'); raise exception 'TEST: un lien qui n''est pas une feuille Google a été accepté';
  exception when check_violation then null; end;
end $$;
update t_carte set k = public.merc_new_key('', '', 'https://docs.google.com/spreadsheets/d/Carte_Inventee-123/edit');
do $$ begin
  assert (select sheet_url from public.merc_sources where brand = 'nuba') like 'https://docs.google.com/spreadsheets/d/Carte_Inventee-123%', 'lien de la carte enregistré';
  assert (select sheet_url from public.merc_sources where brand = 'saveurs_nomades') = '', 'les autres liens suivent ce qui est donné';
end $$;

-- 2. Le script envoie la carte
set role anon;
set request.jwt.claims = '';
do $$
declare r jsonb;
begin
  assert (public.sync_carte((select k from t_carte), jsonb_build_object('brand', 'saveurs_nomades', 'items', '[]'::jsonb, 'lines', '[]'::jsonb))) ->> 'error' = 'brand', 'une autre mercuriale passe par sync_mercuriale';
  assert (public.sync_carte((select k from t_carte), '{"brand": "nuba", "items": {}}')) ->> 'error' = 'payload', 'contenu illisible';
  r := public.sync_carte((select k from t_carte), (select payload from t_carte));
  assert (r ->> 'ok')::boolean, 'envoi accepté : ' || r::text;
  assert r -> 'counts' ->> 'plats' = '2' and r -> 'counts' ->> 'boissons' = '1' and r -> 'counts' ->> 'preparations' = '1'
     and r -> 'counts' ->> 'lines' = '6' and r -> 'counts' ->> 'todo' = '1', 'comptes : ' || r::text;
  -- Le public ne lit rien
  assert (select count(*) from public.menu_items) = 0 and (select count(*) from public.menu_lines) = 0, 'le public ne lit pas la carte';
end $$;
reset role;
do $$ begin
  assert (select count(*) from public.menu_items) = 4, 'fiche sans nom, fiche inconnue et doublon écartés';
  assert (select position from public.menu_items where name = 'Velouté du jour') = 1, 'la première fiche du même nom compte';
  assert not exists (select 1 from public.menu_lines where ingredient = 'Doublon'), 'les lignes du doublon sont écartées';
  assert (select vat from public.menu_items where name = 'Burger maison') = 0.1 and (select sale_price from public.menu_items where name = 'Burger maison') is null, 'TVA « 10% » lue, prix vide';
  assert (select loss from public.menu_lines where ingredient = 'Crème') = 0.05 and (select quantity from public.menu_lines where ingredient = 'Crème') = 40, 'pertes « 5 % » et quantité texte lues';
  assert (select quantity is null from public.menu_lines where ingredient = 'Pain burger'), 'quantité vide gardée, à saisir';
  assert (select to_check from public.menu_lines where ingredient = 'Crème') = 'Lait ?', 'allergène à vérifier';
  assert (select target_pct from public.menu_costs where name = 'Velouté du jour') = 0.25, 'objectif « 25 % »';
  assert (select count(*) from public.menu_line_costs) = 3, 'prix des lignes';
  assert (select yield_qty = 1 and yield_unit = 'kg' and recipe_unit = 'g' from public.menu_items where kind = 'preparation'), 'rendement de la préparation';
  assert (select counts ->> 'plats' from public.merc_sources where brand = 'nuba') = '2' and (select synced_at is not null from public.merc_sources where brand = 'nuba'), 'état de la synchronisation';
  assert (select message from public.merc_sync_log where brand = 'nuba' and ok order by id desc limit 1) like '%1 fiches à compléter%1 fiche(s) en double%', 'journal clair';
end $$;

-- 3. L'équipe lit la carte, pas les coûts
set role authenticated;
set request.jwt.claims = :theo;
do $$ begin
  assert (select count(*) from public.menu_items) = 4 and (select count(*) from public.menu_lines) = 6, 'un équipier lit la carte';
  assert (select sale_price from public.menu_items where name = 'Velouté du jour') = 7.5, 'et le prix de la carte';
  assert (select count(*) from public.menu_costs) = 0 and (select count(*) from public.menu_line_costs) = 0, 'mais pas les coûts';
  begin insert into public.menu_items (kind, name, position) values ('plat', 'Pirate', 1); raise exception 'TEST: un équipier a écrit dans la carte';
  exception when insufficient_privilege then null; end;
  begin delete from public.menu_items where true; exception when insufficient_privilege then null; end;
  assert (select count(*) from public.menu_items) = 4, 'rien de supprimé';
end $$;

-- 4. Une responsable sans l'accès « fiches techniques », puis avec
set request.jwt.claims = :boss;
do $$ begin perform public.set_rights((select id from public.profiles where email = 'ines@nuba.fr'), array[]::text[]); end $$;
set request.jwt.claims = :ines;
do $$ begin
  assert (select count(*) from public.menu_costs) = 0, 'sans l''accès, pas de coûts';
end $$;
set request.jwt.claims = :boss;
do $$ begin perform public.set_rights((select id from public.profiles where email = 'ines@nuba.fr'), array['fiches']); end $$;
set request.jwt.claims = :ines;
do $$ begin
  assert (select count(*) from public.menu_costs) = 4 and (select count(*) from public.menu_line_costs) = 3, 'avec l''accès, les coûts';
end $$;
set request.jwt.claims = :boss;
do $$ begin
  assert (select cost_pct from public.menu_costs where name = 'Velouté du jour') = 0.2053, 'le gérant lit les coûts';
end $$;

-- 5. Code PIN : la carte, jamais les coûts, même pour une responsable qui a l'accès
update t_carte set k = k || '|' || ((public.add_kiosk((select id from public.sites limit 1), 'iPad carte')) ->> 'code');
set role anon;
set request.jwt.claims = '';
do $$
declare
  tok text := (public.claim_kiosk(split_part((select k from t_carte), '|', 2))) ->> 'token';
  ines uuid := (select (e ->> 'id')::uuid from jsonb_array_elements(public.kiosk_team(tok)) e where e ->> 'first_name' = 'Inès');
begin
  update t_carte set k = split_part(k, '|', 1) || '|' || ((public.kiosk_login(tok, ines, '7391')) ->> 'ticket');
end $$;
select set_config('request.headers', json_build_object('x-nuba-ticket', split_part((select k from t_carte), '|', 2))::text, false) \gset ignore_
do $$ begin
  assert public.my_profile_id() is not null, 'session à code PIN ouverte';
  assert (select count(*) from public.menu_items) = 4 and (select count(*) from public.menu_lines) = 6, 'la session à code PIN lit la carte';
  assert (select count(*) from public.menu_costs) = 0 and (select count(*) from public.menu_line_costs) = 0, 'mais jamais les coûts';
end $$;
reset request.headers;
update t_carte set k = split_part(k, '|', 1);

-- 6. La comptable ne lit pas la carte
set role authenticated;
set request.jwt.claims = :compta;
do $$ begin
  assert public.accountant_me() is not null, 'la comptable est reconnue';
  assert (select count(*) from public.menu_items) = 0 and (select count(*) from public.menu_costs) = 0, 'elle ne lit pas la carte';
end $$;

-- 7. Un nouvel envoi remplace tout ; une erreur de la base est notée au journal
set role anon;
set request.jwt.claims = '';
do $$
declare r jsonb;
begin
  r := public.sync_carte((select k from t_carte), jsonb_build_object('brand', 'nuba', 'items', jsonb_build_array(
         jsonb_build_object('kind', 'boisson', 'block', 1, 'name', 'Café', 'category', 'Boisson chaude', 'status', 'OK')), 'lines', '[]'::jsonb));
  assert (r ->> 'ok')::boolean and r -> 'counts' ->> 'plats' = '0', 'remplacement : ' || r::text;
  r := public.sync_carte((select k from t_carte), jsonb_build_object('brand', 'nuba', 'items', jsonb_build_array(
         jsonb_build_object('kind', 'plat', 'block', 1, 'name', 'Plat', 'portions', 1, 'block', 'pas un nombre', 'category', 'x')), 'lines', '[]'::jsonb));
  assert (r ->> 'ok')::boolean, 'un rang illisible prend le rang de la ligne : ' || r::text;
end $$;
reset role;
do $$ begin
  assert (select count(*) from public.menu_items) = 1 and (select name from public.menu_items) = 'Plat', 'tout est remplacé';
  assert public._mpct('"12,5 %"') = 0.125 and public._mpct('0.3') = 0.3 and public._mpct('"0,3"') = 0.3 and public._mpct('null') is null, 'pourcentages';
end $$;

-- Remise en état
reset role;
delete from public.menu_items where true;
delete from public.merc_sync_log;
delete from public.accountants;
update public.kiosks set revoked_at = now() where revoked_at is null;
