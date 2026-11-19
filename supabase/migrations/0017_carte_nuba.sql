-- =====================================================================
-- Nuba Gestion · migration 0017 · la carte Nuba (mercuriale Nuba)
--
-- À exécuter une seule fois dans Supabase, après la 0016 :
--   SQL Editor > New query > coller tout ce fichier > Run.
-- Supabase doit répondre « Success. No rows returned ».
-- Tout passe ou rien ne passe : en cas d'erreur, la base reste comme avant.
--
-- La mercuriale Nuba (Google Sheets du gérant) reste la référence de la carte :
-- fiches plats (FICHES PLATS), fiches bar (FICHES BOISSONS) et préparations maison
-- (PREPARATIONS MAISON). Le script Google généré dans Administration les envoie ici,
-- avec la même clé que les mercuriales Saveurs Nomades et Comptoir.
--
-- Toute l'équipe lit la carte : ingrédients, quantités, pertes, fournisseurs, allergènes,
-- prix de vente TTC. Les coûts, marges, prix d'achat et objectifs ne se lisent qu'avec
-- l'accès « fiches techniques » (gérant, ou responsable qui l'a reçu), jamais avec un code PIN.
-- =====================================================================
begin;

-- ---------- La mercuriale Nuba rejoint les deux autres --------------------------
alter table public.merc_sources drop constraint merc_sources_brand_check;
alter table public.merc_sources add constraint merc_sources_brand_check
  check (brand in ('saveurs_nomades', 'comptoir', 'nuba'));
insert into public.merc_sources (brand, label) values ('nuba', 'Carte Nuba')
  on conflict (brand) do nothing;

-- ---------- Fiches de la carte -----------------------------------------------------
-- kind : plat (cuisine), boisson (bar) ou preparation (préparation maison).
create table public.menu_items (
  kind        text not null check (kind in ('plat', 'boisson', 'preparation')),
  name        text not null check (name <> ''),
  position    int not null,
  category    text not null default '',
  status      text not null default '',     -- « OK », « Quantités à saisir », « Prix manquant »…
  portions    numeric not null default 1 check (portions > 0),
  sale_price  numeric,                      -- prix de vente TTC de la carte
  vat         numeric,                      -- 0,1 = 10 %
  allergens   text not null default '',
  yield_qty   numeric,                      -- préparation : quantité obtenue
  yield_unit  text not null default '',     -- kg, L ou pièce
  recipe_unit text not null default '',     -- g, ml ou pièce dans les fiches
  used_in     text not null default '',
  primary key (kind, name)
);

-- Coûts, marges et objectifs : accès « fiches techniques » seulement.
create table public.menu_costs (
  kind             text not null,
  name             text not null,
  cost_portion     numeric,
  sale_price_ht    numeric,
  margin           numeric,
  cost_pct         numeric,                 -- 0,28 = 28 %
  target_pct       numeric,
  coefficient      numeric,
  suggested_price  numeric,
  cost_total       numeric,                 -- préparation : coût de toute la recette
  cost_unit        numeric,                 -- préparation : coût par kg, L ou pièce
  cost_recipe_unit numeric,                 -- préparation : coût par g, ml ou pièce
  primary key (kind, name),
  foreign key (kind, name) references public.menu_items (kind, name) on delete cascade
);

-- Lignes des fiches. Une quantité vide reste « à saisir » dans la mercuriale.
create table public.menu_lines (
  kind       text not null,
  recipe     text not null,
  position   int not null,
  ingredient text not null check (ingredient <> ''),
  quantity   numeric,                       -- nette, pour toute la fiche
  unit       text not null default '',
  loss       numeric not null default 0,    -- 0,05 = 5 %
  gross      numeric,                       -- brute à sortir, pertes comprises
  supplier   text not null default '',
  allergens  text not null default '',
  to_check   text not null default '',      -- allergènes à vérifier pour cet ingrédient
  primary key (kind, recipe, position),
  foreign key (kind, recipe) references public.menu_items (kind, name) on delete cascade
);

create table public.menu_line_costs (
  kind       text not null,
  recipe     text not null,
  position   int not null,
  unit_price numeric,
  cost       numeric,
  primary key (kind, recipe, position),
  foreign key (kind, recipe, position) references public.menu_lines (kind, recipe, position) on delete cascade
);

