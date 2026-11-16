-- =====================================================================
-- Nuba Gestion · migration 0007 · réservations de tables
--
-- À exécuter une seule fois dans Supabase, après la 0006 :
--   SQL Editor > New query > coller tout ce fichier > Run.
--
-- Principes :
--   * les clients réservent en ligne sur une page publique (lien ou intégration
--     dans le site web) ; l'équipe saisit les réservations prises par téléphone,
--     sur place ou sur Instagram ; tout arrive dans la même liste ;
--   * en ligne : jusqu'à 9 personnes, sur les créneaux d'ouverture, au moins
--     une heure à l'avance ; à partir de 10, le client appelle ;
--   * la réservation est confirmée à l'écran, avec un lien pour l'annuler ;
--   * horaires, dernier créneau, capacité et règles se modifient dans l'appli ;
--   * les coordonnées des clients ne sont lisibles que par l'équipe.
-- =====================================================================

-- ---------- Règles et horaires -----------------------------------------------
create table public.booking_settings (
  id                boolean primary key default true check (id),
  online_enabled    boolean not null default true,
  slot_minutes      smallint not null default 30 check (slot_minutes in (15, 30, 60)),
  max_party_online  smallint not null default 9 check (max_party_online between 1 and 50),
  min_lead_minutes  int not null default 60 check (min_lead_minutes between 0 and 2880),
  max_days_ahead    smallint not null default 60 check (max_days_ahead between 1 and 365),
  capacity_per_slot int check (capacity_per_slot is null or capacity_per_slot > 0),
  phone             text not null default '',
  notice            text not null default ''
);
insert into public.booking_settings default values;

-- Jour de la semaine : 1 = lundi … 7 = dimanche.
create table public.opening_hours (
  weekday    smallint primary key check (weekday between 1 and 7),
  open       boolean not null default true,
  first_slot time not null default '12:00',
  last_slot  time not null default '22:00',
  break_from time,
  break_to   time,
  constraint opening_hours_order check (last_slot >= first_slot),
  constraint opening_hours_break check ((break_from is null and break_to is null) or (break_to > break_from))
);
-- Ouverture : mardi à jeudi 12 h – 0 h, vendredi 12 h – 2 h, samedi 12 h – 3 h, dimanche 12 h – 16 h, lundi fermé.
-- Dernière réservation : deux heures avant la fermeture, et pas après 22 h 30.
insert into public.opening_hours (weekday, open, first_slot, last_slot) values
  (1, false, '12:00', '22:00'),
  (2, true,  '12:00', '22:00'),
  (3, true,  '12:00', '22:00'),
  (4, true,  '12:00', '22:00'),
  (5, true,  '12:00', '22:30'),
  (6, true,  '12:00', '22:30'),
  (7, true,  '12:00', '14:00');

-- ---------- Réservations ---------------------------------------------------
create table public.reservations (
  id          uuid primary key default gen_random_uuid(),
  day         date not null,
  slot        time not null,
  party       int not null check (party between 1 and 500),
  name        text not null check (length(btrim(name)) > 0),
  phone       text not null default '',
  email       text not null default '',
  note        text not null default '',
  table_label text not null default '',
  source      text not null default 'telephone' check (source in ('en_ligne', 'telephone', 'sur_place', 'instagram', 'autre')),
  status      text not null default 'confirmed' check (status in ('confirmed', 'seated', 'no_show', 'cancelled')),
  code_hash   bytea,
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index reservations_by_day on public.reservations (day, slot);
create index reservations_recent on public.reservations (created_at desc);

-- Créneaux encore réservables en ligne pour un jour et un nombre de personnes.
create function public._booking_slots(p_day date, p_party int) returns setof time
language sql stable security definer set search_path = '' as $$
  select t::time
  from public.booking_settings s
  join public.opening_hours h on h.weekday = extract(isodow from p_day)::int and h.open
  cross join lateral generate_series(p_day + h.first_slot, p_day + h.last_slot, make_interval(mins => s.slot_minutes)) t
  where s.online_enabled
    and p_party between 1 and s.max_party_online
    and p_day <= (now() at time zone 'Europe/Paris')::date + s.max_days_ahead
    and t >= (now() at time zone 'Europe/Paris') + make_interval(mins => s.min_lead_minutes)
    and (h.break_from is null or t::time < h.break_from or t::time >= h.break_to)
    and (s.capacity_per_slot is null or p_party + coalesce((
          select sum(r.party) from public.reservations r
          where r.day = p_day and r.slot = t::time and r.status in ('confirmed', 'seated')), 0) <= s.capacity_per_slot)
  order by t
$$;

-- Ce que la page publique a besoin de savoir : règles et jours d'ouverture. Aucune donnée de client.
create function public.booking_info() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'online_enabled', s.online_enabled, 'max_party_online', s.max_party_online, 'max_days_ahead', s.max_days_ahead,
    'phone', s.phone, 'notice', s.notice,
    'today', (now() at time zone 'Europe/Paris')::date,
    'open_weekdays', (select coalesce(jsonb_agg(weekday order by weekday), '[]'::jsonb) from public.opening_hours where open))
  from public.booking_settings s
