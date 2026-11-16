-- =====================================================================
-- Nuba Gestion · migration 0008 · événements et fichier clients
--
-- À exécuter une seule fois dans Supabase, après la 0007 :
--   SQL Editor > New query > coller tout ce fichier > Run.
--
-- Principes :
--   * un événement est une privatisation, un concert, une exposition ou une
--     prestation extérieure ; il avance de la demande au devis, à l'acompte,
--     puis à la confirmation ;
--   * chaque événement a sa liste de choses à préparer, que l'équipe coche ;
--   * les clients peuvent envoyer une demande depuis une page publique ; elle
--     arrive comme « demande » ; l'équipe peut aussi en noter une ;
--   * le gérant chiffre, confirme et modifie ; toute l'équipe consulte ;
--   * le fichier clients regroupe particuliers, entreprises, artistes et
--     prestataires ; il n'est lisible que par l'équipe.
-- =====================================================================

-- ---------- Fichier clients --------------------------------------------------
create table public.customers (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) > 0),
  kind       text not null default 'particulier' check (kind in ('particulier', 'entreprise', 'artiste', 'prestataire')),
  company    text not null default '',
  phone      text not null default '',
  email      text not null default '',
  note       text not null default '',
  active     boolean not null default true,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index customers_by_name on public.customers (lower(name));

-- Ajouter ou modifier une fiche. Toute l'équipe peut le faire.
create function public.save_customer(p_id uuid, p_name text, p_kind text, p_company text, p_phone text, p_email text, p_note text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me_id uuid := public._member();
  v_id  uuid := p_id;
begin
  if length(btrim(coalesce(p_name, ''))) = 0 then raise exception 'Indique le nom.' using errcode = 'P0001'; end if;
  if v_id is null then
    insert into public.customers (name, kind, company, phone, email, note, created_by)
      values (btrim(p_name), coalesce(nullif(p_kind, ''), 'particulier'), btrim(coalesce(p_company, '')), btrim(coalesce(p_phone, '')),
              lower(btrim(coalesce(p_email, ''))), btrim(coalesce(p_note, '')), me_id)
      returning id into v_id;
  else
    update public.customers
      set name = btrim(p_name), kind = coalesce(nullif(p_kind, ''), kind), company = btrim(coalesce(p_company, '')),
          phone = btrim(coalesce(p_phone, '')), email = lower(btrim(coalesce(p_email, ''))), note = btrim(coalesce(p_note, ''))
      where id = v_id;
    if not found then raise exception 'Fiche introuvable.' using errcode = 'P0001'; end if;
  end if;
  return v_id;
end $$;

-- ---------- Événements ---------------------------------------------------
create table public.events (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in ('privatisation', 'concert', 'exposition', 'exterieur')),
  title        text not null check (length(btrim(title)) > 0),
  day          date not null,
  end_day      date,
  start_time   time,
  guests       int check (guests is null or guests between 1 and 5000),
  status       text not null default 'demande' check (status in ('demande', 'devis', 'acompte', 'confirme', 'termine', 'annule')),
  customer_id  uuid references public.customers (id) on delete set null,
  site_id      uuid references public.sites (id) on delete set null,
  amount       numeric(10, 2) check (amount is null or amount >= 0),
  deposit      numeric(10, 2) check (deposit is null or deposit >= 0),
  deposit_paid boolean not null default false,
  details      text not null default '',
  note         text not null default '',
  source       text not null default 'equipe' check (source in ('equipe', 'en_ligne')),
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  constraint events_days check (end_day is null or end_day >= day)
);
create index events_by_day on public.events (day);

create table public.event_tasks (
  id       uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  label    text not null check (length(btrim(label)) > 0),
  position int not null default 0,
  done_by  uuid references public.profiles (id) on delete set null,
  done_at  timestamptz
);
create index event_tasks_by_event on public.event_tasks (event_id, position);

