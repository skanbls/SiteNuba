-- =====================================================================
-- Nuba Gestion · migration 0005 · checklists et hygiène
--
-- À exécuter une seule fois dans Supabase, après la 0004 :
--   SQL Editor > New query > coller tout ce fichier > Run.
--
-- Principes :
--   * une checklist se coche pour une période : le jour de service, la semaine
--     ou le mois ; chaque case garde qui l'a cochée et quand ;
--   * le jour de service va de 5 h du matin à 5 h le lendemain (heure de Paris) :
--     la fermeture de 2 h du matin appartient encore à la soirée ;
--   * hygiène : relevés de température avec action corrective obligatoire hors
--     limite, plan de nettoyage (des checklists), dates limites des préparations
--     et des produits entamés, suivi de l'huile de friture ;
--   * toute l'équipe coche et relève, sur son téléphone comme sur l'iPad ; le
--     gérant compose les listes et les enceintes. Des modèles sont proposés.
-- =====================================================================

-- ---------- Jour de service et périodes -----------------------------------
create function public.service_day() returns date
language sql stable set search_path = '' as $$
  select ((now() at time zone 'Europe/Paris') - interval '5 hours')::date
$$;

create function public._period(p_frequency text, p_day date) returns date
language sql immutable set search_path = '' as $$
  select case p_frequency
    when 'weekly' then date_trunc('week', p_day)::date
    when 'monthly' then date_trunc('month', p_day)::date
    else p_day
  end
$$;

-- ---------- Checklists -----------------------------------------------------
create table public.checklists (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) > 0),
  kind       text not null default 'service' check (kind in ('service', 'nettoyage')),
  frequency  text not null default 'daily' check (frequency in ('daily', 'weekly', 'monthly')),
  position   int not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.checklist_items (
  id           uuid primary key default gen_random_uuid(),
  checklist_id uuid not null references public.checklists (id) on delete cascade,
  label        text not null check (length(btrim(label)) > 0),
  position     int not null default 0,
  active       boolean not null default true
);
create index checklist_items_by_list on public.checklist_items (checklist_id, position);

create table public.checklist_ticks (
  item_id uuid not null references public.checklist_items (id) on delete cascade,
  period  date not null,
  done_by uuid references public.profiles (id) on delete set null,
  done_at timestamptz not null default now(),
  primary key (item_id, period)
);
create index checklist_ticks_by_period on public.checklist_ticks (period);

-- Les checklists actives avec leurs cases, cochées ou non pour la période en cours.
create function public.checklists_today() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  d date := public.service_day();
begin
  if public.my_profile_id() is null then return null; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', c.id, 'name', c.name, 'kind', c.kind, 'frequency', c.frequency,
      'items', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', i.id, 'label', i.label, 'done', t.item_id is not null,
          'done_by', t.done_by, 'done_by_name', p.first_name, 'done_at', t.done_at)
          order by i.position, i.label)
        from public.checklist_items i
        left join public.checklist_ticks t on t.item_id = i.id and t.period = public._period(c.frequency, d)
        left join public.profiles p on p.id = t.done_by
        where i.checklist_id = c.id and i.active), '[]'::jsonb))
      order by c.position, c.name)
    from public.checklists c where c.active), '[]'::jsonb);
end $$;

