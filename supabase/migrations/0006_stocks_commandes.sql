-- =====================================================================
-- Nuba Gestion · migration 0006 · stocks, fournisseurs et commandes
--
-- À exécuter une seule fois dans Supabase, après la 0005 :
--   SQL Editor > New query > coller tout ce fichier > Run.
--
-- Principes :
--   * chaque produit a une quantité, un seuil d'alerte et un fournisseur ;
--   * la quantité ne change que par un mouvement signé : ajustement, inventaire
--     ou réception d'une commande ; l'historique reste consultable ;
--   * toute l'équipe ajuste le stock, prépare, envoie et réceptionne les
--     commandes, sur son téléphone comme sur l'iPad ; chaque geste est signé ;
--   * le gérant tient le catalogue : produits, seuils, prix, fournisseurs ;
--   * réceptionner une commande ajoute les quantités reçues au stock et garde
--     le contrôle à réception (conformité, température).
-- =====================================================================

-- Personne en cours (compte ou session à code PIN), ou erreur si aucune.
create function public._member() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  me_id uuid := public.my_profile_id();
begin
  if me_id is null then raise exception 'Compte non rattaché à l''équipe.' using errcode = '42501'; end if;
  return me_id;
end $$;

-- ---------- Fournisseurs ----------------------------------------------------
create table public.suppliers (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (length(btrim(name)) > 0),
  contact       text not null default '',
  phone         text not null default '',
  email         text not null default '',
  delivery_days text not null default '',
  order_cutoff  text not null default '',
  minimum       text not null default '',
  note          text not null default '',
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- ---------- Produits et stock -----------------------------------------------
create table public.products (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) > 0),
  category    text not null default 'Bar',
  unit        text not null default '',
  quantity    numeric(10, 2) not null default 0 check (quantity >= 0),
  threshold   numeric(10, 2) not null default 0 check (threshold >= 0),
  target      numeric(10, 2) check (target is null or target >= 0),
  unit_price  numeric(10, 2) not null default 0 check (unit_price >= 0),
  supplier_id uuid references public.suppliers (id) on delete set null,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create index products_by_supplier on public.products (supplier_id);

create table public.stock_moves (
  id             bigint generated always as identity primary key,
  product_id     uuid not null references public.products (id) on delete cascade,
  delta          numeric(10, 2) not null,
  quantity_after numeric(10, 2) not null,
  reason         text not null check (reason in ('ajustement', 'inventaire', 'reception', 'perte')),
  note           text not null default '',
  done_by        uuid references public.profiles (id) on delete set null,
  done_at        timestamptz not null default now()
);
create index stock_moves_by_product on public.stock_moves (product_id, done_at desc);

-- Change la quantité d'un produit et écrit le mouvement. Le stock ne descend pas sous zéro.
create function public._move_stock(p_product uuid, p_new numeric, p_reason text, p_note text, p_me uuid) returns numeric
language plpgsql security definer set search_path = '' as $$
declare
  old_q numeric;
  new_q numeric := greatest(0, round(p_new, 2));
begin
  select quantity into old_q from public.products where id = p_product for update;
  if not found then raise exception 'Produit introuvable.' using errcode = 'P0001'; end if;
  if new_q <> old_q then
    update public.products set quantity = new_q where id = p_product;
    insert into public.stock_moves (product_id, delta, quantity_after, reason, note, done_by)
      values (p_product, new_q - old_q, new_q, p_reason, coalesce(btrim(p_note), ''), p_me);
  end if;
  return new_q;
end $$;

-- Ajouter ou retirer une quantité (boutons + et −). Renvoie la nouvelle quantité.
create function public.adjust_stock(p_product uuid, p_delta numeric) returns numeric
language plpgsql security definer set search_path = '' as $$
declare
  me_id uuid := public._member();
  q     numeric;
begin
  if p_delta is null or p_delta = 0 then raise exception 'Quantité manquante.' using errcode = 'P0001'; end if;
  select quantity into q from public.products where id = p_product and active;
  if not found then raise exception 'Produit introuvable.' using errcode = 'P0001'; end if;
  return public._move_stock(p_product, q + p_delta, 'ajustement', '', me_id);
end $$;