-- Choses à préparer proposées à la création, selon le type d'événement.
create function public._seed_event_tasks(p_event uuid, p_kind text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  labels text[] := case p_kind
    when 'privatisation' then array['Devis signé', 'Acompte encaissé', 'Menu validé avec la cuisine', 'Plan de salle envoyé au client', 'Équipe prévue au planning']
    when 'concert' then array['Contrat signé', 'Fiche technique reçue', 'Déclaration des droits d''auteur', 'Repas des artistes prévu', 'Annonce publiée']
    when 'exposition' then array['Contrats de dépôt signés', 'Accrochage terminé', 'Cartels et liste de prix imprimés', 'Vernissage annoncé']
    else array['Devis signé', 'Acompte encaissé', 'Matériel listé et chargé', 'Équipe prévue au planning', 'Lieu et accès confirmés avec le client']
  end;
  i int;
begin
  for i in 1 .. array_length(labels, 1) loop
    insert into public.event_tasks (event_id, label, position) values (p_event, labels[i], i);
  end loop;
end $$;

-- Créer ou modifier un événement. Réservé au gérant. p : les champs de l'événement.
create function public.save_event(p_id uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := p_id;
begin
  if not public.is_gerant() then
    raise exception 'Réservé au gérant.' using errcode = '42501';
  end if;
  if v_id is null then
    insert into public.events (kind, title, day, end_day, start_time, guests, status, customer_id, site_id, amount, deposit, deposit_paid, details, note, created_by)
      values (p ->> 'kind', btrim(p ->> 'title'), (p ->> 'day')::date, nullif(p ->> 'end_day', '')::date, nullif(p ->> 'start_time', '')::time,
              nullif(p ->> 'guests', '')::int, coalesce(nullif(p ->> 'status', ''), 'demande'), nullif(p ->> 'customer_id', '')::uuid,
              nullif(p ->> 'site_id', '')::uuid, nullif(p ->> 'amount', '')::numeric, nullif(p ->> 'deposit', '')::numeric,
              coalesce((p ->> 'deposit_paid')::boolean, false), btrim(coalesce(p ->> 'details', '')), btrim(coalesce(p ->> 'note', '')),
              public.my_profile_id())
      returning id into v_id;
    perform public._seed_event_tasks(v_id, p ->> 'kind');
  else
    update public.events
      set kind = p ->> 'kind', title = btrim(p ->> 'title'), day = (p ->> 'day')::date, end_day = nullif(p ->> 'end_day', '')::date,
          start_time = nullif(p ->> 'start_time', '')::time, guests = nullif(p ->> 'guests', '')::int,
          status = coalesce(nullif(p ->> 'status', ''), status), customer_id = nullif(p ->> 'customer_id', '')::uuid,
          site_id = nullif(p ->> 'site_id', '')::uuid, amount = nullif(p ->> 'amount', '')::numeric,
          deposit = nullif(p ->> 'deposit', '')::numeric, deposit_paid = coalesce((p ->> 'deposit_paid')::boolean, false),
          details = btrim(coalesce(p ->> 'details', '')), note = btrim(coalesce(p ->> 'note', ''))
      where id = v_id;
    if not found then raise exception 'Événement introuvable.' using errcode = 'P0001'; end if;
  end if;
  return v_id;
end $$;

-- L'équipe note une demande reçue au bar ou par téléphone : le gérant la traitera.
create function public.request_event(p_kind text, p_title text, p_day date, p_guests int, p_customer uuid, p_note text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me_id uuid := public._member();
  v_id  uuid;
begin
  if p_day is null or length(btrim(coalesce(p_title, ''))) = 0 then
    raise exception 'Indique un titre et une date.' using errcode = 'P0001';
  end if;
  insert into public.events (kind, title, day, guests, status, customer_id, note, created_by)
    values (p_kind, btrim(p_title), p_day, p_guests, 'demande', p_customer, btrim(coalesce(p_note, '')), me_id)
    returning id into v_id;
  perform public._seed_event_tasks(v_id, p_kind);
  return v_id;
end $$;

-- Cocher ou décocher une chose à préparer.
create function public.tick_event_task(p_task uuid, p_done boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me_id uuid := public._member();
begin
  update public.event_tasks
    set done_by = case when p_done then me_id end, done_at = case when p_done then now() end
    where id = p_task;
  if not found then raise exception 'Tâche introuvable.' using errcode = 'P0001'; end if;
end $$;

-- Demande envoyée par un client depuis la page publique. Renvoie {ok} ou {ok:false, error}.
create function public.request_private_event(
  p_kind text, p_day date, p_guests int, p_name text, p_company text, p_phone text, p_email text, p_message text, p_trap text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  tel  text := regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g');
  c_id uuid;
  e_id uuid;
begin
  if length(coalesce(p_trap, '')) > 0 then return jsonb_build_object('ok', false, 'error', 'contact'); end if;
  if length(btrim(coalesce(p_name, ''))) < 2 or length(tel) < 8 then return jsonb_build_object('ok', false, 'error', 'contact'); end if;
  if p_kind is null or p_kind not in ('privatisation', 'exterieur') then return jsonb_build_object('ok', false, 'error', 'kind'); end if;
  if p_day is null or p_day < (now() at time zone 'Europe/Paris')::date or p_day > (now() at time zone 'Europe/Paris')::date + 730 then
    return jsonb_build_object('ok', false, 'error', 'day');
  end if;
  if p_guests is null or p_guests < 1 or p_guests > 2000 then return jsonb_build_object('ok', false, 'error', 'guests'); end if;
  if (select count(*) from public.events where source = 'en_ligne' and created_at > now() - interval '10 minutes') >= 10 then
    return jsonb_build_object('ok', false, 'error', 'too_many');
  end if;

  -- Même téléphone : on complète la fiche existante plutôt que d'en créer une seconde.
  select id into c_id from public.customers where regexp_replace(phone, '[^0-9+]', '', 'g') = tel and active limit 1;
  if c_id is null then
    insert into public.customers (name, kind, company, phone, email)
      values (btrim(p_name), case when length(btrim(coalesce(p_company, ''))) > 0 then 'entreprise' else 'particulier' end,
              btrim(coalesce(p_company, '')), tel, lower(btrim(coalesce(p_email, ''))))
      returning id into c_id;
  end if;
  insert into public.events (kind, title, day, guests, status, customer_id, note, source)
    values (p_kind, case p_kind when 'exterieur' then 'Prestation extérieure' else 'Privatisation' end || ', ' || btrim(p_name),
            p_day, p_guests, 'demande', c_id, left(btrim(coalesce(p_message, '')), 1000), 'en_ligne')
    returning id into e_id;
  perform public._seed_event_tasks(e_id, p_kind);
  return jsonb_build_object('ok', true);
end $$;

-- ---------- Accueil : ajoute les événements ---------------------------------
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
    'deliveries', (select count(*) from public.orders where status = 'sent'),
    'bookings', (select count(*) from public.reservations where day = d and status in ('confirmed', 'seated')),
    'covers', (select coalesce(sum(party), 0) from public.reservations where day = d and status in ('confirmed', 'seated')),
    'events_today', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'title', e.title, 'start_time', to_char(e.start_time, 'HH24:MI'), 'guests', e.guests)
                                               order by e.start_time nulls last), '[]'::jsonb)
                     from public.events e
                     where d between e.day and coalesce(e.end_day, e.day) and e.status in ('acompte', 'confirme')),
    'event_requests', (select count(*) from public.events where status = 'demande'));
