-- =====================================================================
-- Nuba Gestion · migration 0009 · fiches techniques, maintenance, procédures
--
-- À exécuter une seule fois dans Supabase, après la 0008 :
--   SQL Editor > New query > coller tout ce fichier > Run.
--
-- Principes :
--   * fiches techniques : ingrédients, grammages, préparation et allergènes,
--     lisibles par toute l'équipe ; le gérant les écrit et voit leur coût ;
--   * pannes : n'importe qui signale et suit une panne ;
--   * échéances (contrôles, contrats, documents de l'équipe) : réservées au
--     gérant, avec rappel sur son accueil ;
--   * procédures : chacun les lit et confirme sa lecture ; le gérant les écrit
--     et voit qui les a lues.
-- =====================================================================

-- ---------- Fiches techniques ------------------------------------------------
create table public.recipes (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) > 0),
  category   text not null default 'Cuisine',
  portions   numeric(6, 2) not null default 1 check (portions > 0),
  sale_price numeric(10, 2) check (sale_price is null or sale_price >= 0),
  vat        numeric(4, 1) not null default 10 check (vat between 0 and 30),
  method     text not null default '',
  allergens  text[] not null default '{}',
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- Un ingrédient : un produit du stock (coût calculé) ou une ligne libre (coût saisi).
-- pack_size : combien d'unités de la recette contient une unité du produit (70 cl dans une bouteille de 70 cl).
create table public.recipe_items (
  id          uuid primary key default gen_random_uuid(),
  recipe_id   uuid not null references public.recipes (id) on delete cascade,
  product_id  uuid references public.products (id) on delete set null,
  label       text not null default '',
  quantity    numeric(10, 3) not null check (quantity > 0),
  unit        text not null default '',
  pack_size   numeric(10, 3) not null default 1 check (pack_size > 0),
  manual_cost numeric(10, 2) check (manual_cost is null or manual_cost >= 0),
  position    int not null default 0
);
create index recipe_items_by_recipe on public.recipe_items (recipe_id, position);

