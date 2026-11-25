-- =====================================================================
-- Nuba Gestion · migration 0027 · planning depuis le tableau de bord, et chacun prévenu des changements
--
-- À exécuter une seule fois dans Supabase, après la 0026 :
--   SQL Editor > New query > coller tout ce fichier > Run.
-- Supabase doit répondre « Success. No rows returned ».
-- Tout passe ou rien ne passe : en cas d'erreur, la base reste comme avant.
--
-- 1. L'onglet « Planning équipe » du tableau de bord financier (semaines types et calendrier) arrive par le
--    script Google : il en tire les services des six semaines à venir. Ces services portent la mention
--    « fichier » ; le fichier fait foi pour eux. Les services ajoutés dans l'appli ne sont jamais touchés.
--    Un service du fichier déplacé ou supprimé dans l'appli n'est pas recréé : l'appli garde la main sur lui
--    tant que sa ligne ne change pas dans le fichier.
--    Une personne en congé accepté ce jour-là n'est pas planifiée. Les noms inconnus de l'appli et les services
--    qui chevauchent un service de l'appli sont signalés au gérant dans Administration.
-- 2. Toute modification du planning (ajout, changement d'horaire ou de poste, retrait, échange accepté),
--    dans l'appli ou par le fichier, est notée pour la personne concernée : elle la voit sur son écran
--    Aujourd'hui et reçoit un e-mail récapitulatif quelques minutes après le dernier changement
--    (une tâche planifiée, toutes les 10 minutes).
-- =====================================================================
begin;

do $$ begin
  if to_regclass('public.shifts') is null or to_regprocedure('public._schedule_booking_reminders()') is null
     or to_regprocedure('public.send_task_reminders(timestamp with time zone)') is null then
    raise exception 'Il manque une mise à jour plus ancienne. Exécute d''abord : 0022 et 0025, puis relance celle-ci (0027).';
  end if;
end $$;

alter table public.email_settings add column notify_planning boolean not null default true;

-- ---------- Services venus du fichier ------------------------------------------------------
alter table public.shifts
  add column source    text not null default 'app' check (source in ('app', 'sheet')),
  add column sheet_key text unique;

-- État de la dernière réception (gérant seulement).
create table public.planning_sync (
  id        boolean primary key default true check (id),
  synced_at timestamptz,
  date_from date,
  date_to   date,
  counts    jsonb not null default '{}',
  problems  jsonb not null default '[]'
);
insert into public.planning_sync default values;
alter table public.planning_sync enable row level security;
revoke all on public.planning_sync from anon, authenticated;
grant select on public.planning_sync to authenticated;
create policy "planning du fichier: le gerant" on public.planning_sync
  for select to authenticated using ((select public.is_gerant()));

-- Services du fichier déplacés ou supprimés dans l'appli : la synchronisation ne les recrée pas.
-- Personne n'y lit ni n'y écrit directement (seulement les fonctions ci-dessous).
create table public.planning_skips (
  sheet_key  text primary key,
  created_at timestamptz not null default now()
);
alter table public.planning_skips enable row level security;
revoke all on public.planning_skips from anon, authenticated;

-- Un nom réduit à ses lettres : sans accents, sans majuscules, sans ce qui est entre parenthèses.
-- « Margo SALVA (apprentie) » → « margo salva » ; « Luce CAMUS--MIZZI » → « luce camus mizzi ».
create function public._name_key(t text) returns text
language sql immutable set search_path = '' as $$
  select btrim(regexp_replace(regexp_replace(
    translate(lower(regexp_replace(coalesce(t, ''), '\([^)]*\)', ' ', 'g')),
              'àâäáãåçéèêëíìîïñóòôöõúùûüýÿœæ', 'aaaaaaceeeeiiiinooooouuuuyyoa'),
    '[^a-z]+', ' ', 'g'), '\s+', ' ', 'g'))
$$;

-- La personne de l'équipe qui porte ce nom : nom complet, sinon prénom seul s'il est unique.
create function public._profile_by_name(t text) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  k  text := public._name_key(t);
  v_id uuid;
  n  int;
begin
  if k = '' then return null; end if;
  select min(p.id::text)::uuid, count(*) into v_id, n from public.profiles p
    where p.active and public._name_key(p.first_name || ' ' || coalesce(p.last_name, '')) = k;
  if n = 1 then return v_id; end if;
  select min(p.id::text)::uuid, count(*) into v_id, n from public.profiles p
    where p.active and public._name_key(p.first_name) = split_part(k, ' ', 1);
  if n = 1 then return v_id; end if;
  return null;
end $$;

-- ---------- Réception du planning ------------------------------------------------------------
-- Appelée par le script Google avec la clé des mercuriales. p_payload :
--   { brand: 'planning', file, from, to, shifts: [{name, day, start, end, area, note}] }
-- from/to : la période couverte (jours de service). Pour elle, les services « fichier » à venir sont
-- remplacés par ceux envoyés ; ceux qui n'ont pas changé restent tels quels (pas de notification inutile).
create function public.sync_planning(p_key text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s        public.merc_sync;
  v_from   date := public._mdate(p_payload -> 'from');
  v_to     date := public._mdate(p_payload -> 'to');
  r        jsonb;
  v_prof   uuid;
  v_day    date;
  v_start  time;
  v_end    time;
  v_s      timestamptz;
  v_e      timestamptz;
  v_area   text;
  v_note   text;
  v_key    text;
  keys     text[] := '{}';
  v_problems text[] := '{}';
  unknown  text[] := '{}';
  n_add    int := 0;
  n_upd    int := 0;
  n_del    int := 0;
  n_same   int := 0;
  n_leave  int := 0;
  old      public.shifts;
begin
  select * into s from public.merc_sync;
  if s.key_hash is null or coalesce(p_key, '') = '' or sha256(convert_to(p_key, 'UTF8')) <> s.key_hash then
    if (select count(*) from public.merc_sync_log where not ok and at > now() - interval '1 hour') < 50 then
      insert into public.merc_sync_log (brand, ok, message) values ('planning', false, 'Clé refusée');
    end if;
    return jsonb_build_object('ok', false, 'error', 'key');
  end if;
  if p_payload ->> 'brand' is distinct from 'planning' or v_from is null or v_to is null or v_to < v_from or v_to - v_from > 120
     or coalesce(jsonb_typeof(p_payload -> 'shifts'), '') <> 'array' or jsonb_array_length(p_payload -> 'shifts') > 3000 then
    return jsonb_build_object('ok', false, 'error', 'payload');
  end if;

  begin
    -- Les retraits faits ici par la synchronisation ne sont pas des suppressions de l'équipe.
    perform set_config('nuba.sync', 'on', true);
    delete from public.planning_skips where created_at < now() - interval '120 days';
    for r in select value from jsonb_array_elements(p_payload -> 'shifts') loop
      v_day := public._mdate(r -> 'day');
      v_start := nullif(r ->> 'start', '')::time;
      v_end := nullif(r ->> 'end', '')::time;
      if v_day is null or v_start is null or v_end is null or v_day < v_from or v_day > v_to then continue; end if;
      v_prof := public._profile_by_name(r ->> 'name');
      if v_prof is null then
        if not (public._mtext(r -> 'name', 80) = any (unknown)) then unknown := unknown || public._mtext(r -> 'name', 80); end if;
        continue;
      end if;
      -- En congé accepté ce jour-là : pas de service.
      if exists (select 1 from public.leave_requests l where l.profile_id = v_prof and l.status = 'approved'
                 and v_day between l.start_date and l.end_date and coalesce(l.part, 'full') = 'full') then
        n_leave := n_leave + 1;
        continue;
      end if;
      v_s := (v_day + v_start) at time zone 'Europe/Paris';
      v_e := ((v_day + case when v_end <= v_start then 1 else 0 end) + v_end) at time zone 'Europe/Paris';
      -- Un service qui commence avant 5 h appartient à la nuit précédente : on le décale au lendemain.
      if v_start < time '05:00' then v_s := v_s + interval '1 day'; v_e := v_e + interval '1 day'; end if;
      if v_e <= v_s or v_e - v_s > interval '16 hours' then
        v_problems := v_problems || (public._mtext(r -> 'name', 60) || ', ' || public._fr_day(v_day) || ' : horaire illisible');
        continue;
      end if;
      if v_s <= now() then continue; end if;   -- le passé ne bouge pas
      v_area := left(btrim(coalesce(r ->> 'area', '')), 30);
      v_note := left(btrim(coalesce(r ->> 'note', '')), 120);
      v_key := v_prof || '|' || to_char(v_s at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI') || '|' || to_char(v_e at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI');
      if v_key = any (keys) then continue; end if;
      keys := keys || v_key;
      -- Déplacé ou supprimé dans l'appli : l'appli garde la main.
      if exists (select 1 from public.planning_skips k where k.sheet_key = v_key) then
        n_same := n_same + 1;
        continue;
      end if;
      select * into old from public.shifts where sheet_key = v_key;
      if found then
        if old.area is distinct from v_area or old.note is distinct from v_note then
          update public.shifts set area = v_area, note = v_note where id = old.id;
          n_upd := n_upd + 1;
        else
          n_same := n_same + 1;
        end if;
        continue;
      end if;
      begin
        insert into public.shifts (profile_id, starts_at, ends_at, area, note, source, sheet_key)
          values (v_prof, v_s, v_e, v_area, v_note, 'sheet', v_key);
        n_add := n_add + 1;
      exception when others then
        v_problems := v_problems || (public._mtext(r -> 'name', 60) || ', ' || public._fr_day(v_day) || ' '
                                 || public._fr_time(v_start) || ' – ' || public._fr_time(v_end) || ' : ' || sqlerrm);
      end;
    end loop;

    -- Les services « fichier » à venir de la période qui n'y sont plus : retirés.
    delete from public.shifts
      where source = 'sheet' and starts_at > now() and not (sheet_key = any (keys))
        and ((starts_at at time zone 'Europe/Paris') - interval '5 hours')::date between v_from and v_to;
    get diagnostics n_del = row_count;

    if array_length(unknown, 1) > 0 then
      v_problems := v_problems || ('Pas dans l''équipe de l''appli : ' || array_to_string(unknown, ', '));
    end if;
    update public.planning_sync
      set synced_at = now(), date_from = v_from, date_to = v_to,
          counts = jsonb_build_object('added', n_add, 'updated', n_upd, 'removed', n_del, 'unchanged', n_same, 'on_leave', n_leave,
                                      'total', (select count(*) from public.shifts where source = 'sheet' and starts_at > now())),
          problems = to_jsonb(v_problems[1:30])
      where id;
    perform set_config('nuba.sync', 'off', true);
    delete from public.merc_sync_log where at < now() - interval '30 days';
    insert into public.merc_sync_log (brand, ok, message)
      values ('planning', true, n_add || ' ajouté(s), ' || n_upd || ' modifié(s), ' || n_del || ' retiré(s)'
                                || case when cardinality(v_problems) > 0 then ' · ' || cardinality(v_problems) || ' point(s) à vérifier' else '' end);
    return jsonb_build_object('ok', true, 'counts', jsonb_build_object('added', n_add, 'updated', n_upd, 'removed', n_del, 'problems', cardinality(v_problems)));
  exception when others then
    perform set_config('nuba.sync', 'off', true);
    insert into public.merc_sync_log (brand, ok, message) values ('planning', false, left('Envoi refusé par la base : ' || sqlerrm, 300));
    return jsonb_build_object('ok', false, 'error', 'db', 'message', sqlerrm);
  end;
end $$;

-- Un service du fichier déplacé dans l'appli (horaire ou personne) devient un service de l'appli : la synchronisation
-- ne le touche plus et ne recrée pas la ligne du fichier. Supprimé dans l'appli, il n'est pas recréé non plus.
create function public._shift_detach() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.source = 'sheet' and old.sheet_key is not null and current_setting('nuba.sync', true) is distinct from 'on' then
    if tg_op = 'DELETE' then
      insert into public.planning_skips (sheet_key) values (old.sheet_key) on conflict do nothing;
      return old;
    end if;
    if (new.starts_at, new.ends_at, new.profile_id) is distinct from (old.starts_at, old.ends_at, old.profile_id) then
      insert into public.planning_skips (sheet_key) values (old.sheet_key) on conflict do nothing;
      new.source := 'app';
      new.sheet_key := null;
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger shifts_detach before update on public.shifts
  for each row execute function public._shift_detach();
create trigger shifts_detach_delete after delete on public.shifts
  for each row execute function public._shift_detach();

-- ---------- Changements de planning à annoncer -----------------------------------------------
create table public.shift_changes (
  id            bigint generated always as identity primary key,
  profile_id    uuid not null references public.profiles (id) on delete cascade,
  kind          text not null check (kind in ('added', 'changed', 'removed')),
  starts_at     timestamptz not null,
  ends_at       timestamptz not null,
  area          text not null default '',
  old_starts_at timestamptz,
  old_ends_at   timestamptz,
  old_area      text,
  created_at    timestamptz not null default now(),
  emailed_at    timestamptz,
  seen_at       timestamptz
);
create index shift_changes_open on public.shift_changes (profile_id) where seen_at is null or emailed_at is null;
alter table public.shift_changes enable row level security;
revoke all on public.shift_changes from anon, authenticated;
-- Chacun voit les siens (sur l'iPad aussi, avec son code PIN).
grant select on public.shift_changes to anon, authenticated;
create policy "changements de planning: les siens" on public.shift_changes
  for select to anon, authenticated using (profile_id = (select public.my_profile_id()));

-- Noté pour tout service qui n'est pas encore terminé ; un service passé corrigé ne prévient personne.
create function public._shift_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.ends_at > now() then
      insert into public.shift_changes (profile_id, kind, starts_at, ends_at, area) values (new.profile_id, 'added', new.starts_at, new.ends_at, new.area);
    end if;
  elsif tg_op = 'DELETE' then
    if old.ends_at > now() then
      insert into public.shift_changes (profile_id, kind, starts_at, ends_at, area) values (old.profile_id, 'removed', old.starts_at, old.ends_at, old.area);
    end if;
  elsif greatest(new.ends_at, old.ends_at) > now() then
    if new.profile_id <> old.profile_id then
      insert into public.shift_changes (profile_id, kind, starts_at, ends_at, area) values (old.profile_id, 'removed', old.starts_at, old.ends_at, old.area);
      insert into public.shift_changes (profile_id, kind, starts_at, ends_at, area) values (new.profile_id, 'added', new.starts_at, new.ends_at, new.area);
    elsif (new.starts_at, new.ends_at, new.area) is distinct from (old.starts_at, old.ends_at, old.area) then
      insert into public.shift_changes (profile_id, kind, starts_at, ends_at, area, old_starts_at, old_ends_at, old_area)
        values (new.profile_id, 'changed', new.starts_at, new.ends_at, new.area, old.starts_at, old.ends_at, old.area);
    end if;
  end if;
  return null;
exception when others then
  return null;
end $$;
create trigger shifts_changed after insert or update or delete on public.shifts
  for each row execute function public._shift_changed();

-- « C'est noté » : la personne a vu ses changements.
create function public.ack_shift_changes() returns void
language plpgsql security definer set search_path = '' as $$
declare me uuid := public._member();
begin
  update public.shift_changes set seen_at = now() where profile_id = me and seen_at is null;
end $$;

-- Un créneau en toutes lettres : « mardi 1er décembre, 18 h – 23 h, Bar ».
create function public._shift_label(p_s timestamptz, p_e timestamptz, p_area text) returns text
language sql stable set search_path = '' as $$
  select public._fr_day((p_s at time zone 'Europe/Paris')::date) || ', '
    || public._fr_time((p_s at time zone 'Europe/Paris')::time) || ' – ' || public._fr_time((p_e at time zone 'Europe/Paris')::time)
    || case when btrim(coalesce(p_area, '')) <> '' then ', ' || btrim(p_area) else '' end
$$;

-- E-mail récapitulatif à chaque personne dont le planning a changé, 5 minutes après son dernier changement
-- (le gérant qui construit sa semaine n'envoie qu'un e-mail). Renvoie le nombre d'e-mails partis.
create function public.send_shift_notices(p_now timestamptz default now()) returns int
language plpgsql security definer set search_path = '' as $$
declare
  m      public.email_settings;
  p      record;
  c      record;
  v_body text;
  v_n    int;
  v_sent int := 0;
begin
  select * into m from public.email_settings;
  for p in
    select pr.id, pr.first_name, pr.email, count(*) as n, max(sc.created_at) as last_at
    from public.shift_changes sc join public.profiles pr on pr.id = sc.profile_id
    where sc.emailed_at is null
    group by pr.id, pr.first_name, pr.email
    having max(sc.created_at) < p_now - interval '5 minutes'
  loop
    if m.enabled and m.notify_planning and coalesce(p.email, '') <> '' then
      v_body := '';
      v_n := 0;
      -- Un même service ajouté puis retiré (ou l'inverse) avant l'e-mail ne compte pas ; sinon, seul le dernier état est dit.
      for c in
        select * from public.shift_changes c0 where c0.profile_id = p.id and c0.emailed_at is null and c0.ends_at > p_now
          and not (c0.kind in ('added', 'removed') and (
            exists (select 1 from public.shift_changes c1
                    where c1.profile_id = c0.profile_id and c1.emailed_at is null and c1.kind in ('added', 'removed')
                      and c1.starts_at = c0.starts_at and c1.ends_at = c0.ends_at and c1.id > c0.id)
            or (select count(*) filter (where c1.kind = 'added') - count(*) filter (where c1.kind = 'removed')
                from public.shift_changes c1
                where c1.profile_id = c0.profile_id and c1.emailed_at is null and c1.kind in ('added', 'removed')
                  and c1.starts_at = c0.starts_at and c1.ends_at = c0.ends_at) = 0))
        order by c0.starts_at, c0.id
      loop
        v_n := v_n + 1;
        if v_n <= 15 then
          v_body := v_body || E'\n' || case c.kind
            when 'added' then '+ Ajouté : ' || public._shift_label(c.starts_at, c.ends_at, c.area)
            when 'removed' then '– Retiré : ' || public._shift_label(c.starts_at, c.ends_at, c.area)
            else '~ Modifié : ' || public._shift_label(c.starts_at, c.ends_at, c.area)
                 || ' (avant : ' || public._fr_time((c.old_starts_at at time zone 'Europe/Paris')::time) || ' – '
                 || public._fr_time((c.old_ends_at at time zone 'Europe/Paris')::time)
                 || case when coalesce(c.old_area, '') <> coalesce(c.area, '') and coalesce(c.old_area, '') <> '' then ', ' || c.old_area else '' end || ')'
            end;
        end if;
      end loop;
      if v_n > 15 then v_body := v_body || E'\n… et ' || (v_n - 15) || ' autre(s) changement(s), à voir dans l''appli.'; end if;
      if v_n > 0 and public._email_queue('planning', p.email,
           'Ton planning a changé (' || v_n || ' changement' || case when v_n > 1 then 's' else '' end || ')',
           'Bonjour ' || p.first_name || E',\n\nTon planning à la Nuba a changé :\n' || v_body
           || E'\n\n[[Voir mon planning|' || m.app_url || '#/planning]]'
           || E'\n\n' || m.signature) then
        v_sent := v_sent + 1;
      end if;
    end if;
    update public.shift_changes set emailed_at = p_now where profile_id = p.id and emailed_at is null and created_at <= p.last_at;
  end loop;
  -- Ménage : les changements vus et envoyés de plus de 60 jours.
  delete from public.shift_changes where created_at < p_now - interval '60 days';
  return v_sent;
end $$;

-- ---------- Tâches planifiées : réservations, tâches, planning ------------------------------
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
  execute 'select cron.schedule($1, $2, $3)' using 'nuba-planning', '*/10 * * * *', 'select public.send_shift_notices()';
  return true;
exception when others then
  return false;
end $$;

create or replace function public.reminders_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_job  boolean := false;
  v_task boolean := false;
  v_plan boolean := false;
begin
  if not public.is_gerant() then
    raise exception 'Réservé au gérant.' using errcode = '42501';
  end if;
  if to_regclass('cron.job') is not null then
    execute 'select exists (select 1 from cron.job where jobname = $1)' into v_job using 'nuba-rappels-reservations';
    execute 'select exists (select 1 from cron.job where jobname = $1)' into v_task using 'nuba-rappels-taches';
    execute 'select exists (select 1 from cron.job where jobname = $1)' into v_plan using 'nuba-planning';
  end if;
  return jsonb_build_object('scheduled', v_job and v_task and v_plan, 'bookings', v_job, 'tasks', v_task, 'planning', v_plan,
    'sent_today', (select count(*) from public.email_outbox where kind = 'client_rappel' and created_at > now() - interval '24 hours'),
    'tasks_sent_today', (select count(*) from public.email_outbox where kind = 'rappel_taches' and created_at > now() - interval '24 hours'),
    'planning_sent_today', (select count(*) from public.email_outbox where kind = 'planning' and created_at > now() - interval '24 hours'));
end $$;

do $$ begin
  perform public._schedule_booking_reminders();
end $$;

-- ---------- Droits ------------------------------------------------------------------------
revoke all on function public._name_key(text), public._profile_by_name(text), public.sync_planning(text, jsonb),
  public._shift_detach(), public._shift_changed(), public.ack_shift_changes(), public._shift_label(timestamptz, timestamptz, text),
  public.send_shift_notices(timestamptz)
  from public, anon, authenticated;
grant execute on function public.sync_planning(text, jsonb) to anon, authenticated;
grant execute on function public.ack_shift_changes() to anon, authenticated;

commit;