-- Cocher ou décocher une case pour la période en cours.
-- On ne décoche que sa propre case ; le gérant peut tout décocher.
create function public.tick_item(p_item uuid, p_done boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me_id uuid := public.my_profile_id();
  per   date;
  t     public.checklist_ticks;
begin
  if me_id is null then return jsonb_build_object('ok', false, 'error', 'no_profile'); end if;
  select public._period(c.frequency, public.service_day()) into per
    from public.checklist_items i join public.checklists c on c.id = i.checklist_id
    where i.id = p_item and i.active and c.active;
  if per is null then return jsonb_build_object('ok', false, 'error', 'item'); end if;

  select * into t from public.checklist_ticks where item_id = p_item and period = per;
  if p_done then
    if not found then
      insert into public.checklist_ticks (item_id, period, done_by) values (p_item, per, me_id);
    end if;
  elsif found then
    if t.done_by is distinct from me_id and not public.is_gerant() then
      return jsonb_build_object('ok', false, 'error', 'not_yours');
    end if;
    delete from public.checklist_ticks where item_id = p_item and period = per;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Créer ou modifier une checklist et ses cases, d'un seul coup. Réservé au gérant.
-- p_items : [{id?, label}] dans l'ordre voulu. Une case absente est retirée de la liste,
-- mais son historique est conservé.
create function public.save_checklist(p_id uuid, p_name text, p_kind text, p_frequency text, p_items jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := p_id;
  it   jsonb;
  n    int := 0;
  keep uuid[] := '{}';
  i_id uuid;
begin
  if not public.is_gerant() then
    raise exception 'Réservé au gérant.' using errcode = '42501';
  end if;
  if v_id is null then
    insert into public.checklists (name, kind, frequency, position)
      values (btrim(p_name), p_kind, p_frequency, coalesce((select max(position) + 1 from public.checklists), 0))
      returning id into v_id;
  else
    update public.checklists set name = btrim(p_name), kind = p_kind, frequency = p_frequency where id = v_id;
    if not found then raise exception 'Checklist introuvable.' using errcode = 'P0001'; end if;
  end if;

  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    continue when length(btrim(coalesce(it ->> 'label', ''))) = 0;
    n := n + 1;
    i_id := nullif(it ->> 'id', '')::uuid;
    if i_id is not null and exists (select 1 from public.checklist_items where id = i_id and checklist_id = v_id) then
      update public.checklist_items set label = btrim(it ->> 'label'), position = n, active = true where id = i_id;
    else
      insert into public.checklist_items (checklist_id, label, position)
        values (v_id, btrim(it ->> 'label'), n) returning id into i_id;
    end if;
    keep := keep || i_id;
  end loop;
  update public.checklist_items set active = false where checklist_id = v_id and not (id = any (keep));
  return v_id;
end $$;

-- ---------- Températures ----------------------------------------------------
create table public.cold_units (
  id               uuid primary key default gen_random_uuid(),
  name             text not null check (length(btrim(name)) > 0),
  min_temp         numeric(4, 1) not null,
  max_temp         numeric(4, 1) not null,
  readings_per_day smallint not null default 2 check (readings_per_day in (1, 2)),
  position         int not null default 0,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  constraint cold_units_range check (max_temp > min_temp)
);

create table public.temp_readings (
  id           uuid primary key default gen_random_uuid(),
  unit_id      uuid not null references public.cold_units (id) on delete cascade,
  value        numeric(4, 1) not null check (value between -60 and 60),
  day          date not null,
  slot         text not null check (slot in ('matin', 'soir')),
  out_of_range boolean not null,
  corrective   text not null default '',
  taken_by     uuid references public.profiles (id) on delete set null,
  taken_at     timestamptz not null default now()
);
create index temp_readings_by_day on public.temp_readings (day, unit_id);

-- Matin jusqu'à 15 h (heure de Paris), soir ensuite, jusqu'à la fermeture.
create function public._slot() returns text
language sql stable set search_path = '' as $$
  select case when extract(hour from now() at time zone 'Europe/Paris') between 5 and 14 then 'matin' else 'soir' end
$$;

-- Enregistrer un relevé. Hors limite, il attend son action corrective.
create function public.record_temp(p_unit uuid, p_value numeric) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me_id uuid := public.my_profile_id();
  u     public.cold_units;
  v_id  uuid;
  bad   boolean;
begin
  if me_id is null then return jsonb_build_object('ok', false, 'error', 'no_profile'); end if;
  select * into u from public.cold_units where id = p_unit and active;
  if not found then return jsonb_build_object('ok', false, 'error', 'unit'); end if;
  if p_value is null or p_value < -60 or p_value > 60 then return jsonb_build_object('ok', false, 'error', 'value'); end if;
  bad := p_value < u.min_temp or p_value > u.max_temp;
  insert into public.temp_readings (unit_id, value, day, slot, out_of_range, taken_by)
    values (p_unit, round(p_value, 1), public.service_day(), public._slot(), bad, me_id)
    returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'out_of_range', bad);
end $$;

-- Noter l'action corrective d'un relevé hors limite.
create function public.note_corrective(p_reading uuid, p_text text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if public.my_profile_id() is null then raise exception 'Compte non rattaché à l''équipe.' using errcode = '42501'; end if;
  if length(btrim(coalesce(p_text, ''))) = 0 then raise exception 'Décris l''action corrective.' using errcode = 'P0001'; end if;
  update public.temp_readings set corrective = btrim(p_text) where id = p_reading and out_of_range;
  if not found then raise exception 'Relevé introuvable.' using errcode = 'P0001'; end if;
end $$;

-- ---------- Traçabilité : préparations et produits entamés -------------------
create table public.trace_items (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (length(btrim(name)) > 0),
  kind          text not null default 'preparation' check (kind in ('preparation', 'ouverture')),
  made_on       date not null,
  use_by        date not null,
  note          text not null default '',
  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  closed_at     timestamptz,
  closed_by     uuid references public.profiles (id) on delete set null,
  closed_reason text check (closed_reason in ('utilise', 'jete')),
  constraint trace_items_order check (use_by >= made_on)
);
create index trace_items_open on public.trace_items (use_by) where closed_at is null;

-- Sortir une préparation : terminée ('utilise') ou jetée ('jete').
create function public.close_trace(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me_id uuid := public.my_profile_id();
begin
  if me_id is null then raise exception 'Compte non rattaché à l''équipe.' using errcode = '42501'; end if;
  if p_reason is null or p_reason not in ('utilise', 'jete') then raise exception 'Motif inconnu.' using errcode = 'P0001'; end if;
  update public.trace_items set closed_at = now(), closed_by = me_id, closed_reason = p_reason
    where id = p_id and closed_at is null;
  if not found then raise exception 'Étiquette introuvable ou déjà sortie.' using errcode = 'P0001'; end if;
end $$;

-- ---------- Huile de friture -------------------------------------------------
create table public.oil_logs (
  id        uuid primary key default gen_random_uuid(),
  action    text not null check (action in ('test', 'changement')),
  polar_pct numeric(4, 1) check (polar_pct between 0 and 100),
  note      text not null default '',
  done_by   uuid references public.profiles (id) on delete set null,
  done_at   timestamptz not null default now(),
  constraint oil_logs_test_value check (action <> 'test' or polar_pct is not null)
);
create index oil_logs_recent on public.oil_logs (done_at desc);

-- ---------- Ce qu'il y a à faire aujourd'hui (accueil) -------------------------
create function public.today_tasks() returns jsonb
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
    -- Enceintes sans relevé pour ce moment de la journée (ou pour la journée, si un seul relevé suffit).
    'temps_due', (select count(*) from public.cold_units u
                  where u.active and not exists (
                    select 1 from public.temp_readings r
                    where r.unit_id = u.id and r.day = d and (u.readings_per_day = 1 or r.slot = sl))),
    'temps_alerts', (select count(*) from public.temp_readings r join public.cold_units u on u.id = r.unit_id and u.active
                     where r.out_of_range and r.corrective = '' and r.day >= d - 1),
    'dlc_today', (select count(*) from public.trace_items where closed_at is null and use_by = d),
    'dlc_late', (select count(*) from public.trace_items where closed_at is null and use_by < d));
end $$;

-- ---------- Sécurité : droits et RLS --------------------------------------------
alter table public.checklists      enable row level security;
alter table public.checklist_items enable row level security;
alter table public.checklist_ticks enable row level security;
alter table public.cold_units      enable row level security;
alter table public.temp_readings   enable row level security;
alter table public.trace_items     enable row level security;
alter table public.oil_logs        enable row level security;

revoke all on public.checklists, public.checklist_items, public.checklist_ticks, public.cold_units,
              public.temp_readings, public.trace_items, public.oil_logs from anon, authenticated;
-- Lecture par toute l'équipe, y compris dans une session à code PIN (rôle anon avec ticket).
grant select on public.checklists, public.checklist_items, public.checklist_ticks, public.cold_units,
                public.temp_readings, public.trace_items, public.oil_logs to anon, authenticated;
grant insert on public.trace_items, public.oil_logs to anon, authenticated;
-- Gestion par le gérant, avec son compte.
grant insert, update, delete on public.cold_units to authenticated;
grant delete on public.checklists, public.temp_readings, public.trace_items, public.oil_logs to authenticated;
grant update on public.checklists to authenticated;

create policy "checklists: lecture" on public.checklists
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "checklists: modification par le gerant" on public.checklists
  for update to authenticated using ((select public.is_gerant())) with check ((select public.is_gerant()));
create policy "checklists: suppression par le gerant" on public.checklists
  for delete to authenticated using ((select public.is_gerant()));
create policy "cases: lecture" on public.checklist_items
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "coches: lecture" on public.checklist_ticks
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);

create policy "enceintes: lecture" on public.cold_units
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "enceintes: ajout par le gerant" on public.cold_units
  for insert to authenticated with check ((select public.is_gerant()));
create policy "enceintes: modification par le gerant" on public.cold_units
  for update to authenticated using ((select public.is_gerant())) with check ((select public.is_gerant()));
create policy "enceintes: suppression par le gerant" on public.cold_units
  for delete to authenticated using ((select public.is_gerant()));

create policy "releves: lecture" on public.temp_readings
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "releves: suppression par le gerant" on public.temp_readings
  for delete to authenticated using ((select public.is_gerant()));

create policy "tracabilite: lecture" on public.trace_items
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "tracabilite: ajout" on public.trace_items
  for insert to anon, authenticated
  with check (created_by = (select public.my_profile_id()) and closed_at is null and closed_by is null and closed_reason is null);
create policy "tracabilite: suppression par le gerant" on public.trace_items
  for delete to authenticated using ((select public.is_gerant()));

create policy "huile: lecture" on public.oil_logs
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "huile: ajout" on public.oil_logs
  for insert to anon, authenticated with check (done_by = (select public.my_profile_id()));
create policy "huile: suppression par le gerant" on public.oil_logs
  for delete to authenticated using ((select public.is_gerant()));

revoke all on function
  public.service_day(), public.checklists_today(), public.tick_item(uuid, boolean),
  public.record_temp(uuid, numeric), public.note_corrective(uuid, text),
  public.close_trace(uuid, text), public.today_tasks()
  from public;
grant execute on function
  public.service_day(), public.checklists_today(), public.tick_item(uuid, boolean),
  public.record_temp(uuid, numeric), public.note_corrective(uuid, text),
  public.close_trace(uuid, text), public.today_tasks()
  to anon, authenticated;
revoke all on function public.save_checklist(uuid, text, text, text, jsonb) from public, anon;
grant execute on function public.save_checklist(uuid, text, text, text, jsonb) to authenticated;
revoke all on function public._period(text, date), public._slot() from public, anon, authenticated;

-- ---------- Modèles de départ, à ajuster dans l'appli -----------------------------
do $$
declare
  l record;
  c_id uuid;
  n int := 0;
  k int;
  lbl text;
begin
  for l in select * from (values
    ('Ouverture bar', 'service', 'daily', array[
      'Machine à glaçons en route, bac plein',
      'Mise en place : agrumes, menthe, sirops maison',
      'Fûts contrôlés, tireuse purgée',
      'Fond de caisse compté et noté',
      'Terrasse installée, cendriers propres',
      'Lumières et musique en place']),
    ('Ouverture cuisine', 'service', 'daily', array[
      'Contrôle des dates et des étiquettes',
      'Plans de travail désinfectés',
      'Mise en place selon la fiche du jour',
      'Niveau et état de l''huile de friture',
      'Lave-vaisselle : produits et température de rinçage',
      'Livraisons contrôlées et rangées']),
    ('Fermeture', 'service', 'daily', array[
      'Caisse clôturée, enveloppe au coffre',
      'Frigos fermés, relevés du soir faits',
      'Bar nettoyé, becs verseurs rincés',
      'Cuisine : plans, sols, friteuse couverte',
      'Poubelles sorties, verre trié',
      'Gaz coupé, hotte éteinte',
      'Terrasse rentrée',
      'Alarme mise, portes verrouillées']),
    ('Tâches de la semaine', 'service', 'weekly', array[
      'Inventaire du bar et de la cave',
      'Machine à café détartrée',
      'Trousse de secours vérifiée']),
    ('Nettoyage du jour', 'nettoyage', 'daily', array[
      'Plans de travail et planches',
      'Trancheuse démontée et désinfectée',
      'Sols de la cuisine et du bar',
      'Poignées de frigos et de portes',
      'Sanitaires']),
    ('Nettoyage de la semaine', 'nettoyage', 'weekly', array[
      'Filtres de hotte',
      'Siphons de sol',
      'Intérieur des frigos',
      'Étagères de la réserve']),
    ('Nettoyage du mois', 'nettoyage', 'monthly', array[
      'Machine à glaçons',
      'Chambre froide : sol, murs, clayettes',
      'Derrière et sous les équipements'])
  ) as t(name, kind, frequency, items) loop
    n := n + 1;
    insert into public.checklists (name, kind, frequency, position) values (l.name, l.kind, l.frequency, n) returning id into c_id;
    k := 0;
    foreach lbl in array l.items loop
      k := k + 1;
      insert into public.checklist_items (checklist_id, label, position) values (c_id, lbl, k);
    end loop;
  end loop;
end $$;

insert into public.cold_units (name, min_temp, max_temp, readings_per_day, position) values
  ('Chambre froide',   0,   4, 2, 1),
  ('Frigo bar',        0,   4, 2, 2),
  ('Timbre cuisine',   0,   4, 2, 3),
  ('Vitrine desserts', 0,   4, 2, 4),
  ('Congélateur',    -30, -18, 1, 5);