-- Pourcentage envoyé par le script : 0,1 ou « 10 % ».
create function public._mpct(v jsonb) returns numeric
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(v) = 'string' and (v #>> '{}') like '%\%%' then public._mnum(v) / 100 else public._mnum(v) end
$$;

-- ---------- Réception de la carte -----------------------------------------------
-- Appelée par le script Google, avec la clé des mercuriales. Remplace toute la carte.
-- Chaque fiche porte « block », son rang dans la feuille ; ses lignes portent le même.
-- Deux fiches du même nom : la première compte, l'autre est signalée au journal.
create function public.sync_carte(p_key text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s       public.merc_sync;
  n_items int;
  n_lines int;
  n_dup   int;
  c       jsonb;
begin
  select * into s from public.merc_sync;
  if s.key_hash is null or coalesce(p_key, '') = '' or sha256(convert_to(p_key, 'UTF8')) <> s.key_hash then
    if (select count(*) from public.merc_sync_log where not ok and at > now() - interval '1 hour') < 50 then
      insert into public.merc_sync_log (brand, ok, message) values ('nuba', false, 'Clé refusée');
    end if;
    return jsonb_build_object('ok', false, 'error', 'key');
  end if;
  if (select count(*) from public.merc_sync_log where ok and at > now() - interval '10 minutes') >= 30 then
    return jsonb_build_object('ok', false, 'error', 'too_many');
  end if;
  if p_payload ->> 'brand' is distinct from 'nuba' then
    return jsonb_build_object('ok', false, 'error', 'brand');
  end if;
  begin
    if coalesce(jsonb_typeof(p_payload -> 'items'), '') <> 'array' or coalesce(jsonb_typeof(p_payload -> 'lines'), '') <> 'array'
       or jsonb_array_length(p_payload -> 'items') > 3000 or jsonb_array_length(p_payload -> 'lines') > 30000 then
      return jsonb_build_object('ok', false, 'error', 'payload');
    end if;

    delete from public.menu_items where true;

    insert into public.menu_items (kind, name, position, category, status, portions, sale_price, vat, allergens,
                                   yield_qty, yield_unit, recipe_unit, used_in)
      select distinct on (k, n) k, n, blk, public._mtext(i -> 'category', 60), public._mtext(i -> 'status', 80),
             coalesce(nullif(greatest(public._mnum(i -> 'portions'), 0), 0), 1),
             public._mnum(i -> 'sale_price'), public._mpct(i -> 'vat'), public._mtext(i -> 'allergens', 300),
             nullif(greatest(public._mnum(i -> 'yield_qty'), 0), 0), public._mtext(i -> 'yield_unit', 20),
             public._mtext(i -> 'recipe_unit', 20), public._mtext(i -> 'used_in', 1000)
      from jsonb_array_elements(p_payload -> 'items') with ordinality as t (i, o)
      cross join lateral (select public._mtext(i -> 'kind', 20) as k, public._mtext(i -> 'name', 200) as n,
                                 coalesce(public._mnum(i -> 'block')::int, o::int) as blk) x
      where k in ('plat', 'boisson', 'preparation') and n <> ''
      order by k, n, blk;
    get diagnostics n_items = row_count;
    select count(*) - n_items into n_dup
      from jsonb_array_elements(p_payload -> 'items') i
      where public._mtext(i -> 'kind', 20) in ('plat', 'boisson', 'preparation') and public._mtext(i -> 'name', 200) <> '';

    insert into public.menu_costs (kind, name, cost_portion, sale_price_ht, margin, cost_pct, target_pct, coefficient,
                                   suggested_price, cost_total, cost_unit, cost_recipe_unit)
      select m.kind, m.name, public._mnum(i -> 'cost_portion'), public._mnum(i -> 'sale_price_ht'), public._mnum(i -> 'margin'),
             public._mpct(i -> 'cost_pct'), public._mpct(i -> 'target_pct'), public._mnum(i -> 'coefficient'),
             public._mnum(i -> 'suggested_price'), public._mnum(i -> 'cost_total'), public._mnum(i -> 'cost_unit'),
             public._mnum(i -> 'cost_recipe_unit')
      from jsonb_array_elements(p_payload -> 'items') with ordinality as t (i, o)
      join public.menu_items m on m.kind = public._mtext(i -> 'kind', 20) and m.name = public._mtext(i -> 'name', 200)
                              and m.position = coalesce(public._mnum(i -> 'block')::int, o::int);

    insert into public.menu_lines (kind, recipe, position, ingredient, quantity, unit, loss, gross, supplier, allergens, to_check)
      select m.kind, m.name, o::int, public._mtext(l -> 'ingredient', 120),
             nullif(greatest(public._mnum(l -> 'quantity'), 0), 0), public._mtext(l -> 'unit', 20),
             least(greatest(coalesce(public._mpct(l -> 'loss'), 0), 0), 5),
             nullif(greatest(public._mnum(l -> 'gross'), 0), 0), public._mtext(l -> 'supplier', 80),
             public._mtext(l -> 'allergens', 200), public._mtext(l -> 'check', 200)
      from jsonb_array_elements(p_payload -> 'lines') with ordinality as t (l, o)
      join public.menu_items m on m.kind = public._mtext(l -> 'kind', 20) and m.name = public._mtext(l -> 'recipe', 200)
                              and m.position = public._mnum(l -> 'block')::int
      where public._mtext(l -> 'ingredient', 120) <> '';
    get diagnostics n_lines = row_count;

    insert into public.menu_line_costs (kind, recipe, position, unit_price, cost)
      select m.kind, m.recipe, m.position, public._mnum(l -> 'unit_price'), public._mnum(l -> 'cost')
      from jsonb_array_elements(p_payload -> 'lines') with ordinality as t (l, o)
      join public.menu_lines m on m.position = o::int
      where public._mnum(l -> 'unit_price') is not null or public._mnum(l -> 'cost') is not null;

    c := jsonb_build_object(
      'plats', (select count(*) from public.menu_items where kind = 'plat'),
      'boissons', (select count(*) from public.menu_items where kind = 'boisson'),
      'preparations', (select count(*) from public.menu_items where kind = 'preparation'),
      'lines', n_lines,
      'todo', (select count(*) from public.menu_items where status <> '' and lower(status) <> 'ok'));
    update public.merc_sources
      set synced_at = now(), file_name = public._mtext(p_payload -> 'file', 120), counts = c
      where brand = 'nuba';
    delete from public.merc_sync_log where at < now() - interval '30 days';
    insert into public.merc_sync_log (brand, ok, message)
      values ('nuba', true, (c ->> 'plats') || ' plats, ' || (c ->> 'boissons') || ' boissons, '
                            || (c ->> 'preparations') || ' préparations maison, ' || n_lines || ' lignes'
                            || case when (c ->> 'todo')::int > 0 then ' (' || (c ->> 'todo') || ' fiches à compléter)' else '' end
                            || case when n_dup > 0 then ' · ' || n_dup || ' fiche(s) en double ignorée(s)' else '' end);
    return jsonb_build_object('ok', true, 'counts', c);
  exception when others then
    insert into public.merc_sync_log (brand, ok, message) values ('nuba', false, left('Envoi refusé par la base : ' || sqlerrm, 300));
    return jsonb_build_object('ok', false, 'error', 'db', 'message', sqlerrm);
  end;
end $$;

-- ---------- Nouvelle clé, avec le lien de la mercuriale Nuba ----------------------
create function public.merc_new_key(p_sn_url text, p_cm_url text, p_nuba_url text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_key text := 'nuba_' || replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  if not public.is_gerant() then
    raise exception 'Réservé au gérant.' using errcode = '42501';
  end if;
  update public.merc_sources set sheet_url = btrim(coalesce(p_sn_url, '')) where brand = 'saveurs_nomades';
  update public.merc_sources set sheet_url = btrim(coalesce(p_cm_url, '')) where brand = 'comptoir';
  update public.merc_sources set sheet_url = btrim(coalesce(p_nuba_url, '')) where brand = 'nuba';
  update public.merc_sync set key_hash = sha256(convert_to(v_key, 'UTF8')), created_at = now() where id;
  return v_key;
end $$;

-- ---------- Sécurité : droits et RLS ------------------------------------------------
alter table public.menu_items      enable row level security;
alter table public.menu_costs      enable row level security;
alter table public.menu_lines      enable row level security;
alter table public.menu_line_costs enable row level security;

revoke all on public.menu_items, public.menu_costs, public.menu_lines, public.menu_line_costs from anon, authenticated;
grant select on public.menu_items, public.menu_costs, public.menu_lines, public.menu_line_costs to anon, authenticated;

-- Toute l'équipe lit la carte, y compris dans une session à code PIN.
create policy "carte: lecture" on public.menu_items
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "lignes de la carte: lecture" on public.menu_lines
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
-- Coûts et prix d'achat : accès « fiches techniques » (jamais avec un code PIN).
create policy "couts de la carte: acces fiches" on public.menu_costs
  for select to anon, authenticated using ((select public.can('fiches')));
create policy "prix des lignes de la carte: acces fiches" on public.menu_line_costs
  for select to anon, authenticated using ((select public.can('fiches')));

revoke all on function public._mpct(jsonb), public.sync_carte(text, jsonb), public.merc_new_key(text, text, text)
  from public, anon, authenticated;
-- Le script Google appelle avec la clé publique de l'appli (rôle anon), puis la clé de synchronisation.
grant execute on function public.sync_carte(text, jsonb) to anon, authenticated;
grant execute on function public.merc_new_key(text, text, text) to authenticated;

commit;
