-- =====================================================================
-- Nuba Gestion · migration 0029 · stocks reliés à la mercuriale Nuba, réception des livraisons
--
-- À exécuter une seule fois dans Supabase, après la 0028 :
--   SQL Editor > New query > coller tout ce fichier > Run.
-- Supabase doit répondre « Success. No rows returned ».
-- Tout passe ou rien ne passe : en cas d'erreur, la base reste comme avant.
--
-- 1. Les produits de la mercuriale Nuba (onglet PRIX INGREDIENTS) arrivent par le script Google. Chaque produit
--    suivi en stock y est relié : nom, catégorie, unité d'achat, fournisseur et prix suivent la mercuriale.
--    À l'inventaire, l'équipe ajoute un produit en le choisissant dans la mercuriale.
-- 2. Une livraison se réceptionne avec la photo du bon : l'appli le lit (si la lecture est activée), retrouve
--    chaque produit de la mercuriale, la commande en attente du fournisseur, et montre les écarts (quantités
--    commandées, prix, total, dates limites). La personne vérifie, corrige au besoin et valide : le stock est
--    mis à jour, la commande est close, le gérant est prévenu des écarts.
-- 3. La lecture du bon passe par Claude (Anthropic), depuis la base, avec une clé que le gérant range lui-même
--    dans le coffre de Supabase sous le nom anthropic_api_key. Sans cette clé, tout marche, sans lecture
--    automatique : on saisit les lignes à la main.
-- =====================================================================
begin;

do $$ begin
  if to_regprocedure('public._member()') is null or to_regprocedure('public.receive_order(uuid, jsonb, boolean, numeric, text)') is null
     or to_regprocedure('public._email_queue(text, text, text, text)') is null or to_regprocedure('public._eur(numeric, boolean)') is null
     or to_regclass('public.drive_files') is null then
    raise exception 'Il manque une mise à jour plus ancienne. Exécute d''abord les mises à jour jusqu''à la 0028, puis relance celle-ci (0029).';
  end if;
end $$;

-- Clé d'un nom de produit : minuscules, sans accents, lettres et chiffres (« Coca 33cl » ≠ « Coca 50cl »).
create function public._prod_key(t text) returns text
language sql immutable set search_path = '' as $$
  select btrim(regexp_replace(
    translate(replace(replace(lower(coalesce(t, '')), 'œ', 'oe'), 'æ', 'ae'), 'àâäáãåçéèêëíìîïñóòôöõúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy'),
    '[^a-z0-9]+', ' ', 'g'))
$$;

-- ---------- 1. Les produits de la mercuriale Nuba ----------------------------------------
create table public.merc_products (
  key        text primary key,
  name       text not null,
  category   text not null default '',
  supplier   text not null default '',     -- fournisseur retenu dans la mercuriale
  unit       text not null default '',     -- unité d'achat : kg, L, pièce
  piece_g    numeric,                      -- poids d'une pièce
  label      text not null default '',     -- nom sur l'étiquette (sert aussi à reconnaître le produit)
  allergens  text not null default '',
  position   int not null default 0,
  synced_at  timestamptz not null default now()
);
-- Prix d'achat de la mercuriale : accès « Stocks » ou « Fiches techniques » seulement.
create table public.merc_product_prices (
  key          text primary key references public.merc_products (key) on delete cascade,
  price_ht     numeric,
  invoice_date date,
  source       text not null default ''
);

alter table public.products add column merc_key text;
create unique index products_merc_key on public.products (merc_key) where merc_key is not null;
create index products_name_key on public.products (public._prod_key(name));

alter table public.merc_products enable row level security;
alter table public.merc_product_prices enable row level security;
revoke all on public.merc_products, public.merc_product_prices from anon, authenticated;
grant select on public.merc_products to anon, authenticated;
grant select on public.merc_product_prices to authenticated;
create policy "produits mercuriale: lecture" on public.merc_products
  for select to anon, authenticated using ((select public.my_profile_id()) is not null or (select public.is_gerant()));
create policy "prix mercuriale: stocks ou fiches" on public.merc_product_prices
  for select to authenticated using ((select public.can('stocks')) or (select public.can('fiches')));

-- Le fournisseur d'un nom (« Metro », « RV primeur ») parmi ceux de l'appli, ou null.
create function public._supplier_by_name(p_name text) returns uuid
language sql stable security definer set search_path = '' as $$
  select s.id from public.suppliers s
  where public._prod_key(s.name) = public._prod_key(p_name) and public._prod_key(p_name) <> ''
  order by s.active desc, s.created_at limit 1
$$;