$$;

-- Créneaux libres d'un jour, pour la page publique.
create function public.booking_slots(p_day date, p_party int) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(to_char(s, 'HH24:MI') order by s), '[]'::jsonb) from public._booking_slots(p_day, p_party) s
$$;

-- Réserver en ligne. Renvoie {ok:true, id, code} ou {ok:false, error}.
-- p_trap est un champ caché du formulaire : un robot le remplit, une personne non.
create function public.book_table(p_day date, p_slot time, p_party int, p_name text, p_phone text, p_email text, p_note text, p_trap text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s      public.booking_settings;
  v_id   uuid;
  v_code text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 20);
  tel    text := regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g');
begin
  select * into s from public.booking_settings;
  if not s.online_enabled then return jsonb_build_object('ok', false, 'error', 'disabled'); end if;
  if length(coalesce(p_trap, '')) > 0 then return jsonb_build_object('ok', false, 'error', 'contact'); end if;
  if length(btrim(coalesce(p_name, ''))) < 2 or length(tel) < 8 then return jsonb_build_object('ok', false, 'error', 'contact'); end if;
  if p_party is null or p_party < 1 or p_party > s.max_party_online then return jsonb_build_object('ok', false, 'error', 'party'); end if;

  -- Garde-fous contre les envois en rafale.
  if (select count(*) from public.reservations where source = 'en_ligne' and created_at > now() - interval '10 minutes') >= 20 then
    return jsonb_build_object('ok', false, 'error', 'too_many');
  end if;
  if (select count(*) from public.reservations
      where source = 'en_ligne' and phone = tel and status = 'confirmed' and day >= (now() at time zone 'Europe/Paris')::date) >= 3 then
    return jsonb_build_object('ok', false, 'error', 'too_many_phone');
  end if;

  perform pg_advisory_xact_lock(7461002, (p_day - date '2020-01-01'));
  if not exists (select 1 from public._booking_slots(p_day, p_party) t where t = p_slot) then
    return jsonb_build_object('ok', false, 'error', 'slot');
  end if;

  insert into public.reservations (day, slot, party, name, phone, email, note, source, code_hash)
    values (p_day, p_slot, p_party, btrim(p_name), tel, lower(btrim(coalesce(p_email, ''))), left(btrim(coalesce(p_note, '')), 300),
            'en_ligne', sha256(convert_to(v_code, 'UTF8')))
    returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'code', v_code);
end $$;

