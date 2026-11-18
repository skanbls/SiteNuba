-- =====================================================================
-- Nuba Gestion · migration 0012 · correctif des mercuriales
--
-- À exécuter une seule fois dans Supabase, après la 0011 :
--   SQL Editor > New query > coller tout ce fichier > Run.
--
-- Supabase refuse, depuis l'appli, toute modification ou suppression sans condition
-- (« UPDATE requires a WHERE clause »). Deux fonctions de la 0011 en faisaient une :
-- la création de la clé de synchronisation et la réception des ingrédients.
-- Elles sont remplacées à l'identique, avec une condition explicite. Leurs droits restent.
-- =====================================================================
begin;

-- Nouvelle clé de synchronisation, rendue une seule fois. L'ancienne cesse de marcher.
create or replace function public.merc_new_key(p_sn_url text, p_cm_url text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_key text := 'nuba_' || replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  if not public.is_gerant() then
    raise exception 'Réservé au gérant.' using errcode = '42501';
  end if;
  update public.merc_sources set sheet_url = btrim(coalesce(p_sn_url, '')) where brand = 'saveurs_nomades';
  update public.merc_sources set sheet_url = btrim(coalesce(p_cm_url, '')) where brand = 'comptoir';
  update public.merc_sync set key_hash = sha256(convert_to(v_key, 'UTF8')), created_at = now() where id;
  return v_key;
end $$;

-- Réception d'une mercuriale envoyée par le script Google.
create or replace function public.sync_mercuriale(p_key text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s       public.merc_sync;
  b       text := p_payload ->> 'brand';
  n_rec   int;
  n_lines int;
  n_ord   int;
  n_ing   int;
  skipped int;
begin
  select * into s from public.merc_sync;
  if s.key_hash is null or coalesce(p_key, '') = '' or sha256(convert_to(p_key, 'UTF8')) <> s.key_hash then
    if (select count(*) from public.merc_sync_log where not ok and at > now() - interval '1 hour') < 50 then
      insert into public.merc_sync_log (brand, ok, message) values (left(coalesce(b, ''), 30), false, 'Clé refusée');
    end if;
    return jsonb_build_object('ok', false, 'error', 'key');
  end if;
  if (select count(*) from public.merc_sync_log where ok and at > now() - interval '10 minutes') >= 30 then
    return jsonb_build_object('ok', false, 'error', 'too_many');
  end if;
  if b is null or b not in ('saveurs_nomades', 'comptoir') then
    return jsonb_build_object('ok', false, 'error', 'brand');
  end if;
  if coalesce(jsonb_typeof(p_payload -> 'recipes'), '') <> 'array' or coalesce(jsonb_typeof(p_payload -> 'lines'), '') <> 'array'
     or coalesce(jsonb_typeof(p_payload -> 'orders'), '') <> 'array'
     or jsonb_array_length(p_payload -> 'recipes') > 2000 or jsonb_array_length(p_payload -> 'lines') > 20000
     or jsonb_array_length(p_payload -> 'orders') > 5000
     or (jsonb_typeof(p_payload -> 'ingredients') = 'array' and jsonb_array_length(p_payload -> 'ingredients') > 5000) then
    return jsonb_build_object('ok', false, 'error', 'payload');
  end if;

  -- Ingrédients et prix : envoyés avec Saveurs Nomades, ils servent aux deux.
  if jsonb_typeof(p_payload -> 'ingredients') = 'array' then
    delete from public.merc_ingredients where true;
    insert into public.merc_ingredients (name, category, supplier, purchase_unit, piece_weight, recipe_unit, allergens)
      select distinct on (lower(n)) n, public._mtext(i -> 'category', 80), public._mtext(i -> 'supplier', 80),
             public._mtext(i -> 'purchase_unit', 20), nullif(public._mnum(i -> 'piece_weight'), 0),
             public._mtext(i -> 'recipe_unit', 20), public._mtext(i -> 'allergens', 200)
      from jsonb_array_elements(p_payload -> 'ingredients') i
      cross join lateral (select public._mtext(i -> 'name', 120) as n) x
      where n <> ''
      order by lower(n);
    get diagnostics n_ing = row_count;
    insert into public.merc_ingredient_prices (name, purchase_price, recipe_unit_price)
      select distinct on (lower(n)) n, public._mnum(i -> 'purchase_price'), public._mnum(i -> 'recipe_unit_price')
      from jsonb_array_elements(p_payload -> 'ingredients') i
      cross join lateral (select public._mtext(i -> 'name', 120) as n) x
      where n <> '' and exists (select 1 from public.merc_ingredients g where g.name = n)
      order by lower(n);
  end if;

  delete from public.merc_orders where brand = b;
  delete from public.merc_recipes where brand = b;

  insert into public.merc_recipes (brand, name, category, portions, portion_weight, status, label, allergens)
    select distinct on (n) b, n, public._mtext(r -> 'category', 60),
           coalesce(nullif(greatest(public._mnum(r -> 'portions'), 0), 0), 1),
           public._mnum(r -> 'portion_weight'), public._mtext(r -> 'status', 80),
           public._mtext(r -> 'label', 1000), public._mtext(r -> 'allergens', 300)
    from jsonb_array_elements(p_payload -> 'recipes') r
    cross join lateral (select public._mtext(r -> 'name', 200) as n) x
    where n <> ''
    order by n;
  get diagnostics n_rec = row_count;
  insert into public.merc_recipe_costs (brand, name, cost_portion, cost_portion_losses, sale_price, cost_pct)
    select distinct on (n) b, n, public._mnum(r -> 'cost_portion'), public._mnum(r -> 'cost_portion_losses'),
           public._mnum(r -> 'sale_price'), public._mnum(r -> 'cost_pct')
    from jsonb_array_elements(p_payload -> 'recipes') r
    cross join lateral (select public._mtext(r -> 'name', 200) as n) x
    where n <> ''
    order by n;

  -- Une ligne de fiche dont la recette manque dans RECETTES garde sa fiche, signalée.
  insert into public.merc_recipes (brand, name, status)
    select distinct b, public._mtext(l -> 'recipe', 200), 'Absente de RECETTES'
    from jsonb_array_elements(p_payload -> 'lines') l
    where public._mtext(l -> 'recipe', 200) <> ''
    on conflict do nothing;

  insert into public.merc_lines (brand, recipe, position, ingredient, quantity, unit, supplier, allergens, loss)
    select b, public._mtext(l -> 'recipe', 200), o::int, public._mtext(l -> 'ingredient', 120),
           public._mnum(l -> 'quantity'), coalesce(nullif(public._mtext(l -> 'unit', 20), ''), 'g'),
           public._mtext(l -> 'supplier', 80), public._mtext(l -> 'allergens', 200),
           least(greatest(coalesce(public._mnum(l -> 'loss'), 0), 0), 5)
    from jsonb_array_elements(p_payload -> 'lines') with ordinality as t (l, o)
    where public._mtext(l -> 'recipe', 200) <> '' and public._mtext(l -> 'ingredient', 120) <> ''
      and public._mnum(l -> 'quantity') > 0;
  get diagnostics n_lines = row_count;

  -- Rôle de chaque élément du plat sur mesure (onglet GRAMMAGES SUR MESURE).
  if jsonb_typeof(p_payload -> 'roles') = 'array' then
    update public.merc_recipes m set role = x.role
      from (select distinct on (lower(public._mtext(r -> 'recipe', 200)))
                   public._mtext(r -> 'recipe', 200) as name, public._mrole(r ->> 'role') as role
            from jsonb_array_elements(p_payload -> 'roles') r) x
      where m.brand = b and lower(m.name) = lower(x.name) and x.role <> '';
  end if;

  insert into public.merc_orders (brand, position, day, formula, dish, portions, check_status, factors)
    select b, o::int, public._mdate(c -> 'day'), public._mtext(c -> 'formula', 60), public._mtext(c -> 'dish', 300),
           public._mnum(c -> 'portions'), public._mtext(c -> 'check', 200),
           coalesce((select jsonb_object_agg(k, v) from (values
                       ('BASE', public._mnum(c -> 'factor_base')), ('PROTEINE', public._mnum(c -> 'factor_protein')),
                       ('LEGUME', public._mnum(c -> 'factor_vegetable')), ('SAUCE', public._mnum(c -> 'factor_sauce'))) f (k, v)
                     where v is not null), '{}'::jsonb)
    from jsonb_array_elements(p_payload -> 'orders') with ordinality as t (c, o)
    where public._mdate(c -> 'day') is not null and public._mtext(c -> 'dish', 300) <> '' and public._mnum(c -> 'portions') > 0;
  get diagnostics n_ord = row_count;
  skipped := jsonb_array_length(p_payload -> 'orders') - n_ord;

  update public.merc_sources
    set synced_at = now(), file_name = public._mtext(p_payload -> 'file', 120),
        counts = jsonb_build_object('recipes', n_rec, 'lines', n_lines, 'orders', n_ord, 'ingredients', n_ing)
    where brand = b;
  delete from public.merc_sync_log where at < now() - interval '30 days';
  insert into public.merc_sync_log (brand, ok, message)
    values (b, true, n_rec || ' fiches, ' || n_lines || ' lignes, ' || n_ord || ' commandes'
                     || case when n_ing is not null then ', ' || n_ing || ' ingrédients' else '' end
                     || case when skipped > 0 then ' (' || skipped || ' lignes de commande incomplètes ignorées)' else '' end);
  return jsonb_build_object('ok', true, 'counts', jsonb_build_object('recipes', n_rec, 'lines', n_lines, 'orders', n_ord, 'ingredients', n_ing));
end $$;

commit;
