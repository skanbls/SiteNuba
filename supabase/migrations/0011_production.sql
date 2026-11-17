-- =====================================================================
-- Nuba Gestion · migration 0011 · production (mercuriales Google Sheets)
--
-- À exécuter une seule fois dans Supabase, après la 0010 :
--   SQL Editor > New query > coller tout ce fichier > Run.
-- Tout passe ou rien ne passe : en cas d'erreur, la base reste comme avant.
--
-- Les mercuriales Saveurs Nomades et Comptoir Méditerranéen restent la référence :
-- on y crée et modifie les fiches, les prix et les commandes. Un petit script Google
-- (Apps Script), généré par l'appli dans Administration, lit les onglets RECETTES,
-- COMPOSITION CALCUL, PRESTATIONS, GRAMMAGES SUR MESURE et PRIX INGREDIENTS, et les
-- envoie ici toutes les dix minutes quand quelque chose a changé.
--
-- L'appli en tire, pour chaque commande, les quantités de chaque ingrédient à produire
-- et à acheter. Toute l'équipe lit les fiches et les commandes ; les prix, coûts et
-- marges ne se lisent qu'avec l'accès « fiches techniques » (gérant, ou responsable
-- qui l'a reçu). Rien ne s'écrit ici sans la clé de synchronisation.
-- =====================================================================
begin;

-- ---------- Les deux mercuriales ---------------------------------------------
create table public.merc_sources (
  brand      text primary key check (brand in ('saveurs_nomades', 'comptoir')),
  label      text not null,
  sheet_url  text not null default '' check (sheet_url = '' or sheet_url ~ '^https://docs\.google\.com/spreadsheets/d/[A-Za-z0-9_-]+'),
  file_name  text not null default '',
  synced_at  timestamptz,
  counts     jsonb not null default '{}'
);
insert into public.merc_sources (brand, label) values
  ('saveurs_nomades', 'Saveurs Nomades'),
  ('comptoir', 'Comptoir Méditerranéen');

-- Clé de synchronisation : seule son empreinte est gardée.
create table public.merc_sync (
  id         boolean primary key default true check (id),
  key_hash   bytea,
  created_at timestamptz
);
insert into public.merc_sync default values;

create table public.merc_sync_log (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  brand   text not null default '',
  ok      boolean not null,
  message text not null default ''
);
create index merc_sync_log_recent on public.merc_sync_log (at desc);

-- ---------- Ingrédients (onglet PRIX INGREDIENTS de Saveurs Nomades, commun aux deux) ----------
create table public.merc_ingredients (
  name          text primary key,
  category      text not null default '',
  supplier      text not null default '',
  purchase_unit text not null default '',   -- kg, L ou pièce
  piece_weight  numeric,                    -- g, pour un achat à la pièce pesé en recette
  recipe_unit   text not null default '',   -- g ou pièce
  allergens     text not null default ''
);
create table public.merc_ingredient_prices (
  name              text primary key references public.merc_ingredients (name) on delete cascade,
  purchase_price    numeric,                -- € HT par unité d'achat
  recipe_unit_price numeric                 -- € HT par unité de recette
);

-- ---------- Fiches (onglets RECETTES et COMPOSITION CALCUL) -----------------------
create table public.merc_recipes (
  brand          text not null references public.merc_sources (brand),
  name           text not null,
  category       text not null default '',
  portions       numeric not null default 1 check (portions > 0),
  portion_weight numeric,
  status         text not null default '',
  label          text not null default '',
  allergens      text not null default '',
  role           text not null default '',  -- BASE, PROTEINE, LEGUME ou SAUCE pour le sur mesure
  primary key (brand, name)
);
create table public.merc_recipe_costs (
  brand               text not null,
  name                text not null,
  cost_portion        numeric,
  cost_portion_losses numeric,
  sale_price          numeric,
  cost_pct            numeric,
  primary key (brand, name),
  foreign key (brand, name) references public.merc_recipes (brand, name) on delete cascade
);
create table public.merc_lines (
  id         bigint generated always as identity primary key,
  brand      text not null,
  recipe     text not null,
  position   int not null,
  ingredient text not null,
  quantity   numeric not null,              -- pour la fiche entière, en unité de recette
  unit       text not null default 'g',
  supplier   text not null default '',
  allergens  text not null default '',
  loss       numeric not null default 0,    -- 0,05 = 5 % ajoutés pour les achats
  foreign key (brand, recipe) references public.merc_recipes (brand, name) on delete cascade
);
create index merc_lines_by_recipe on public.merc_lines (brand, recipe, position);

-- ---------- Commandes clients (onglet PRESTATIONS) -------------------------------
create table public.merc_orders (
  id           bigint generated always as identity primary key,
  brand        text not null references public.merc_sources (brand),
  position     int not null,
  day          date not null,
  formula      text not null default '',
  dish         text not null,
  portions     numeric not null check (portions > 0),
  check_status text not null default '',
  factors      jsonb not null default '{}'  -- sur mesure : {"BASE": 0.86, "PROTEINE": 0.72, …}
);
create index merc_orders_by_day on public.merc_orders (day);

-- ---------- Lecture des valeurs envoyées par le script ----------------------------
create function public._mnum(v jsonb) returns numeric
language plpgsql immutable set search_path = '' as $$
declare t text;
begin
  if v is null or jsonb_typeof(v) = 'null' then return null; end if;
  if jsonb_typeof(v) = 'number' then return (v #>> '{}')::numeric; end if;
  t := regexp_replace(replace(v #>> '{}', ',', '.'), '[^0-9.eE+-]', '', 'g');
  if t = '' then return null; end if;
  return t::numeric;
exception when others then
  return null;
end $$;

create function public._mtext(v jsonb, n int) returns text
language sql immutable set search_path = '' as $$
  select left(btrim(regexp_replace(coalesce(v #>> '{}', ''), '\s+', ' ', 'g')), n)
$$;

create function public._mdate(v jsonb) returns date
language plpgsql immutable set search_path = '' as $$
declare t text := btrim(coalesce(v #>> '{}', ''));
begin
  if t ~ '^\d{4}-\d{2}-\d{2}' then return left(t, 10)::date; end if;
  if t ~ '^\d{1,2}/\d{1,2}/\d{4}$' then return to_date(t, 'DD/MM/YYYY'); end if;
  return null;
exception when others then
  return null;
end $$;

-- BASE, PROTEINE, LEGUME ou SAUCE, quelle que soit l'écriture dans la feuille.
create function public._mrole(t text) returns text
language sql immutable set search_path = '' as $$
  select case
    when u like 'BASE%' then 'BASE'
    when u like 'PROT%' then 'PROTEINE'
    when u like 'LEG%' or u like 'LÉG%' then 'LEGUME'
    when u like 'SAUCE%' then 'SAUCE'
    else '' end
  from (select upper(btrim(coalesce(t, ''))) as u) x
$$;

-- ---------- Réception d'une mercuriale ---------------------------------------
-- Appelée par le script Google, avec la clé. Remplace tout ce que l'appli savait de cette
-- mercuriale. Renvoie {ok:true, counts} ou {ok:false, error}.
create function public.sync_mercuriale(p_key text, p_payload jsonb) returns jsonb
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
    delete from public.merc_ingredients;
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

-- ---------- Réglage par le gérant ------------------------------------------------
-- Nouvelle clé de synchronisation, rendue une seule fois. L'ancienne cesse de marcher.
create function public.merc_new_key(p_sn_url text, p_cm_url text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_key text := 'nuba_' || replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  if not public.is_gerant() then
    raise exception 'Réservé au gérant.' using errcode = '42501';
  end if;
  update public.merc_sources set sheet_url = btrim(coalesce(p_sn_url, '')) where brand = 'saveurs_nomades';
  update public.merc_sources set sheet_url = btrim(coalesce(p_cm_url, '')) where brand = 'comptoir';
  update public.merc_sync set key_hash = sha256(convert_to(v_key, 'UTF8')), created_at = now();
  return v_key;
end $$;

-- État de la synchronisation, pour le gérant.
create function public.merc_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_gerant() then
    raise exception 'Réservé au gérant.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'key_created_at', (select created_at from public.merc_sync),
    'log', (select coalesce(jsonb_agg(jsonb_build_object('at', l.at, 'brand', l.brand, 'ok', l.ok, 'message', l.message) order by l.id desc), '[]'::jsonb)
            from (select * from public.merc_sync_log order by id desc limit 8) l));
end $$;

-- ---------- Sécurité : droits et RLS --------------------------------------------
alter table public.merc_sources           enable row level security;
alter table public.merc_sync              enable row level security;
alter table public.merc_sync_log          enable row level security;
alter table public.merc_ingredients       enable row level security;
alter table public.merc_ingredient_prices enable row level security;
alter table public.merc_recipes           enable row level security;
alter table public.merc_recipe_costs      enable row level security;
alter table public.merc_lines             enable row level security;
alter table public.merc_orders            enable row level security;

revoke all on public.merc_sources, public.merc_sync, public.merc_sync_log, public.merc_ingredients,
              public.merc_ingredient_prices, public.merc_recipes, public.merc_recipe_costs, public.merc_lines,
              public.merc_orders from anon, authenticated;
-- Toute l'équipe lit les fiches et les commandes, y compris dans une session à code PIN.
grant select on public.merc_sources, public.merc_ingredients, public.merc_recipes, public.merc_lines, public.merc_orders
  to anon, authenticated;
-- Prix et coûts : avec l'accès « fiches techniques » seulement (jamais dans une session à code PIN).
grant select on public.merc_ingredient_prices, public.merc_recipe_costs to anon, authenticated;

create policy "mercuriales: lecture" on public.merc_sources
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "ingredients: lecture" on public.merc_ingredients
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "fiches de production: lecture" on public.merc_recipes
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "lignes de fiches: lecture" on public.merc_lines
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "commandes clients: lecture" on public.merc_orders
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "prix des ingredients: acces fiches" on public.merc_ingredient_prices
  for select to anon, authenticated using ((select public.can('fiches')));
create policy "couts des fiches: acces fiches" on public.merc_recipe_costs
  for select to anon, authenticated using ((select public.can('fiches')));
-- merc_sync et merc_sync_log : aucun accès direct.

revoke all on function
  public._mnum(jsonb), public._mtext(jsonb, int), public._mdate(jsonb), public._mrole(text),
  public.sync_mercuriale(text, jsonb), public.merc_new_key(text, text), public.merc_status()
  from public, anon, authenticated;
-- Le script Google appelle avec la clé publique de l'appli : le rôle anon, puis la clé de synchronisation.
grant execute on function public.sync_mercuriale(text, jsonb) to anon, authenticated;
grant execute on function public.merc_new_key(text, text), public.merc_status() to authenticated;

commit;