-- Créer ou modifier une fiche technique et ses ingrédients. Réservé au gérant.
-- p : champs de la fiche ; p_items : [{product_id?, label, quantity, unit, pack_size?, manual_cost?}].
create function public.save_recipe(p_id uuid, p jsonb, p_items jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := p_id;
  it   jsonb;
  n    int := 0;
begin
  if not public.is_gerant() then
    raise exception 'Réservé au gérant.' using errcode = '42501';
  end if;
  if v_id is null then
    insert into public.recipes (name, category, portions, sale_price, vat, method, allergens)
      values (btrim(p ->> 'name'), coalesce(nullif(btrim(p ->> 'category'), ''), 'Cuisine'), coalesce(nullif(p ->> 'portions', '')::numeric, 1),
              nullif(p ->> 'sale_price', '')::numeric, coalesce(nullif(p ->> 'vat', '')::numeric, 10), coalesce(p ->> 'method', ''),
              coalesce((select array_agg(a order by a) from jsonb_array_elements_text(coalesce(p -> 'allergens', '[]'::jsonb)) a), '{}'))
      returning id into v_id;
  else
    update public.recipes
      set name = btrim(p ->> 'name'), category = coalesce(nullif(btrim(p ->> 'category'), ''), 'Cuisine'),
          portions = coalesce(nullif(p ->> 'portions', '')::numeric, 1), sale_price = nullif(p ->> 'sale_price', '')::numeric,
          vat = coalesce(nullif(p ->> 'vat', '')::numeric, 10), method = coalesce(p ->> 'method', ''),
          allergens = coalesce((select array_agg(a order by a) from jsonb_array_elements_text(coalesce(p -> 'allergens', '[]'::jsonb)) a), '{}'),
          active = coalesce((p ->> 'active')::boolean, active)
      where id = v_id;
    if not found then raise exception 'Fiche introuvable.' using errcode = 'P0001'; end if;
    delete from public.recipe_items where recipe_id = v_id;
  end if;

  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    continue when coalesce(nullif(it ->> 'quantity', '')::numeric, 0) <= 0;
    n := n + 1;
    insert into public.recipe_items (recipe_id, product_id, label, quantity, unit, pack_size, manual_cost, position)
      values (v_id, nullif(it ->> 'product_id', '')::uuid, btrim(coalesce(it ->> 'label', '')), (it ->> 'quantity')::numeric,
              btrim(coalesce(it ->> 'unit', '')), coalesce(nullif(it ->> 'pack_size', '')::numeric, 1), nullif(it ->> 'manual_cost', '')::numeric, n);
  end loop;
  return v_id;
end $$;

-- ---------- Pannes -----------------------------------------------------------
create table public.issues (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (length(btrim(title)) > 0),
  place       text not null default '',
  details     text not null default '',
  urgent      boolean not null default false,
  status      text not null default 'open' check (status in ('open', 'doing', 'done')),
  resolution  text not null default '',
  reported_by uuid references public.profiles (id) on delete set null,
  reported_at timestamptz not null default now(),
  closed_by   uuid references public.profiles (id) on delete set null,
  closed_at   timestamptz
);
create index issues_by_status on public.issues (status, reported_at desc);

-- Signaler une panne. Toute l'équipe.
create function public.report_issue(p_title text, p_place text, p_details text, p_urgent boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me_id uuid := public._member();
  v_id  uuid;
begin
  if length(btrim(coalesce(p_title, ''))) = 0 then raise exception 'Décris la panne en quelques mots.' using errcode = 'P0001'; end if;
  insert into public.issues (title, place, details, urgent, reported_by)
    values (btrim(p_title), btrim(coalesce(p_place, '')), btrim(coalesce(p_details, '')), coalesce(p_urgent, false), me_id)
    returning id into v_id;
  return v_id;
end $$;

-- Faire avancer une panne : 'open', 'doing' (en cours de réparation) ou 'done' (réparée).
create function public.set_issue_status(p_id uuid, p_status text, p_resolution text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me_id uuid := public._member();
begin
  if p_status is null or p_status not in ('open', 'doing', 'done') then raise exception 'Statut inconnu.' using errcode = 'P0001'; end if;
  update public.issues
    set status = p_status, resolution = coalesce(nullif(btrim(coalesce(p_resolution, '')), ''), resolution),
        closed_by = case when p_status = 'done' then me_id end, closed_at = case when p_status = 'done' then now() end
    where id = p_id;
  if not found then raise exception 'Panne introuvable.' using errcode = 'P0001'; end if;
end $$;

-- ---------- Échéances (gérant) ----------------------------------------------
create table public.deadlines (
  id            uuid primary key default gen_random_uuid(),
  title         text not null check (length(btrim(title)) > 0),
  category      text not null default 'controle' check (category in ('controle', 'contrat', 'document', 'autre')),
  due_date      date not null,
  repeat_months int check (repeat_months is null or repeat_months between 1 and 240),
  profile_id    uuid references public.profiles (id) on delete cascade,
  note          text not null default '',
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create index deadlines_by_due on public.deadlines (due_date) where active;

create table public.deadline_done (
  id          uuid primary key default gen_random_uuid(),
  deadline_id uuid not null references public.deadlines (id) on delete cascade,
  done_on     date not null,
  done_by     uuid references public.profiles (id) on delete set null,
  note        text not null default ''
);

-- Échéance faite : une échéance qui revient est reportée, une échéance unique est classée.
create function public.complete_deadline(p_id uuid, p_done_on date, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  d   public.deadlines;
  day date := coalesce(p_done_on, (now() at time zone 'Europe/Paris')::date);
begin
  if not public.is_gerant() then
    raise exception 'Réservé au gérant.' using errcode = '42501';
  end if;
  select * into d from public.deadlines where id = p_id and active for update;
  if not found then raise exception 'Échéance introuvable.' using errcode = 'P0001'; end if;
  insert into public.deadline_done (deadline_id, done_on, done_by, note)
    values (p_id, day, public.my_profile_id(), btrim(coalesce(p_note, '')));
  if d.repeat_months is null then
    update public.deadlines set active = false where id = p_id;
  else
    update public.deadlines set due_date = (day + make_interval(months => d.repeat_months))::date where id = p_id;
  end if;
end $$;

-- ---------- Procédures et formation ---------------------------------------
create table public.procedures (
  id         uuid primary key default gen_random_uuid(),
  title      text not null check (length(btrim(title)) > 0),
  category   text not null default 'Général',
  body       text not null default '',
  must_read  boolean not null default true,
  position   int not null default 0,
  active     boolean not null default true,
  updated_at timestamptz not null default now()
);

create table public.procedure_reads (
  procedure_id uuid not null references public.procedures (id) on delete cascade,
  profile_id   uuid not null references public.profiles (id) on delete cascade,
  read_at      timestamptz not null default now(),
  primary key (procedure_id, profile_id)
);

-- Créer ou modifier une procédure. p_reset : redemander la lecture à tout le monde. Réservé au gérant.
create function public.save_procedure(p_id uuid, p_title text, p_category text, p_body text, p_must_read boolean, p_reset boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := p_id;
begin
  if not public.is_gerant() then
    raise exception 'Réservé au gérant.' using errcode = '42501';
  end if;
  if v_id is null then
    insert into public.procedures (title, category, body, must_read, position)
      values (btrim(p_title), coalesce(nullif(btrim(p_category), ''), 'Général'), coalesce(p_body, ''), coalesce(p_must_read, true),
              coalesce((select max(position) + 1 from public.procedures), 0))
      returning id into v_id;
  else
    update public.procedures
      set title = btrim(p_title), category = coalesce(nullif(btrim(p_category), ''), 'Général'), body = coalesce(p_body, ''),
          must_read = coalesce(p_must_read, true), updated_at = now()
      where id = v_id;
    if not found then raise exception 'Procédure introuvable.' using errcode = 'P0001'; end if;
    if coalesce(p_reset, false) then delete from public.procedure_reads where procedure_id = v_id; end if;
  end if;
  return v_id;
end $$;

-- « J'ai lu et compris ».
create function public.ack_procedure(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me_id uuid := public._member();
begin
  if not exists (select 1 from public.procedures where id = p_id and active) then
    raise exception 'Procédure introuvable.' using errcode = 'P0001';
  end if;
  insert into public.procedure_reads (procedure_id, profile_id) values (p_id, me_id) on conflict do nothing;
end $$;

-- ---------- Accueil : pannes, procédures à lire, échéances du gérant ----------
create or replace function public.today_tasks() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  d   date := public.service_day();
  sl  text := public._slot();
  me  uuid := public.my_profile_id();
begin
  if me is null then return null; end if;
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
    'deliveries', (select count(*) from public.orders where status = 'sent'),
    'bookings', (select count(*) from public.reservations where day = d and status in ('confirmed', 'seated')),
    'covers', (select coalesce(sum(party), 0) from public.reservations where day = d and status in ('confirmed', 'seated')),
    'events_today', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'title', e.title, 'start_time', to_char(e.start_time, 'HH24:MI'), 'guests', e.guests)
                                               order by e.start_time nulls last), '[]'::jsonb)
                     from public.events e
                     where d between e.day and coalesce(e.end_day, e.day) and e.status in ('acompte', 'confirme')),
    'event_requests', (select count(*) from public.events where status = 'demande'),
    'issues_open', (select count(*) from public.issues where status <> 'done'),
    'issues_urgent', (select count(*) from public.issues where status <> 'done' and urgent),
    'procedures_unread', (select count(*) from public.procedures p
                          where p.active and p.must_read
                            and not exists (select 1 from public.procedure_reads r where r.procedure_id = p.id and r.profile_id = me)),
    -- Échéances dans les 30 jours ou dépassées : seulement pour le gérant.
    'deadlines_due', case when public.is_gerant()
                          then (select count(*) from public.deadlines where active and due_date <= d + 30) end);
end $$;

-- ---------- Sécurité : droits et RLS --------------------------------------------
alter table public.recipes         enable row level security;
alter table public.recipe_items    enable row level security;
alter table public.issues          enable row level security;
alter table public.deadlines       enable row level security;
alter table public.deadline_done   enable row level security;
alter table public.procedures      enable row level security;
alter table public.procedure_reads enable row level security;

revoke all on public.recipes, public.recipe_items, public.issues, public.deadlines, public.deadline_done,
              public.procedures, public.procedure_reads from anon, authenticated;
-- Lecture par toute l'équipe, y compris dans une session à code PIN.
grant select on public.recipes, public.recipe_items, public.issues, public.procedures, public.procedure_reads to anon, authenticated;
-- Échéances : le gérant seulement, avec son compte.
grant select, insert, update, delete on public.deadlines to authenticated;
grant select on public.deadline_done to authenticated;
grant update (active) on public.procedures to authenticated;
grant delete on public.recipes, public.issues to authenticated;

create policy "fiches: lecture" on public.recipes
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "fiches: suppression par le gerant" on public.recipes
  for delete to authenticated using ((select public.is_gerant()));
create policy "ingredients: lecture" on public.recipe_items
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);

create policy "pannes: lecture" on public.issues
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "pannes: suppression par le gerant" on public.issues
  for delete to authenticated using ((select public.is_gerant()));

create policy "echeances: tout pour le gerant" on public.deadlines
  for all to authenticated using ((select public.is_gerant())) with check ((select public.is_gerant()));
create policy "echeances faites: lecture par le gerant" on public.deadline_done
  for select to authenticated using ((select public.is_gerant()));

create policy "procedures: lecture" on public.procedures
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "procedures: retrait par le gerant" on public.procedures
  for update to authenticated using ((select public.is_gerant())) with check ((select public.is_gerant()));
-- Chacun voit ses lectures ; le gérant voit celles de toute l'équipe.
create policy "lectures: lecture" on public.procedure_reads
  for select to anon, authenticated
  using (profile_id = (select public.my_profile_id()) or (select public.is_gerant()));

revoke all on function
  public.report_issue(text, text, text, boolean), public.set_issue_status(uuid, text, text), public.ack_procedure(uuid)
  from public;
grant execute on function
  public.report_issue(text, text, text, boolean), public.set_issue_status(uuid, text, text), public.ack_procedure(uuid)
  to anon, authenticated;
revoke all on function
  public.save_recipe(uuid, jsonb, jsonb), public.complete_deadline(uuid, date, text),
  public.save_procedure(uuid, text, text, text, boolean, boolean)
  from public, anon;
grant execute on function
  public.save_recipe(uuid, jsonb, jsonb), public.complete_deadline(uuid, date, text),
  public.save_procedure(uuid, text, text, text, boolean, boolean)
  to authenticated;

-- ---------- Modèles de procédures, à adapter à la Nuba ------------------------
insert into public.procedures (title, category, body, must_read, position) values
  ('Bienvenue dans l''équipe', 'Accueil',
   E'Modèle à adapter.\n\nTon premier jour :\n- Présentation de l''équipe et visite des lieux : salle, bar, cuisine, réserve, vestiaire.\n- Où pointer : sur ton téléphone avec le QR code de la borne, ou sur l''iPad avec ton code PIN.\n- Où trouver ton planning, les checklists et les fiches techniques : dans l''appli.\n\nÀ qui t''adresser :\n- Une question sur ton planning, un retard, une absence : préviens le gérant le plus tôt possible.\n- Une panne ou un danger : signale-le tout de suite dans l''appli, rubrique Maintenance.', true, 1),
  ('Hygiène : les gestes de base', 'Hygiène',
   E'Modèle à adapter à ton plan de maîtrise sanitaire.\n\n- Lave-toi les mains à l''arrivée, après les toilettes, après avoir touché des déchets ou des produits crus, et aussi souvent que nécessaire.\n- Tenue propre, cheveux attachés, pas de bijoux aux mains en cuisine.\n- Relève les températures des enceintes froides le matin et le soir dans l''appli. Hors de la cible, note l''action corrective.\n- Étiquette chaque préparation et chaque produit entamé avec sa date limite.\n- Malade ou blessé à la main : préviens le gérant avant de prendre ton poste.', true, 2),
  ('Allergènes : répondre à un client', 'Service',
   E'Modèle à adapter.\n\n- Ne réponds jamais de mémoire : consulte le tableau des allergènes dans l''appli, rubrique Fiches techniques.\n- En cas de doute, demande à la cuisine ou au bar avant de répondre.\n- Signale l''allergie sur la commande et préviens la personne qui prépare.\n- Si tu ne peux pas garantir l''absence d''un allergène, dis-le clairement au client.', true, 3);