-- Inventaire : enregistre les quantités comptées. p_counts : [{id, quantity}]. Renvoie le nombre de produits modifiés.
create function public.count_stock(p_counts jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare
  me_id uuid := public._member();
  c     jsonb;
  old_q numeric;
  q     numeric;
  n     int := 0;
begin
  for c in select * from jsonb_array_elements(coalesce(p_counts, '[]'::jsonb)) loop
    q := (c ->> 'quantity')::numeric;
    continue when q is null or q < 0;
    select quantity into old_q from public.products where id = (c ->> 'id')::uuid and active;
    continue when not found;
    if round(q, 2) <> old_q then
      perform public._move_stock((c ->> 'id')::uuid, q, 'inventaire', '', me_id);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- ---------- Commandes -------------------------------------------------------
create table public.orders (
  id             uuid primary key default gen_random_uuid(),
  supplier_id    uuid not null references public.suppliers (id) on delete restrict,
  status         text not null default 'draft' check (status in ('draft', 'sent', 'received', 'cancelled')),
  note           text not null default '',
  created_by     uuid references public.profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  sent_by        uuid references public.profiles (id) on delete set null,
  sent_at        timestamptz,
  received_by    uuid references public.profiles (id) on delete set null,
  received_at    timestamptz,
  reception_ok   boolean,
  reception_temp numeric(4, 1),
  reception_note text not null default ''
);
create index orders_by_status on public.orders (status, created_at desc);

create table public.order_lines (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null references public.orders (id) on delete cascade,
  product_id        uuid not null references public.products (id) on delete restrict,
  quantity          numeric(10, 2) not null check (quantity > 0),
  unit_price        numeric(10, 2) not null default 0,
  received_quantity numeric(10, 2) check (received_quantity is null or received_quantity >= 0),
  unique (order_id, product_id)
);

-- Créer ou modifier un brouillon de commande. p_lines : [{product_id, quantity}].
create function public.save_order(p_id uuid, p_supplier uuid, p_note text, p_lines jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me_id uuid := public._member();
  v_id  uuid := p_id;
  l     jsonb;
  p     public.products;
  q     numeric;
begin
  if v_id is null then
    if not exists (select 1 from public.suppliers where id = p_supplier and active) then
      raise exception 'Fournisseur introuvable.' using errcode = 'P0001';
    end if;
    insert into public.orders (supplier_id, note, created_by)
      values (p_supplier, coalesce(btrim(p_note), ''), me_id) returning id into v_id;
  else
    update public.orders set note = coalesce(btrim(p_note), '') where id = v_id and status = 'draft';
    if not found then raise exception 'Cette commande n''est plus modifiable.' using errcode = 'P0001'; end if;
    delete from public.order_lines where order_id = v_id;
  end if;

  for l in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    q := (l ->> 'quantity')::numeric;
    continue when q is null or q <= 0;
    select * into p from public.products where id = (l ->> 'product_id')::uuid and active;
    continue when not found;
    insert into public.order_lines (order_id, product_id, quantity, unit_price)
      values (v_id, p.id, round(q, 2), p.unit_price)
      on conflict (order_id, product_id) do update set quantity = excluded.quantity;
  end loop;
  return v_id;
end $$;

-- La commande est partie chez le fournisseur.
create function public.send_order(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me_id uuid := public._member();
begin
  if not exists (select 1 from public.order_lines where order_id = p_id) then
    raise exception 'Cette commande est vide.' using errcode = 'P0001';
  end if;
  update public.orders set status = 'sent', sent_by = me_id, sent_at = now() where id = p_id and status = 'draft';
  if not found then raise exception 'Cette commande a déjà été envoyée.' using errcode = 'P0001'; end if;
end $$;

-- Supprimer un brouillon.
create function public.delete_order(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public._member();
  delete from public.orders where id = p_id and status = 'draft';
  if not found then raise exception 'Seul un brouillon peut être supprimé.' using errcode = 'P0001'; end if;
end $$;

-- Annuler une commande envoyée qui ne sera pas livrée. Réservé au gérant.
create function public.cancel_order(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_gerant() then
    raise exception 'Réservé au gérant.' using errcode = '42501';
  end if;
  update public.orders set status = 'cancelled' where id = p_id and status = 'sent';
  if not found then raise exception 'Seule une commande envoyée peut être annulée.' using errcode = 'P0001'; end if;
end $$;

-- Réceptionner une livraison : quantités reçues, contrôle à réception, mise à jour du stock.
-- p_lines : [{line_id, received}] ; une ligne absente est considérée comme reçue en entier.
create function public.receive_order(p_id uuid, p_lines jsonb, p_ok boolean, p_temp numeric, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me_id uuid := public._member();
  o     public.orders;
  l     public.order_lines;
  got   numeric;
  s_name text;
begin
  select * into o from public.orders where id = p_id and status = 'sent' for update;
  if not found then raise exception 'Cette commande n''attend pas de livraison.' using errcode = 'P0001'; end if;
  if p_ok is not true and length(btrim(coalesce(p_note, ''))) = 0 then
    raise exception 'Décris le problème constaté à la réception.' using errcode = 'P0001';
  end if;
  select name into s_name from public.suppliers where id = o.supplier_id;

  for l in select * from public.order_lines where order_id = p_id loop
    select (e ->> 'received')::numeric into got
      from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) e where (e ->> 'line_id')::uuid = l.id;
    got := greatest(0, round(coalesce(got, l.quantity), 2));
    update public.order_lines set received_quantity = got where id = l.id;
    if got > 0 then
      perform public._move_stock(l.product_id,
        (select quantity from public.products where id = l.product_id) + got, 'reception', 'Livraison ' || s_name, me_id);
    end if;
  end loop;

  update public.orders
    set status = 'received', received_by = me_id, received_at = now(),
        reception_ok = coalesce(p_ok, false), reception_temp = p_temp, reception_note = coalesce(btrim(p_note), '')
    where id = p_id;
end $$;

-- ---------- Accueil : ajoute les stocks bas et les livraisons attendues ---------
create or replace function public.today_tasks() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  d  date := public.service_day();
  sl text := public._slot();
begin
  if public.my_profile_id() is null then return null; end if;
  return jsonb_build_object(
    'day', d,
    'slot', sl,
    'checks_total', (select count(*) from public.checklist_items i join public.checklists c on c.id = i.checklist_id
                     where i.active and c.active and c.frequency = 'daily'),
    'checks_done', (select count(*) from public.checklist_ticks t
                    join public.checklist_items i on i.id = t.item_id and i.active
                    join public.checklists c on c.id = i.checklist_id and c.active and c.frequency = 'daily'
                    where t.period = d),
    'temps_due', (select count(*) from public.cold_units u
                  where u.active and not exists (
                    select 1 from public.temp_readings r
                    where r.unit_id = u.id and r.day = d and (u.readings_per_day = 1 or r.slot = sl))),
    'temps_alerts', (select count(*) from public.temp_readings r join public.cold_units u on u.id = r.unit_id and u.active
                     where r.out_of_range and r.corrective = '' and r.day >= d - 1),
    'dlc_today', (select count(*) from public.trace_items where closed_at is null and use_by = d),
    'dlc_late', (select count(*) from public.trace_items where closed_at is null and use_by < d),
    'low_stock', (select count(*) from public.products where active and threshold > 0 and quantity < threshold),
    'deliveries', (select count(*) from public.orders where status = 'sent'));
end $$;

-- ---------- Sécurité : droits et RLS --------------------------------------------
alter table public.suppliers   enable row level security;
alter table public.products    enable row level security;
alter table public.stock_moves enable row level security;
alter table public.orders      enable row level security;
alter table public.order_lines enable row level security;

revoke all on public.suppliers, public.products, public.stock_moves, public.orders, public.order_lines from anon, authenticated;
-- Lecture par toute l'équipe, y compris dans une session à code PIN.
grant select on public.suppliers, public.products, public.stock_moves, public.orders, public.order_lines to anon, authenticated;
-- Catalogue tenu par le gérant. La quantité ne se modifie pas ici : seulement par un mouvement de stock.
grant insert, update on public.suppliers to authenticated;
grant insert (name, category, unit, threshold, target, unit_price, supplier_id, active) on public.products to authenticated;
grant update (name, category, unit, threshold, target, unit_price, supplier_id, active) on public.products to authenticated;

create policy "fournisseurs: lecture" on public.suppliers
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "fournisseurs: ajout par le gerant" on public.suppliers
  for insert to authenticated with check ((select public.is_gerant()));
create policy "fournisseurs: modification par le gerant" on public.suppliers
  for update to authenticated using ((select public.is_gerant())) with check ((select public.is_gerant()));

create policy "produits: lecture" on public.products
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "produits: ajout par le gerant" on public.products
  for insert to authenticated with check ((select public.is_gerant()));
create policy "produits: modification par le gerant" on public.products
  for update to authenticated using ((select public.is_gerant())) with check ((select public.is_gerant()));

create policy "mouvements: lecture" on public.stock_moves
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "commandes: lecture" on public.orders
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "lignes: lecture" on public.order_lines
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);

revoke all on function
  public.adjust_stock(uuid, numeric), public.count_stock(jsonb),
  public.save_order(uuid, uuid, text, jsonb), public.send_order(uuid), public.delete_order(uuid),
  public.receive_order(uuid, jsonb, boolean, numeric, text)
  from public;
grant execute on function
  public.adjust_stock(uuid, numeric), public.count_stock(jsonb),
  public.save_order(uuid, uuid, text, jsonb), public.send_order(uuid), public.delete_order(uuid),
  public.receive_order(uuid, jsonb, boolean, numeric, text)
  to anon, authenticated;
revoke all on function public.cancel_order(uuid) from public, anon;
grant execute on function public.cancel_order(uuid) to authenticated;
revoke all on function public._member(), public._move_stock(uuid, numeric, text, text, uuid) from public, anon, authenticated;