-- La réservation d'un client, retrouvée par son lien (identifiant et code).
create function public.my_booking(p_id uuid, p_code text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('day', r.day, 'slot', to_char(r.slot, 'HH24:MI'), 'party', r.party, 'name', r.name, 'status', r.status,
                            'phone', (select phone from public.booking_settings))
  from public.reservations r
  where r.id = p_id and r.code_hash = sha256(convert_to(coalesce(p_code, ''), 'UTF8'))
$$;

-- Le client annule sa réservation avec son lien.
create function public.cancel_booking(p_id uuid, p_code text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update public.reservations set status = 'cancelled', updated_at = now()
    where id = p_id and code_hash = sha256(convert_to(coalesce(p_code, ''), 'UTF8'))
      and status = 'confirmed' and day >= (now() at time zone 'Europe/Paris')::date;
  return found;
end $$;

-- L'équipe ajoute ou modifie une réservation (téléphone, sur place, Instagram…). Aucune limite de taille ni d'horaire.
create function public.save_reservation(
  p_id uuid, p_day date, p_slot time, p_party int, p_name text, p_phone text, p_email text, p_note text, p_source text, p_table text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me_id uuid := public._member();
  v_id  uuid := p_id;
begin
  if p_day is null or p_slot is null then raise exception 'Indique le jour et l''heure.' using errcode = 'P0001'; end if;
  if p_party is null or p_party < 1 then raise exception 'Indique le nombre de personnes.' using errcode = 'P0001'; end if;
  if length(btrim(coalesce(p_name, ''))) = 0 then raise exception 'Indique le nom du client.' using errcode = 'P0001'; end if;
  if v_id is null then
    insert into public.reservations (day, slot, party, name, phone, email, note, source, table_label, created_by)
      values (p_day, p_slot, p_party, btrim(p_name), btrim(coalesce(p_phone, '')), lower(btrim(coalesce(p_email, ''))),
              btrim(coalesce(p_note, '')), coalesce(nullif(p_source, ''), 'telephone'), btrim(coalesce(p_table, '')), me_id)
      returning id into v_id;
  else
    update public.reservations
      set day = p_day, slot = p_slot, party = p_party, name = btrim(p_name), phone = btrim(coalesce(p_phone, '')),
          email = lower(btrim(coalesce(p_email, ''))), note = btrim(coalesce(p_note, '')),
          table_label = btrim(coalesce(p_table, '')), updated_at = now()
      where id = v_id;
    if not found then raise exception 'Réservation introuvable.' using errcode = 'P0001'; end if;
  end if;
  return v_id;
end $$;

-- Arrivés, absents, annulée, ou retour à « confirmée ».
create function public.set_reservation_status(p_id uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public._member();
  if p_status is null or p_status not in ('confirmed', 'seated', 'no_show', 'cancelled') then
    raise exception 'Statut inconnu.' using errcode = 'P0001';
  end if;
  update public.reservations set status = p_status, updated_at = now() where id = p_id;
  if not found then raise exception 'Réservation introuvable.' using errcode = 'P0001'; end if;
end $$;

-- ---------- Accueil : ajoute les réservations du jour -------------------------
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
    'covers', (select coalesce(sum(party), 0) from public.reservations where day = d and status in ('confirmed', 'seated')));
end $$;

-- ---------- Sécurité : droits et RLS --------------------------------------------
alter table public.booking_settings enable row level security;
alter table public.opening_hours    enable row level security;
alter table public.reservations     enable row level security;

revoke all on public.booking_settings, public.opening_hours, public.reservations from anon, authenticated;
-- Lecture par l'équipe, y compris dans une session à code PIN. Le public ne lit rien directement :
-- la page de réservation passe par booking_info, booking_slots, book_table, my_booking et cancel_booking.
grant select on public.booking_settings, public.opening_hours, public.reservations to anon, authenticated;
grant update on public.booking_settings, public.opening_hours to authenticated;

create policy "regles: lecture" on public.booking_settings
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "regles: modification par le gerant" on public.booking_settings
  for update to authenticated using ((select public.is_gerant())) with check ((select public.is_gerant()));
create policy "horaires: lecture" on public.opening_hours
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "horaires: modification par le gerant" on public.opening_hours
  for update to authenticated using ((select public.is_gerant())) with check ((select public.is_gerant()));
create policy "reservations: lecture" on public.reservations
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);

revoke all on function
  public.booking_info(), public.booking_slots(date, int),
  public.book_table(date, time, int, text, text, text, text, text),
  public.my_booking(uuid, text), public.cancel_booking(uuid, text),
  public.save_reservation(uuid, date, time, int, text, text, text, text, text, text),
  public.set_reservation_status(uuid, text)
  from public;
grant execute on function
  public.booking_info(), public.booking_slots(date, int),
  public.book_table(date, time, int, text, text, text, text, text),
  public.my_booking(uuid, text), public.cancel_booking(uuid, text),
  public.save_reservation(uuid, date, time, int, text, text, text, text, text, text),
  public.set_reservation_status(uuid, text)
  to anon, authenticated;
revoke all on function public._booking_slots(date, int) from public, anon, authenticated;