-- Un produit suivi reprend ce que dit la mercuriale.
create function public._product_from_merc(p_product uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  m public.merc_products;
  v_price numeric;
  v_sup uuid;
begin
  select mp.* into m from public.merc_products mp join public.products p on p.merc_key = mp.key where p.id = p_product;
  if not found then return; end if;
  select price_ht into v_price from public.merc_product_prices where key = m.key;
  v_sup := public._supplier_by_name(m.supplier);
  update public.products set
      name = left(m.name, 80), category = coalesce(nullif(m.category, ''), category), unit = coalesce(nullif(m.unit, ''), unit),
      unit_price = case when v_price is not null and v_price >= 0 then round(v_price, 2) else unit_price end,
      supplier_id = coalesce(v_sup, supplier_id)
    where id = p_product;
end $$;

-- Reçu du script Google, avec la clé des mercuriales. p_payload : { brand: 'produits', products: [{category, name,
-- supplier, price, unit, piece_g, invoice_date, source, allergens, label}] }. Remplace la liste ; les produits suivis
-- en stock suivent leur fiche de la mercuriale.
create function public.sync_merc_products(p_key text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s      public.merc_sync;
  r      jsonb;
  v_key  text;
  keys   text[] := '{}';
  dups   text[] := '{}';
  n_pos  int := 0;
  n_link int := 0;
  pid    uuid;
begin
  select * into s from public.merc_sync;
  if s.key_hash is null or coalesce(p_key, '') = '' or sha256(convert_to(p_key, 'UTF8')) <> s.key_hash then
    if (select count(*) from public.merc_sync_log where not ok and at > now() - interval '1 hour') < 50 then
      insert into public.merc_sync_log (brand, ok, message) values ('produits', false, 'Clé refusée');
    end if;
    return jsonb_build_object('ok', false, 'error', 'key');
  end if;
  if p_payload ->> 'brand' is distinct from 'produits' or coalesce(jsonb_typeof(p_payload -> 'products'), '') <> 'array'
     or jsonb_array_length(p_payload -> 'products') > 3000 then
    return jsonb_build_object('ok', false, 'error', 'payload');
  end if;
  if jsonb_array_length(p_payload -> 'products') = 0 and (select count(*) from public.merc_products) > 10 then
    insert into public.merc_sync_log (brand, ok, message) values ('produits', false, 'Liste vide : rien n''a été retiré.');
    return jsonb_build_object('ok', false, 'error', 'empty');
  end if;

  begin
    for r in select value from jsonb_array_elements(p_payload -> 'products') loop
      v_key := public._prod_key(public._mtext(r -> 'name', 120));
      continue when v_key = '';
      if v_key = any (keys) then
        dups := dups || public._mtext(r -> 'name', 80);
        continue;
      end if;
      keys := keys || v_key;
      n_pos := n_pos + 1;
      insert into public.merc_products (key, name, category, supplier, unit, piece_g, label, allergens, position, synced_at)
        values (v_key, public._mtext(r -> 'name', 120), public._mtext(r -> 'category', 60), public._mtext(r -> 'supplier', 80),
                public._mtext(r -> 'unit', 20), public._mnum(r -> 'piece_g'), public._mtext(r -> 'label', 120),
                public._mtext(r -> 'allergens', 300), n_pos, now())
        on conflict (key) do update set name = excluded.name, category = excluded.category, supplier = excluded.supplier,
          unit = excluded.unit, piece_g = excluded.piece_g, label = excluded.label, allergens = excluded.allergens,
          position = excluded.position, synced_at = excluded.synced_at;
      insert into public.merc_product_prices (key, price_ht, invoice_date, source)
        values (v_key, public._mnum(r -> 'price'), public._mdate(r -> 'invoice_date'), public._mtext(r -> 'source', 200))
        on conflict (key) do update set price_ht = excluded.price_ht, invoice_date = excluded.invoice_date, source = excluded.source;
    end loop;
    delete from public.merc_products where not (key = any (keys));

    -- Les produits déjà suivis sous le même nom sont reliés d'eux-mêmes.
    update public.products p set merc_key = public._prod_key(p.name)
      where p.merc_key is null and public._prod_key(p.name) = any (keys)
        and not exists (select 1 from public.products q where q.merc_key = public._prod_key(p.name));
    get diagnostics n_link = row_count;
    for pid in select id from public.products where merc_key is not null loop
      perform public._product_from_merc(pid);
    end loop;

    delete from public.merc_sync_log where at < now() - interval '30 days';
    insert into public.merc_sync_log (brand, ok, message)
      values ('produits', true, cardinality(keys) || ' produit(s)'
        || case when n_link > 0 then ', ' || n_link || ' produit(s) du stock relié(s)' else '' end
        || case when cardinality(dups) > 0 then ' · en double : ' || array_to_string(dups[1:5], ', ') else '' end);
    return jsonb_build_object('ok', true, 'counts', jsonb_build_object('products', cardinality(keys), 'linked', n_link, 'duplicates', cardinality(dups)));
  exception when others then
    insert into public.merc_sync_log (brand, ok, message) values ('produits', false, left('Envoi refusé par la base : ' || sqlerrm, 300));
    return jsonb_build_object('ok', false, 'error', 'db', 'message', sqlerrm);
  end;
end $$;

-- Suivre en stock des produits de la mercuriale (inventaire, réception) : toute l'équipe, code PIN compris.
-- Un produit déjà suivi est repris (et remis dans le suivi s'il en avait été retiré). Renvoie leurs identifiants.
create function public._stock_from_merc(p_key text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  m public.merc_products;
  v_id uuid;
begin
  select * into m from public.merc_products where key = p_key;
  if not found then raise exception 'Produit absent de la mercuriale : %', p_key using errcode = 'P0001'; end if;
  select id into v_id from public.products where merc_key = m.key;
  if v_id is null then
    -- Un produit du même nom, pas encore relié : on le relie plutôt que d'en créer un second.
    select id into v_id from public.products where merc_key is null and public._prod_key(name) = m.key order by active desc limit 1;
    if v_id is not null then update public.products set merc_key = m.key where id = v_id; end if;
  end if;
  if v_id is null then
    insert into public.products (name, category, unit, merc_key) values (left(m.name, 80), coalesce(nullif(m.category, ''), 'Cuisine'), m.unit, m.key)
      returning id into v_id;
  end if;
  update public.products set active = true where id = v_id and not active;
  perform public._product_from_merc(v_id);
  return v_id;
end $$;

create function public.stock_add_from_merc(p_keys text[]) returns uuid[]
language plpgsql security definer set search_path = '' as $$
declare
  k   text;
  out uuid[] := '{}';
begin
  perform public._member();
  if cardinality(coalesce(p_keys, '{}')) > 200 then raise exception 'Trop de produits d''un coup.' using errcode = 'P0001'; end if;
  foreach k in array coalesce(p_keys, '{}') loop
    out := out || public._stock_from_merc(k);
  end loop;
  return out;
end $$;

-- Relier un produit suivi à la mercuriale, ou le délier (p_key vide) : accès « Stocks ».
create function public.link_product_merc(p_product uuid, p_key text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.can('stocks') then raise exception 'Réservé au gérant et aux responsables des stocks.' using errcode = '42501'; end if;
  if coalesce(p_key, '') = '' then
    update public.products set merc_key = null where id = p_product;
    return;
  end if;
  if not exists (select 1 from public.merc_products where key = p_key) then
    raise exception 'Produit absent de la mercuriale.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.products where merc_key = p_key and id <> p_product) then
    raise exception 'Un autre produit du stock est déjà relié à ce produit de la mercuriale.' using errcode = 'P0001';
  end if;
  update public.products set merc_key = p_key where id = p_product;
  if not found then raise exception 'Produit introuvable.' using errcode = 'P0001'; end if;
  perform public._product_from_merc(p_product);
end $$;

-- ---------- 2. Réceptions de livraison -------------------------------------------------------
alter table public.email_settings add column notify_delivery boolean not null default true;

create table public.deliveries (
  id            uuid primary key default gen_random_uuid(),
  supplier_id   uuid references public.suppliers (id) on delete set null,
  supplier_name text not null default '',
  order_id      uuid references public.orders (id) on delete set null,
  status        text not null default 'draft' check (status in ('draft', 'done')),
  bl_number     text not null default '',
  bl_date       date,
  bl_total_ht   numeric(12, 2),
  scan_status   text not null default 'none' check (scan_status in ('none', 'pending', 'done', 'error')),
  scan_request  bigint,
  scan_at       timestamptz,
  scan_error    text not null default '',
  scan_note     text not null default '',
  ok            boolean,
  temp          numeric(4, 1),
  note          text not null default '',
  issues        jsonb not null default '[]',
  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  received_by   uuid references public.profiles (id) on delete set null,
  received_at   timestamptz
);
create index deliveries_recent on public.deliveries (created_at desc);

-- Photos du bon, en base (base64) pour marcher sur l'iPad avec un code PIN.
create table public.delivery_photos (
  delivery_id uuid not null references public.deliveries (id) on delete cascade,
  page        int not null check (page between 1 and 6),
  mime        text not null check (mime in ('image/jpeg', 'image/png', 'image/webp')),
  data        text not null check (length(data) <= 1400000),
  created_at  timestamptz not null default now(),
  primary key (delivery_id, page)
);

create table public.delivery_lines (
  id          uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references public.deliveries (id) on delete cascade,
  position    int not null default 0,
  label       text not null default '',           -- tel qu'écrit sur le bon
  product_id  uuid references public.products (id) on delete set null,
  merc_key    text,                               -- produit de la mercuriale pas encore suivi en stock
  quantity    numeric(12, 3),                     -- dans l'unité du produit
  unit        text not null default '',
  unit_price  numeric(12, 4),                     -- HT, par unité, d'après le bon
  lot         text not null default '',
  use_by      date,
  ordered     numeric(10, 2),                     -- quantité commandée dans l'appli
  skip        boolean not null default false,     -- ligne qui ne se suit pas en stock (consigne, transport…)
  source      text not null default 'manual' check (source in ('scan', 'order', 'manual'))
);
create index delivery_lines_by_delivery on public.delivery_lines (delivery_id, position);

alter table public.deliveries enable row level security;
alter table public.delivery_photos enable row level security;
alter table public.delivery_lines enable row level security;
revoke all on public.deliveries, public.delivery_photos, public.delivery_lines from anon, authenticated;
-- Toute l'équipe lit les réceptions (code PIN compris) ; les photos passent par delivery_photo().
grant select on public.deliveries, public.delivery_lines to anon, authenticated;
create policy "livraisons: lecture" on public.deliveries
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "lignes de livraison: lecture" on public.delivery_lines
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);

-- Une réception, avec ses lignes et le nombre de pages photographiées.
create function public._delivery_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select to_jsonb(d) - 'scan_request'
    || jsonb_build_object(
      'pages', (select count(*) from public.delivery_photos ph where ph.delivery_id = d.id),
      'received_by_name', (select first_name from public.profiles where id = d.received_by),
      'lines', coalesce((select jsonb_agg(to_jsonb(l) || jsonb_build_object(
          'product_name', p.name, 'product_unit', p.unit, 'merc_name', m.name, 'merc_unit', m.unit)
          order by l.position, l.label)
        from public.delivery_lines l
        left join public.products p on p.id = l.product_id
        left join public.merc_products m on m.key = l.merc_key
        where l.delivery_id = d.id), '[]'::jsonb))
  from public.deliveries d where d.id = p_id
$$;

create function public._delivery_draft(p_id uuid) returns public.deliveries
language plpgsql security definer set search_path = '' as $$
declare d public.deliveries;
begin
  perform public._member();
  select * into d from public.deliveries where id = p_id for update;
  if not found then raise exception 'Réception introuvable.' using errcode = 'P0001'; end if;
  if d.status <> 'draft' then raise exception 'Cette livraison est déjà réceptionnée.' using errcode = 'P0001'; end if;
  return d;
end $$;

-- Les lignes de la commande en attente du fournisseur : ce qui est attendu.
create function public._delivery_attach_order(p_id uuid, p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  update public.deliveries set order_id = p_order where id = p_id;
  select coalesce(max(position), 0) into n from public.delivery_lines where delivery_id = p_id;
  -- Sans lecture du bon, tout est supposé livré : la personne corrige ce qui manque.
  insert into public.delivery_lines (delivery_id, position, label, product_id, quantity, unit, unit_price, ordered, source)
    select p_id, n + row_number() over (order by p.name), p.name, l.product_id, l.quantity, p.unit, l.unit_price, l.quantity, 'order'
    from public.order_lines l join public.products p on p.id = l.product_id
    where l.order_id = p_order
      and not exists (select 1 from public.delivery_lines x where x.delivery_id = p_id and x.product_id = l.product_id);
  update public.delivery_lines x set ordered = l.quantity
    from public.order_lines l where l.order_id = p_order and x.delivery_id = p_id and x.product_id = l.product_id and x.ordered is null;
end $$;

-- Commencer une réception : le fournisseur (de l'appli, ou un nom), la commande éventuelle.
-- Sans commande indiquée, celle en attente chez ce fournisseur est reprise d'elle-même.
create function public.delivery_open(p_supplier uuid, p_supplier_name text, p_order uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me    uuid := public._member();
  v_sup uuid := p_supplier;
  v_ord uuid := p_order;
  v_id  uuid;
begin
  if v_ord is not null then
    select supplier_id into v_sup from public.orders where id = v_ord and status = 'sent';
    if not found then raise exception 'Cette commande n''attend pas de livraison.' using errcode = 'P0001'; end if;
    -- Une réception déjà commencée pour cette commande : on la reprend.
    select id into v_id from public.deliveries where order_id = v_ord and status = 'draft' order by created_at limit 1;
    if v_id is not null then return public._delivery_json(v_id); end if;
  end if;
  if v_sup is null and coalesce(btrim(p_supplier_name), '') <> '' then v_sup := public._supplier_by_name(p_supplier_name); end if;
  if v_ord is null and v_sup is not null then
    select id into v_ord from public.orders where supplier_id = v_sup and status = 'sent'
      and not exists (select 1 from public.deliveries x where x.order_id = orders.id and x.status = 'draft')
      order by sent_at desc nulls last limit 1;
  end if;
  insert into public.deliveries (supplier_id, supplier_name, created_by)
    values (v_sup, coalesce((select name from public.suppliers where id = v_sup), left(btrim(coalesce(p_supplier_name, '')), 80)), me)
    returning id into v_id;
  if v_ord is not null then perform public._delivery_attach_order(v_id, v_ord); end if;
  return public._delivery_json(v_id);
end $$;

create function public.delivery_get(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public._member();
  return public._delivery_json(p_id);
end $$;

create function public.delivery_add_photo(p_id uuid, p_mime text, p_data text) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  perform public._delivery_draft(p_id);
  if p_mime not in ('image/jpeg', 'image/png', 'image/webp') or length(coalesce(p_data, '')) > 1400000 or coalesce(p_data, '') !~ '^[A-Za-z0-9+/=]+$' then
    raise exception 'Photo refusée : JPEG, PNG ou WebP d''un Mo au plus.' using errcode = 'P0001';
  end if;
  select coalesce(max(page), 0) + 1 into n from public.delivery_photos where delivery_id = p_id;
  if n > 6 then raise exception 'Six pages au plus par bon de livraison.' using errcode = 'P0001'; end if;
  insert into public.delivery_photos (delivery_id, page, mime, data) values (p_id, n, p_mime, p_data);
  return n;
end $$;

create function public.delivery_remove_photo(p_id uuid, p_page int) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public._delivery_draft(p_id);
  delete from public.delivery_photos where delivery_id = p_id and page = p_page;
  update public.delivery_photos set page = page - 1 where delivery_id = p_id and page > p_page;
end $$;

create function public.delivery_photo(p_id uuid, p_page int) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public._member();
  return (select jsonb_build_object('mime', mime, 'data', data) from public.delivery_photos where delivery_id = p_id and page = p_page);
end $$;

-- ---------- 3. Lecture du bon par Claude -----------------------------------------------------
-- Le modèle, le format de réponse attendu et la consigne. La liste des produits de la mercuriale accompagne
-- chaque bon : Claude y choisit le produit de chaque ligne et convertit la quantité dans son unité d'achat.
create function public._delivery_schema() returns jsonb
language sql immutable set search_path = '' as $$
  select '{
    "type": "object", "additionalProperties": false,
    "required": ["readable", "supplier", "bl_number", "bl_date", "total_ht", "remarks", "lines"],
    "properties": {
      "readable": {"type": "boolean", "description": "false si la photo ne montre pas un bon de livraison ou une facture lisible"},
      "supplier": {"type": "string", "description": "Nom du fournisseur tel qu''écrit sur le bon"},
      "bl_number": {"type": "string", "description": "Numéro du bon de livraison ou de la facture, vide s''il n''y en a pas"},
      "bl_date": {"type": "string", "description": "Date du bon au format AAAA-MM-JJ, vide si absente"},
      "total_ht": {"anyOf": [{"type": "number"}, {"type": "null"}], "description": "Total hors taxes du bon, null s''il n''est pas écrit"},
      "remarks": {"type": "string", "description": "Ce qui est illisible ou douteux, en une phrase simple en français ; vide sinon"},
      "lines": {"type": "array", "items": {"type": "object", "additionalProperties": false,
        "required": ["label", "product", "quantity", "unit", "unit_price", "lot", "use_by"],
        "properties": {
          "label": {"type": "string", "description": "Désignation telle qu''écrite sur le bon"},
          "product": {"type": "string", "description": "Nom exact du produit de référence correspondant, copié de la liste ; vide si aucun ne correspond"},
          "quantity": {"anyOf": [{"type": "number"}, {"type": "null"}], "description": "Quantité livrée, convertie dans l''unité d''achat du produit de référence quand il y en a un"},
          "unit": {"type": "string", "description": "Unité de cette quantité : kg, L ou pièce de préférence"},
          "unit_price": {"anyOf": [{"type": "number"}, {"type": "null"}], "description": "Prix unitaire HT pour cette unité, null s''il n''est pas écrit"},
          "lot": {"type": "string", "description": "Numéro de lot s''il est écrit, vide sinon"},
          "use_by": {"type": "string", "description": "Date limite (DLC ou DDM) au format AAAA-MM-JJ, vide sinon"}}}}}}'::jsonb
$$;

create function public._delivery_prompt(p_supplier text) returns text
language sql stable security definer set search_path = '' as $$
  select 'Tu lis la photo d''un bon de livraison (ou d''une facture) reçu par la Nuba, un restaurant-bar de Toulouse. '
    || 'Relève chaque ligne de produit livré. Pour chacune, choisis le produit de référence correspondant dans la liste ci-dessous '
    || '(copie son nom exactement) ou laisse « product » vide si aucun ne correspond vraiment. '
    || 'Convertis la quantité dans l''unité d''achat du produit de référence : par exemple 2 colis de 5 kg font 10 kg, '
    || 'un carton de 24 bouteilles fait 24 pièces, un bidon de 5 L fait 5 L. Le prix unitaire HT suit la même unité. '
    || 'N''invente rien : une valeur absente ou illisible reste vide (ou null), et tu le signales dans « remarks ». '
    || 'Ignore les lignes de transport, de consigne ou de remise.'
    || case when coalesce(p_supplier, '') <> '' then E'\n\nFournisseur attendu : ' || p_supplier || '.' else '' end
    || E'\n\nProduits de référence (nom | unité d''achat | fournisseur habituel) :\n'
    || coalesce((select string_agg(m.name || ' | ' || m.unit || ' | ' || m.supplier
                   || case when m.label <> '' and public._prod_key(m.label) <> m.key then ' | aussi appelé : ' || m.label else '' end, E'\n' order by m.position)
                 from public.merc_products m), '(liste vide)')
$$;

-- Lancer la lecture : la demande part vers Claude par pg_net ; la réponse arrive en quelques secondes.
create function public.delivery_scan(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  d      public.deliveries := public._delivery_draft(p_id);
  v_key  text;
  v_req  bigint;
  v_cont jsonb;
begin
  if not exists (select 1 from public.delivery_photos where delivery_id = p_id) then
    raise exception 'Prends d''abord le bon en photo.' using errcode = 'P0001';
  end if;
  if to_regprocedure('net.http_post(text, jsonb, jsonb, jsonb, integer)') is null or to_regclass('vault.decrypted_secrets') is null then
    return jsonb_build_object('status', 'unavailable', 'message', 'La lecture automatique n''est pas disponible (pg_net ou Vault manquant).');
  end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1' into v_key using 'anthropic_api_key';
  if coalesce(btrim(v_key), '') = '' then
    return jsonb_build_object('status', 'unavailable', 'message', 'La lecture automatique n''est pas activée : le gérant doit ranger la clé d''Anthropic dans le coffre de Supabase (anthropic_api_key).');
  end if;
  -- Garde-fou sur la dépense : 40 lectures par jour au plus.
  if (select count(*) from public.deliveries where scan_at > now() - interval '24 hours') >= 40 then
    return jsonb_build_object('status', 'unavailable', 'message', 'Plafond de 40 lectures par jour atteint : saisis les lignes à la main.');
  end if;

  select jsonb_agg(jsonb_build_object('type', 'image', 'source', jsonb_build_object('type', 'base64', 'media_type', mime, 'data', data)) order by page)
    into v_cont from public.delivery_photos where delivery_id = p_id;
  v_cont := v_cont || jsonb_build_array(jsonb_build_object('type', 'text', 'text', public._delivery_prompt(d.supplier_name)));

  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 180000)' into v_req
    using 'https://api.anthropic.com/v1/messages',
          jsonb_build_object(
            'model', 'claude-opus-5-5',
            'max_tokens', 16000,
            'output_config', jsonb_build_object('effort', 'medium', 'format', jsonb_build_object('type', 'json_schema', 'schema', public._delivery_schema())),
            'fallbacks', 'default',
            'messages', jsonb_build_array(jsonb_build_object('role', 'user', 'content', v_cont))),
          jsonb_build_object('x-api-key', btrim(v_key), 'anthropic-version', '2026-10-21',
                             'anthropic-beta', 'server-side-fallback-2026-07-01', 'content-type', 'application/json');
  update public.deliveries set scan_status = 'pending', scan_request = v_req, scan_at = now(), scan_error = '' where id = p_id;
  return jsonb_build_object('status', 'pending');
exception when others then
  if sqlstate in ('P0001', '42501') then raise; end if;
  update public.deliveries set scan_status = 'error', scan_error = left('Lecture impossible : ' || sqlerrm, 300) where id = p_id;
  return jsonb_build_object('status', 'error', 'message', left(sqlerrm, 300));
end $$;

-- Ce que Claude a lu, appliqué à la réception : fournisseur, numéro, date, total, et les lignes reliées aux produits.
-- p_result : l'objet décrit par _delivery_schema(). Les lignes déjà attendues (commande) reçoivent la quantité lue.
create function public._delivery_apply_scan(p_id uuid, p_result jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  d      public.deliveries;
  l      jsonb;
  v_key  text;
  v_mk   text;
  v_prod uuid;
  v_line uuid;
  v_lab  text;
  n      int;
  v_sup  uuid;
begin
  select * into d from public.deliveries where id = p_id;
  if not (coalesce(p_result ->> 'readable', 'true'))::boolean then
    update public.deliveries set scan_status = 'error', scan_error = 'Le bon n''est pas lisible sur la photo : reprends-le en photo, bien à plat et éclairé.' where id = p_id;
    return;
  end if;
  if d.supplier_id is null then
    v_sup := public._supplier_by_name(public._mtext(p_result -> 'supplier', 80));
    if v_sup is not null then
      update public.deliveries set supplier_id = v_sup, supplier_name = (select name from public.suppliers where id = v_sup) where id = p_id;
      if d.order_id is null then
        perform public._delivery_attach_order(p_id, o.id) from public.orders o
          where o.supplier_id = v_sup and o.status = 'sent'
            and not exists (select 1 from public.deliveries x where x.order_id = o.id and x.status = 'draft' and x.id <> p_id)
          order by o.sent_at desc nulls last limit 1;
      end if;
    elsif d.supplier_name = '' then
      update public.deliveries set supplier_name = public._mtext(p_result -> 'supplier', 80) where id = p_id;
    end if;
  end if;
  update public.deliveries set
      bl_number = public._mtext(p_result -> 'bl_number', 60),
      bl_date = public._mdate(p_result -> 'bl_date'),
      bl_total_ht = round(public._mnum(p_result -> 'total_ht'), 2),
      scan_note = public._mtext(p_result -> 'remarks', 400),
      scan_status = 'done', scan_error = ''
    where id = p_id;

  -- Une nouvelle lecture remplace la précédente ; les lignes attendues gardent leur place.
  delete from public.delivery_lines where delivery_id = p_id and source = 'scan';
  update public.delivery_lines set quantity = null, lot = '', use_by = null where delivery_id = p_id and source = 'order';
  select coalesce(max(position), 0) into n from public.delivery_lines where delivery_id = p_id;
  for l in select value from jsonb_array_elements(coalesce(p_result -> 'lines', '[]')) loop
    v_key := public._prod_key(public._mtext(l -> 'product', 120));
    v_lab := public._prod_key(public._mtext(l -> 'label', 120));
    v_mk := null;
    v_prod := null;
    if v_key <> '' then
      select key into v_mk from public.merc_products where key = v_key;
    end if;
    -- Sans produit de référence reconnu : la désignation elle-même, ou le nom sur l'étiquette.
    if v_mk is null and v_lab <> '' then
      select key into v_mk from public.merc_products where key = v_lab or (label <> '' and public._prod_key(label) = v_lab)
        order by key = v_lab desc limit 1;
    end if;
    if v_mk is not null then select id into v_prod from public.products where merc_key = v_mk; end if;
    if v_prod is null and v_mk is null then
      select id into v_prod from public.products
        where active and public._prod_key(name) <> '' and public._prod_key(name) in (v_key, v_lab) limit 1;
    end if;
    -- Une ligne attendue (commande) pour ce produit : elle reçoit ce qui est livré.
    v_line := null;
    if v_prod is not null then
      select id into v_line from public.delivery_lines where delivery_id = p_id and product_id = v_prod and source = 'order' and quantity is null limit 1;
    end if;
    if v_line is not null then
      update public.delivery_lines set quantity = round(public._mnum(l -> 'quantity'), 3),
          unit_price = coalesce(round(public._mnum(l -> 'unit_price'), 4), unit_price),
          lot = public._mtext(l -> 'lot', 60), use_by = public._mdate(l -> 'use_by'),
          label = coalesce(nullif(public._mtext(l -> 'label', 160), ''), label)
        where id = v_line;
    else
      n := n + 1;
      insert into public.delivery_lines (delivery_id, position, label, product_id, merc_key, quantity, unit, unit_price, lot, use_by, source)
        values (p_id, n, public._mtext(l -> 'label', 160), v_prod, case when v_prod is null then v_mk end,
                round(public._mnum(l -> 'quantity'), 3), public._mtext(l -> 'unit', 20), round(public._mnum(l -> 'unit_price'), 4),
                public._mtext(l -> 'lot', 60), public._mdate(l -> 'use_by'), 'scan');
    end if;
  end loop;
end $$;

-- Où en est la lecture : la réponse de Claude est relevée et appliquée dès qu'elle est arrivée.
create function public.delivery_scan_poll(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  d      public.deliveries;
  v_code int;
  v_body text;
  v_out  boolean;
  v_err  text;
  r      jsonb;
  v_txt  text;
begin
  perform public._member();
  select * into d from public.deliveries where id = p_id for update;
  if not found then raise exception 'Réception introuvable.' using errcode = 'P0001'; end if;
  if d.scan_status <> 'pending' or d.scan_request is null then return public._delivery_json(p_id); end if;
  if to_regclass('net._http_response') is not null then
    execute 'select status_code, content, timed_out, error_msg from net._http_response where id = $1' into v_code, v_body, v_out, v_err using d.scan_request;
  end if;
  if v_code is null and coalesce(v_out, false) is false and coalesce(v_err, '') = '' then
    if d.scan_at < now() - interval '4 minutes' then
      update public.deliveries set scan_status = 'error', scan_error = 'Pas de réponse de la lecture : réessaie, ou saisis les lignes à la main.' where id = p_id;
    end if;
    return public._delivery_json(p_id);
  end if;
  begin
    if coalesce(v_out, false) or coalesce(v_err, '') <> '' then
      raise exception 'Pas de réponse de la lecture (%).', coalesce(nullif(v_err, ''), 'délai dépassé');
    end if;
    r := v_body::jsonb;
    if v_code = 401 then raise exception 'La clé d''Anthropic est refusée : le gérant doit la vérifier dans le coffre de Supabase.'; end if;
    if v_code in (429, 500, 529) then raise exception 'Le service de lecture est occupé : réessaie dans une minute.'; end if;
    if v_code <> 200 then raise exception 'Lecture refusée (%) : %', v_code, left(coalesce(r #>> '{error,message}', v_body), 200); end if;
    if r ->> 'stop_reason' = 'refusal' then raise exception 'La lecture a été refusée pour ce document.'; end if;
    if r ->> 'stop_reason' = 'max_tokens' then raise exception 'Bon trop long pour une seule lecture : saisis les dernières lignes à la main.'; end if;
    select string_agg(b ->> 'text', '') into v_txt from jsonb_array_elements(r -> 'content') b where b ->> 'type' = 'text';
    if coalesce(btrim(v_txt), '') = '' then raise exception 'La lecture n''a rien renvoyé : réessaie, ou saisis les lignes à la main.'; end if;
    perform public._delivery_apply_scan(p_id, v_txt::jsonb);
  exception when others then
    update public.deliveries set scan_status = 'error', scan_error = left(sqlerrm, 300) where id = p_id;
  end;
  return public._delivery_json(p_id);
end $$;

-- ---------- 4. Correction et validation ------------------------------------------------------
-- Les lignes telles que la personne les a vérifiées. p_lines : [{label, product_id, merc_key, quantity, unit,
-- unit_price, lot, use_by, ordered, skip, source}] ; p_meta : {bl_number, bl_date, bl_total_ht}.
create function public.delivery_save(p_id uuid, p_lines jsonb, p_meta jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  l jsonb;
  n int := 0;
begin
  perform public._delivery_draft(p_id);
  if coalesce(jsonb_typeof(p_lines), '') <> 'array' or jsonb_array_length(p_lines) > 300 then
    raise exception 'Contenu illisible.' using errcode = 'P0001';
  end if;
  update public.deliveries set
      bl_number = public._mtext(coalesce(p_meta -> 'bl_number', to_jsonb(bl_number)), 60),
      bl_date = coalesce(public._mdate(p_meta -> 'bl_date'), case when p_meta ? 'bl_date' then null else bl_date end),
      bl_total_ht = case when p_meta ? 'bl_total_ht' then round(public._mnum(p_meta -> 'bl_total_ht'), 2) else bl_total_ht end
    where id = p_id;
  delete from public.delivery_lines where delivery_id = p_id;
  for l in select value from jsonb_array_elements(p_lines) loop
    n := n + 1;
    insert into public.delivery_lines (delivery_id, position, label, product_id, merc_key, quantity, unit, unit_price, lot, use_by, ordered, skip, source)
      values (p_id, n, public._mtext(l -> 'label', 160),
              (select id from public.products where id = case when (l ->> 'product_id') ~ '^[0-9a-f-]{36}$' then (l ->> 'product_id')::uuid end),
              (select key from public.merc_products where key = l ->> 'merc_key'),
              round(public._mnum(l -> 'quantity'), 3), public._mtext(l -> 'unit', 20), round(public._mnum(l -> 'unit_price'), 4),
              public._mtext(l -> 'lot', 60), public._mdate(l -> 'use_by'), round(public._mnum(l -> 'ordered'), 2),
              coalesce((l ->> 'skip')::boolean, false),
              case when l ->> 'source' in ('scan', 'order', 'manual') then l ->> 'source' else 'manual' end);
  end loop;
  return public._delivery_json(p_id);
end $$;

-- Valider la réception : produits suivis, stock, commande, écarts, e-mail au gérant.
create function public.delivery_validate(p_id uuid, p_ok boolean, p_temp numeric, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me     uuid := public._member();
  d      public.deliveries := public._delivery_draft(p_id);
  l      public.delivery_lines;
  p      public.products;
  v_prod uuid;
  v_ref  numeric;
  v_sum  numeric := 0;
  v_issues jsonb := '[]';
  m      public.email_settings;
  v_body text := '';
begin
  if p_ok is not true and length(btrim(coalesce(p_note, ''))) = 0 then
    raise exception 'Décris le problème constaté à la réception.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.delivery_lines where delivery_id = p_id and not skip and product_id is null and merc_key is null and coalesce(quantity, 0) > 0) then
    raise exception 'Chaque ligne livrée doit être reliée à un produit de la mercuriale (ou marquée « pas en stock »).' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.delivery_lines where delivery_id = p_id and not skip and coalesce(quantity, 0) > 0) and p_ok is true then
    raise exception 'Aucune quantité livrée : indique ce qui est arrivé.' using errcode = 'P0001';
  end if;

  for l in select * from public.delivery_lines where delivery_id = p_id order by position loop
    v_sum := v_sum + coalesce(l.quantity, 0) * coalesce(l.unit_price, 0);
    continue when l.skip;
    p := null;
    v_prod := l.product_id;
    if v_prod is null and l.merc_key is not null and coalesce(l.quantity, 0) > 0 then
      v_prod := public._stock_from_merc(l.merc_key);
      update public.delivery_lines set product_id = v_prod where id = l.id;
    end if;
    if v_prod is not null then select * into p from public.products where id = v_prod; end if;
    -- Écarts avec la commande.
    if l.ordered is not null and coalesce(l.quantity, 0) = 0 then
      v_issues := v_issues || jsonb_build_object('kind', 'missing', 'product', coalesce(p.name, l.label), 'text', 'Commandé ' || trim_scale(l.ordered) || ' ' || coalesce(p.unit, '') || ', pas livré');
    elsif l.ordered is not null and abs(l.quantity - l.ordered) > greatest(0.01, l.ordered * 0.02) then
      v_issues := v_issues || jsonb_build_object('kind', 'quantity', 'product', coalesce(p.name, l.label),
        'text', 'Commandé ' || trim_scale(l.ordered) || ', livré ' || trim_scale(l.quantity) || ' ' || coalesce(p.unit, ''));
    end if;
    -- Prix du bon et prix de référence (mercuriale, sinon le prix du produit).
    if v_prod is not null and l.unit_price is not null and coalesce(l.quantity, 0) > 0 then
      select coalesce((select price_ht from public.merc_product_prices where key = p.merc_key), nullif(p.unit_price, 0)) into v_ref;
      if v_ref is not null and v_ref > 0 and abs(l.unit_price - v_ref) / v_ref > 0.05 then
        v_issues := v_issues || jsonb_build_object('kind', 'price', 'product', p.name,
          'text', case when l.unit_price > v_ref then 'Prix en hausse de ' else 'Prix en baisse de ' end
                  || round(abs(l.unit_price - v_ref) / v_ref * 100) || ' % par rapport à la mercuriale');
      end if;
    end if;
    if l.use_by is not null and l.use_by < public.service_day() + 2 and coalesce(l.quantity, 0) > 0 then
      v_issues := v_issues || jsonb_build_object('kind', 'use_by', 'product', coalesce(p.name, l.label), 'text', 'Date limite courte : ' || to_char(l.use_by, 'DD/MM/YYYY'));
    end if;
    -- Le stock.
    if v_prod is not null and coalesce(l.quantity, 0) > 0 then
      perform public._move_stock(v_prod, p.quantity + l.quantity, 'reception',
        'Livraison ' || coalesce(nullif(d.supplier_name, ''), 'fournisseur') || case when d.bl_number <> '' then ' · BL ' || d.bl_number else '' end, me);
    end if;
  end loop;
  if d.bl_total_ht is not null and v_sum > 0 and abs(d.bl_total_ht - v_sum) > 1 then
    v_issues := v_issues || jsonb_build_object('kind', 'total', 'product', '',
      'text', 'Total du bon ' || public._eur(d.bl_total_ht) || ', lignes ' || public._eur(round(v_sum, 2)));
  end if;

  -- La commande reliée est close, avec ce qui est arrivé.
  if d.order_id is not null then
    update public.order_lines ol set received_quantity = coalesce((select sum(x.quantity) from public.delivery_lines x
        where x.delivery_id = p_id and x.product_id = ol.product_id and not x.skip), 0)
      where ol.order_id = d.order_id;
    update public.orders set status = 'received', received_by = me, received_at = now(),
        reception_ok = coalesce(p_ok, false), reception_temp = p_temp, reception_note = left(coalesce(btrim(p_note), ''), 200)
      where id = d.order_id and status = 'sent';
  end if;

  update public.deliveries set status = 'done', ok = coalesce(p_ok, false), temp = p_temp, note = left(coalesce(btrim(p_note), ''), 500),
      issues = v_issues, received_by = me, received_at = now()
    where id = p_id;

  -- Le gérant est prévenu d'un problème ou d'un écart.
  select * into m from public.email_settings;
  if (p_ok is not true or jsonb_array_length(v_issues) > 0) and m.enabled and coalesce(m.notify_delivery, true) and m.notify_email <> '' then
    select string_agg('- ' || case when i ->> 'product' <> '' then (i ->> 'product') || ' : ' else '' end || (i ->> 'text'), E'\n') into v_body
      from jsonb_array_elements(v_issues) i;
    perform public._email_queue('livraison', m.notify_email,
      'Livraison ' || coalesce(nullif(d.supplier_name, ''), 'reçue') || case when p_ok is not true then ' : problème signalé' else ' : ' || jsonb_array_length(v_issues) || ' écart(s)' end,
      'Réception par ' || coalesce((select first_name from public.profiles where id = me), 'l''équipe')
      || case when d.bl_number <> '' then ', bon n° ' || d.bl_number else '' end || E'.\n\n'
      || case when p_ok is not true then 'Problème signalé : ' || coalesce(btrim(p_note), '') || E'\n\n' else '' end
      || coalesce(v_body, '') || E'\n\n[[Voir la livraison|' || m.app_url || '#/livraisons?l=' || p_id || ']]');
  end if;
  return public._delivery_json(p_id);
end $$;

-- Abandonner une réception commencée par erreur (pas encore validée).
create function public.delivery_delete(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public._delivery_draft(p_id);
  delete from public.deliveries where id = p_id and status = 'draft';
end $$;

-- La lecture est-elle prête ? (pour le gérant, dans Administration ; ne dit jamais rien de la clé elle-même)
create function public.delivery_scan_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_has boolean := false;
begin
  if not public.is_gerant() then raise exception 'Réservé au gérant.' using errcode = '42501'; end if;
  if to_regclass('vault.decrypted_secrets') is not null then
    execute 'select exists (select 1 from vault.decrypted_secrets where name = $1 and coalesce(btrim(decrypted_secret), '''') <> '''')' into v_has using 'anthropic_api_key';
  end if;
  return jsonb_build_object('key', v_has, 'pg_net', to_regprocedure('net.http_post(text, jsonb, jsonb, jsonb, integer)') is not null,
    'scans_today', (select count(*) from public.deliveries where scan_at > now() - interval '24 hours'),
    'products', (select count(*) from public.merc_products),
    'products_synced_at', (select max(synced_at) from public.merc_products));
end $$;

-- ---------- Droits ------------------------------------------------------------------------
revoke all on function public._prod_key(text), public._supplier_by_name(text), public._product_from_merc(uuid),
  public.sync_merc_products(text, jsonb), public._stock_from_merc(text), public.stock_add_from_merc(text[]),
  public.link_product_merc(uuid, text), public._delivery_json(uuid), public._delivery_draft(uuid),
  public._delivery_attach_order(uuid, uuid), public.delivery_open(uuid, text, uuid), public.delivery_get(uuid),
  public.delivery_add_photo(uuid, text, text), public.delivery_remove_photo(uuid, int), public.delivery_photo(uuid, int),
  public._delivery_schema(), public._delivery_prompt(text), public.delivery_scan(uuid), public._delivery_apply_scan(uuid, jsonb),
  public.delivery_scan_poll(uuid), public.delivery_save(uuid, jsonb, jsonb), public.delivery_validate(uuid, boolean, numeric, text),
  public.delivery_delete(uuid), public.delivery_scan_status()
  from public, anon, authenticated;
-- L'index sur le nom des produits appelle _prod_key avec les droits de la personne.
grant execute on function public._prod_key(text) to anon, authenticated;
-- Le script Google, avec la clé publique de l'appli (rôle anon) puis la clé de synchronisation.
grant execute on function public.sync_merc_products(text, jsonb) to anon, authenticated;
-- L'équipe, avec son compte ou son code PIN.
grant execute on function public.stock_add_from_merc(text[]), public.delivery_open(uuid, text, uuid), public.delivery_get(uuid),
  public.delivery_add_photo(uuid, text, text), public.delivery_remove_photo(uuid, int), public.delivery_photo(uuid, int),
  public.delivery_scan(uuid), public.delivery_scan_poll(uuid), public.delivery_save(uuid, jsonb, jsonb),
  public.delivery_validate(uuid, boolean, numeric, text), public.delivery_delete(uuid)
  to anon, authenticated;
grant execute on function public.link_product_merc(uuid, text), public.delivery_scan_status() to authenticated;

commit;
