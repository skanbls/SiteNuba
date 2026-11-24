-- =====================================================================
-- Nuba Gestion · migration 0025 · checklists selon le planning, tâches de la semaine et du mois, rappel la veille
--
-- À exécuter une seule fois dans Supabase, après la 0024 :
--   SQL Editor > New query > coller tout ce fichier > Run.
-- Supabase doit répondre « Success. No rows returned ».
-- Tout passe ou rien ne passe : en cas d'erreur, la base reste comme avant.
--
-- 1. Chaque checklist a un poste : Salle, Bar, Cuisine… ou toute l'équipe au planning.
--    Le jour J, chacun voit sur son écran les listes de son poste du jour (d'après le planning),
--    sur son téléphone comme sur l'iPad avec son code PIN.
-- 2. Une liste de la semaine ou du mois peut avoir son jour : « le mardi », « le 1er mardi du mois »,
--    « le dernier lundi du mois ». Ce jour-là, elle s'ajoute aux checklists du poste ; pas faite,
--    elle reste affichée « en retard » jusqu'à la fin de la semaine ou du mois. Sans jour, elle se fait
--    quand on veut dans la période, comme avant.
-- 3. La veille, entre 16 h et 21 h, chaque personne au planning le lendemain reçoit un e-mail avec
--    les tâches de la semaine ou du mois qui l'attendent ; l'appli les montre aussi (« Demain »).
--    Si personne n'est prévu au poste, le gérant est prévenu. Même tâche planifiée que les rappels
--    de réservation (pg_cron).
-- =====================================================================
begin;

do $$ begin
  if to_regclass('public.checklists') is null or to_regclass('public.shifts') is null
     or to_regprocedure('public._schedule_booking_reminders()') is null then
    raise exception 'Il manque une mise à jour plus ancienne. Exécute d''abord : 0022 (e-mails de réservation), puis relance celle-ci (0025).';
  end if;
end $$;

-- ---------- Poste et jour prévu --------------------------------------------------------
alter table public.checklists
  add column area        text not null default '' check (length(area) <= 40),
  add column due_weekday smallint check (due_weekday between 1 and 7),
  add column due_week    smallint check (due_week between 1 and 5),
  add constraint checklists_due check (
    (frequency = 'daily' and due_weekday is null and due_week is null)
    or (frequency = 'weekly' and due_week is null)
    or (frequency = 'monthly' and (due_weekday is null) = (due_week is null)));

alter table public.email_settings add column remind_tasks boolean not null default true;

-- Un seul envoi de rappels par jour.
create table public.task_reminder_days (
  day     date primary key,
  sent_at timestamptz not null default now(),
  emails  int not null default 0
);
alter table public.task_reminder_days enable row level security;
revoke all on public.task_reminder_days from anon, authenticated;

-- ---------- Dates ---------------------------------------------------------------------
-- Le jour prévu d'une liste dans la période qui commence à p_start (lundi de la semaine, 1er du mois).
-- due_week : 1 à 4 pour le 1er… 4e jour de ce nom dans le mois, 5 pour le dernier. Sans jour prévu : null.
create function public._due_in_period(p_frequency text, p_weekday int, p_week int, p_start date) returns date
language plpgsql immutable set search_path = '' as $$
declare
  first_day date;
  d date;
begin
  if p_weekday is null or p_frequency = 'daily' then return null; end if;
  if p_frequency = 'weekly' then return p_start + (p_weekday - 1); end if;
  if p_week is null then return null; end if;
  first_day := p_start + ((p_weekday - extract(isodow from p_start)::int + 7) % 7);
  if p_week between 1 and 4 then return first_day + 7 * (p_week - 1); end if;
  d := first_day + 28;
  while extract(month from d) <> extract(month from p_start) loop d := d - 7; end loop;
  return d;
end $$;

-- Le prochain jour prévu à partir de p_from (p_from compris) : dans cette période ou la suivante.
create function public._next_due(p_frequency text, p_weekday int, p_week int, p_from date) returns date
language plpgsql immutable set search_path = '' as $$
declare
  per date := public._period(p_frequency, p_from);
  d   date := public._due_in_period(p_frequency, p_weekday, p_week, per);
begin
  if d is null or d >= p_from then return d; end if;
  per := case p_frequency when 'weekly' then per + 7 else (per + interval '1 month')::date end;
  return public._due_in_period(p_frequency, p_weekday, p_week, per);
end $$;

-- Les postes d'une personne un jour de service (en minuscules), ou null si elle n'est pas au planning.
-- Un service appartient au jour de service où il commence (journée de 5 h à 5 h, heure de Paris).
create function public._areas_on(p_profile uuid, p_day date) returns text[]
language sql stable security definer set search_path = '' as $$
  select case when count(*) = 0 then null else array_agg(distinct lower(btrim(s.area))) end
  from public.shifts s
  where s.profile_id = p_profile
    and ((s.starts_at at time zone 'Europe/Paris') - interval '5 hours')::date = p_day
$$;

-- Une liste concerne-t-elle quelqu'un qui tient ces postes ? Liste sans poste : toute l'équipe au planning.
create function public._list_for(p_area text, p_areas text[]) returns boolean
language sql immutable set search_path = '' as $$
  select p_areas is not null and (btrim(coalesce(p_area, '')) = '' or lower(btrim(p_area)) = any (p_areas))
$$;

-- ---------- Checklists du jour ---------------------------------------------------------
-- Comme avant, avec pour chaque liste : son poste, son jour prévu dans la période (due), le prochain
-- jour prévu (next_due), si elle concerne la personne aujourd'hui (mine) et demain (mine_tomorrow).
create or replace function public.checklists_today() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  d   date := public.service_day();
  me  uuid := public.my_profile_id();
  a0  text[];
  a1  text[];
begin
  if me is null then return null; end if;
  a0 := public._areas_on(me, d);
  a1 := public._areas_on(me, d + 1);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', c.id, 'name', c.name, 'kind', c.kind, 'frequency', c.frequency,
      'area', c.area, 'due_weekday', c.due_weekday, 'due_week', c.due_week,
      'due', public._due_in_period(c.frequency, c.due_weekday, c.due_week, public._period(c.frequency, d)),
      'next_due', public._next_due(c.frequency, c.due_weekday, c.due_week, d),
      'mine', public._list_for(c.area, a0),
      'mine_tomorrow', public._list_for(c.area, a1),
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

-- ---------- Créer ou modifier une liste, avec son poste et son jour ---------------------
create function public.save_checklist(
  p_id uuid, p_name text, p_kind text, p_frequency text, p_items jsonb, p_area text, p_due_weekday int, p_due_week int
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  wd   int := case when p_frequency in ('weekly', 'monthly') then p_due_weekday end;
  wk   int := case when p_frequency = 'monthly' and p_due_weekday is not null then p_due_week end;
begin
  if not public.can('checklists') then
    raise exception 'Réservé au gérant et aux responsables qui tiennent les checklists.' using errcode = '42501';
  end if;
  if p_frequency = 'monthly' and wd is not null and wk is null then
    raise exception 'Pour une liste du mois, choisis aussi la semaine (1er, 2e… ou dernier).' using errcode = 'P0001';
  end if;
  if length(btrim(coalesce(p_area, ''))) > 40 then
    raise exception 'Nom de poste trop long.' using errcode = 'P0001';
  end if;
  v_id := public.save_checklist(p_id, p_name, p_kind, p_frequency, p_items);
  update public.checklists set area = btrim(coalesce(p_area, '')), due_weekday = wd, due_week = wk where id = v_id;
  return v_id;
end $$;

-- ---------- Rappel la veille ------------------------------------------------------------
-- Envoie, entre 16 h et 21 h (heure de Paris), une seule fois par jour, l'e-mail des tâches de la semaine
-- et du mois prévues le lendemain, à chaque personne au planning le lendemain pour ce poste.
-- Une liste déjà terminée pour sa période n'est pas rappelée. Si personne n'est prévu, le gérant est prévenu.
-- Renvoie le nombre d'e-mails partis.
create function public.send_task_reminders(p_now timestamptz default now()) returns int
language plpgsql security definer set search_path = '' as $$
declare
  m        public.email_settings;
  here     timestamp := p_now at time zone 'Europe/Paris';
  tomorrow date := ((p_now at time zone 'Europe/Paris') - interval '5 hours')::date + 1;
  p        record;
  c        record;
  v_areas  text[];
  v_body   text;
  v_lists  int;
  v_sent   int := 0;
  v_orphan text := '';
  v_shift  text;
begin
  select * into m from public.email_settings;
  if not m.enabled or not m.remind_tasks or here::time < time '16:00' or here::time >= time '21:00' then return 0; end if;
  if exists (select 1 from public.task_reminder_days where day = tomorrow) then return 0; end if;
  insert into public.task_reminder_days (day) values (tomorrow);

  for p in
    select distinct pr.id, pr.first_name, pr.email
    from public.shifts s join public.profiles pr on pr.id = s.profile_id
    where pr.active and coalesce(pr.email, '') <> ''
      and ((s.starts_at at time zone 'Europe/Paris') - interval '5 hours')::date = tomorrow
  loop
    v_areas := public._areas_on(p.id, tomorrow);
    v_body := '';
    v_lists := 0;
    for c in
      select cl.* from public.checklists cl
      where cl.active and cl.frequency in ('weekly', 'monthly')
        and public._next_due(cl.frequency, cl.due_weekday, cl.due_week, tomorrow) = tomorrow
        and public._list_for(cl.area, v_areas)
        and exists (select 1 from public.checklist_items i
                    left join public.checklist_ticks t on t.item_id = i.id and t.period = public._period(cl.frequency, tomorrow)
                    where i.checklist_id = cl.id and i.active and t.item_id is null)
      order by cl.position, cl.name
    loop
      v_lists := v_lists + 1;
      v_body := v_body || E'\n\n' || c.name || case when c.area <> '' then ' (' || c.area || ')' else '' end || ' :'
        || coalesce((select string_agg(E'\n- ' || i.label, '' order by i.position)
                     from public.checklist_items i where i.checklist_id = c.id and i.active), '');
    end loop;
    if v_lists = 0 then continue; end if;
    select string_agg(public._fr_time((s.starts_at at time zone 'Europe/Paris')::time) || ' – ' || public._fr_time((s.ends_at at time zone 'Europe/Paris')::time)
                      || case when s.area <> '' then ', ' || s.area else '' end, ' et ' order by s.starts_at)
      into v_shift
      from public.shifts s
      where s.profile_id = p.id and ((s.starts_at at time zone 'Europe/Paris') - interval '5 hours')::date = tomorrow;
    if public._email_queue('rappel_taches', p.email,
         'Demain à la Nuba : ' || case when v_lists > 1 then v_lists || ' listes de tâches' else 'une liste de tâches' end,
         'Bonjour ' || p.first_name || E',\n\nDemain, ' || public._fr_day(tomorrow) || ', tu es au planning (' || coalesce(v_shift, '') || ').'
         || E'\nEn plus des checklists habituelles, voici ce qui est prévu :' || v_body
         || E'\n\nTu retrouves ces listes dans l''appli, sur l''écran Aujourd''hui.'
         || E'\n\n[[Ouvrir l''appli|' || m.app_url || '#/checklists]]'
         || E'\n\n' || m.signature) then
      v_sent := v_sent + 1;
    end if;
  end loop;

  -- Listes prévues demain dont le poste n'a personne au planning : le gérant est prévenu.
  for c in
    select cl.* from public.checklists cl
    where cl.active and cl.frequency in ('weekly', 'monthly')
      and public._next_due(cl.frequency, cl.due_weekday, cl.due_week, tomorrow) = tomorrow
      and not exists (select 1 from public.shifts s
                      where ((s.starts_at at time zone 'Europe/Paris') - interval '5 hours')::date = tomorrow
                        and public._list_for(cl.area, array[lower(btrim(s.area))]))
    order by cl.position, cl.name
  loop
    v_orphan := v_orphan || E'\n- ' || c.name || case when c.area <> '' then ' (poste ' || c.area || ')' else '' end;
  end loop;
  if v_orphan <> '' and m.notify_email <> '' then
    if public._email_queue('rappel_taches', m.notify_email, 'Demain, des tâches sans personne au planning',
         'Ces listes sont prévues demain, ' || public._fr_day(tomorrow) || ', mais personne n''est au planning pour les faire :' || v_orphan
         || E'\n\nAjoute quelqu''un au planning, ou change le jour de la liste.'
         || E'\n\n[[Ouvrir le planning|' || m.app_url || '#/planning]]') then
      v_sent := v_sent + 1;
    end if;
  end if;

  update public.task_reminder_days set emails = v_sent where day = tomorrow;
  return v_sent;
end $$;

-- ---------- Tâche planifiée : réservations et tâches --------------------------------------
create or replace function public._schedule_booking_reminders() returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if to_regclass('cron.job') is null then
    begin
      create extension if not exists pg_cron with schema pg_catalog;
    exception when others then
      begin
        create extension if not exists pg_cron;
      exception when others then
        null;
      end;
    end;
  end if;
  if to_regclass('cron.job') is null then return false; end if;
  execute 'select cron.schedule($1, $2, $3)' using 'nuba-rappels-reservations', '5 * * * *', 'select public.send_booking_reminders()';
  execute 'select cron.schedule($1, $2, $3)' using 'nuba-rappels-taches', '35 * * * *', 'select public.send_task_reminders()';
  return true;
exception when others then
  return false;
end $$;

create or replace function public.reminders_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_job  boolean := false;
  v_task boolean := false;
begin
  if not public.is_gerant() then
    raise exception 'Réservé au gérant.' using errcode = '42501';
  end if;
  if to_regclass('cron.job') is not null then
    execute 'select exists (select 1 from cron.job where jobname = $1)' into v_job using 'nuba-rappels-reservations';
    execute 'select exists (select 1 from cron.job where jobname = $1)' into v_task using 'nuba-rappels-taches';
  end if;
  return jsonb_build_object('scheduled', v_job and v_task, 'bookings', v_job, 'tasks', v_task,
    'sent_today', (select count(*) from public.email_outbox where kind = 'client_rappel' and created_at > now() - interval '24 hours'),
    'tasks_sent_today', (select count(*) from public.email_outbox where kind = 'rappel_taches' and created_at > now() - interval '24 hours'));
end $$;

do $$ begin
  perform public._schedule_booking_reminders();
end $$;

-- ---------- Droits ------------------------------------------------------------------------
revoke all on function public._due_in_period(text, int, int, date), public._next_due(text, int, int, date),
  public._areas_on(uuid, date), public._list_for(text, text[]), public.send_task_reminders(timestamptz),
  public.save_checklist(uuid, text, text, text, jsonb, text, int, int)
  from public, anon, authenticated;
grant execute on function public.save_checklist(uuid, text, text, text, jsonb, text, int, int) to authenticated;

commit;