end $$;

-- ---------- Sécurité : droits et RLS --------------------------------------------
alter table public.customers   enable row level security;
alter table public.events      enable row level security;
alter table public.event_tasks enable row level security;

revoke all on public.customers, public.events, public.event_tasks from anon, authenticated;
grant select on public.customers, public.events, public.event_tasks to anon, authenticated;
grant update (active) on public.customers to authenticated;
grant insert, delete on public.event_tasks to authenticated;
grant delete on public.events to authenticated;

create policy "clients: lecture" on public.customers
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "clients: retrait par le gerant" on public.customers
  for update to authenticated using ((select public.is_gerant())) with check ((select public.is_gerant()));
create policy "evenements: lecture" on public.events
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "evenements: suppression par le gerant" on public.events
  for delete to authenticated using ((select public.is_gerant()));
create policy "preparation: lecture" on public.event_tasks
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "preparation: ajout par le gerant" on public.event_tasks
  for insert to authenticated with check ((select public.is_gerant()));
create policy "preparation: retrait par le gerant" on public.event_tasks
  for delete to authenticated using ((select public.is_gerant()));

revoke all on function
  public.save_customer(uuid, text, text, text, text, text, text),
  public.request_event(text, text, date, int, uuid, text), public.tick_event_task(uuid, boolean),
  public.request_private_event(text, date, int, text, text, text, text, text, text)
  from public;
grant execute on function
  public.save_customer(uuid, text, text, text, text, text, text),
  public.request_event(text, text, date, int, uuid, text), public.tick_event_task(uuid, boolean),
  public.request_private_event(text, date, int, text, text, text, text, text, text)
  to anon, authenticated;
revoke all on function public.save_event(uuid, jsonb) from public, anon;
grant execute on function public.save_event(uuid, jsonb) to authenticated;
revoke all on function public._seed_event_tasks(uuid, text) from public, anon, authenticated;
