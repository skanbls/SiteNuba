-- Tests de la migration 0025 : checklists selon le planning, jour prévu, rappel la veille. Données inventées.
\set ON_ERROR_STOP on
\set boss '''{"sub":"00000000-0000-0000-0000-000000000001"}'''
\set theo '''{"sub":"00000000-0000-0000-0000-000000000002"}'''
\set ines '''{"sub":"00000000-0000-0000-0000-000000000005"}'''
reset role;
reset request.headers;

-- 0. Le jour prévu dans la période, et le prochain
do $$ begin
  assert public._due_in_period('weekly', 2, null, '2026-11-23') = '2026-11-24', 'le mardi de la semaine';
  assert public._due_in_period('weekly', null, null, '2026-11-23') is null, 'sans jour : quand on veut';
  assert public._due_in_period('daily', 2, null, '2026-11-23') is null, 'une liste du jour n''a pas de jour prévu';
  assert public._due_in_period('monthly', 2, 1, '2026-12-01') = '2026-12-01', '1er mardi de décembre';
  assert public._due_in_period('monthly', 2, 5, '2026-12-01') = '2026-12-29', 'dernier mardi de décembre';
  assert public._due_in_period('monthly', 1, 1, '2026-12-01') = '2026-12-07', '1er lundi de décembre';
  assert public._due_in_period('monthly', 1, 5, '2026-12-01') = '2026-12-28', 'dernier lundi de décembre';
  assert public._due_in_period('monthly', 7, 5, '2027-02-01') = '2027-02-28', 'dernier dimanche de février';
  assert public._due_in_period('monthly', 3, 2, '2027-02-01') = '2027-02-10', '2e mercredi de février';
  assert public._next_due('weekly', 2, null, '2026-11-24') = '2026-11-24', 'le jour même';
  assert public._next_due('weekly', 2, null, '2026-11-25') = '2026-12-01', 'la semaine suivante';
  assert public._next_due('monthly', 2, 1, '2026-12-02') = '2027-01-05', 'le mois suivant';
end $$;

-- Jour de service, lendemain, et les services de Théo (aujourd'hui, au bar) et d'Inès (demain, en salle).
create temp table t_tache as select public.service_day() as d, null::uuid as theo, null::uuid as ines;
grant select, update on t_tache to anon, authenticated;
update t_tache set theo = (select id from public.profiles where email = 'theo@nuba.fr'),
                   ines = (select id from public.profiles where email = 'ines@nuba.fr');
update public.profiles set active = true where id in (select theo from t_tache union select ines from t_tache);
-- Ces deux jours-là, seuls ces deux services sont au planning.
delete from public.shifts
  where ((starts_at at time zone 'Europe/Paris') - interval '5 hours')::date between (select d from t_tache) and (select d + 1 from t_tache);
insert into public.shifts (profile_id, starts_at, ends_at, area) select
  theo, ((d + time '12:00') at time zone 'Europe/Paris'), ((d + time '15:00') at time zone 'Europe/Paris'), 'Bar' from t_tache;
insert into public.shifts (profile_id, starts_at, ends_at, area) select
  ines, ((d + 1 + time '18:00') at time zone 'Europe/Paris'), ((d + 1 + time '23:00') at time zone 'Europe/Paris'), ' salle ' from t_tache;

-- 1. Le gérant donne un poste et un jour à ses listes ; un équipier ne le peut pas
set role authenticated;
set request.jwt.claims = :boss;
do $$
declare
  tom int := extract(isodow from (select d + 1 from t_tache))::int;
begin
  perform public.save_checklist(null, 'Bar essai', 'service', 'daily', '[{"label": "Allumer la tireuse"}]', 'Bar', 3, 2);
  perform public.save_checklist(null, 'Tous essai', 'service', 'daily', '[{"label": "Saluer l''équipe"}]', '', null, null);
  perform public.save_checklist(null, 'Vitres essai', 'nettoyage', 'weekly', '[{"label": "Laver les vitres"}, {"label": "Essuyer les rebords"}]', 'Salle', tom, 4);
  perform public.save_checklist(null, 'Cave essai', 'service', 'weekly', '[{"label": "Compter les fûts"}]', 'Cave', tom, null);
  assert (select area = 'Bar' and due_weekday is null and due_week is null from public.checklists where name = 'Bar essai'), 'une liste du jour garde son poste, sans jour prévu';
  assert (select due_weekday = tom and due_week is null from public.checklists where name = 'Vitres essai'), 'la semaine : un jour, pas de rang';
  begin perform public.save_checklist(null, 'Mois essai', 'service', 'monthly', '[{"label": "x"}]', '', 2, null);
    raise exception 'TEST: une liste du mois sans rang a été acceptée';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
  -- Un autre jour que demain : elle ne doit pas être rappelée.
  perform public.save_checklist(null, 'Mois essai', 'service', 'monthly', '[{"label": "Détartrer"}]', '', (tom + 2) % 7 + 1, 5);
  assert (select due_weekday = (tom + 2) % 7 + 1 and due_week = 5 from public.checklists where name = 'Mois essai'), 'le dernier … du mois';
end $$;
set request.jwt.claims = :theo;
do $$ begin
  begin perform public.save_checklist(null, 'Pirate', 'service', 'daily', '[]', '', null, null); raise exception 'TEST: un équipier a créé une liste';
  exception when insufficient_privilege then null; end;
end $$;

-- 2. Le jour J : chacun voit les listes de son poste
do $$
declare
  l jsonb := public.checklists_today();
  item jsonb;
begin
  select e into item from jsonb_array_elements(l) e where e ->> 'name' = 'Bar essai';
  assert (item ->> 'mine')::boolean and item ->> 'area' = 'Bar', 'Théo, au bar aujourd''hui, a la liste du bar';
  assert (select (e ->> 'mine')::boolean from jsonb_array_elements(l) e where e ->> 'name' = 'Tous essai'), 'et celle de toute l''équipe';
  select e into item from jsonb_array_elements(l) e where e ->> 'name' = 'Vitres essai';
  assert not (item ->> 'mine')::boolean and not (item ->> 'mine_tomorrow')::boolean, 'pas celle de la salle';
  assert (item ->> 'next_due')::date = (select d + 1 from t_tache), 'les vitres sont prévues demain';
end $$;
set request.jwt.claims = :ines;
do $$
declare l jsonb := public.checklists_today();
begin
  assert not (select (e ->> 'mine')::boolean from jsonb_array_elements(l) e where e ->> 'name' = 'Tous essai'), 'pas au planning aujourd''hui : aucune liste à elle';
  assert (select (e ->> 'mine_tomorrow')::boolean from jsonb_array_elements(l) e where e ->> 'name' = 'Vitres essai'), 'demain en salle : les vitres l''attendent';
  assert not (select (e ->> 'mine_tomorrow')::boolean from jsonb_array_elements(l) e where e ->> 'name' = 'Bar essai'), 'pas la liste du bar';
end $$;

-- 3. Le rappel de la veille
reset role;
update public.email_settings set enabled = true, sender_email = 'appli@nuba.fr', notify_email = 'boss@nuba.fr', remind_tasks = true where true;
delete from public.email_outbox where kind = 'rappel_taches';
delete from public.task_reminder_days where true;
do $$
declare
  d  date := (select d from t_tache);
  n  int;
begin
  assert public.send_task_reminders((d + time '10:00') at time zone 'Europe/Paris') = 0, 'pas avant 16 h';
  assert public.send_task_reminders((d + time '22:00') at time zone 'Europe/Paris') = 0, 'pas après 21 h';
  n := public.send_task_reminders((d + time '18:00') at time zone 'Europe/Paris');
  assert n = 2, 'Inès, et le gérant pour la cave sans personne : ' || n || ' ' || coalesce((select string_agg(to_email || ' / ' || subject, ' | ') from public.email_outbox where kind = 'rappel_taches'), '');
  assert (select count(*) from public.email_outbox where kind = 'rappel_taches' and to_email = 'ines@nuba.fr'
          and subject = 'Demain à la Nuba : une liste de tâches'
          and body like '%tu es au planning (18 h – 23 h, salle)%Vitres essai (Salle) :%- Laver les vitres%- Essuyer les rebords%'
          and body not like '%Bar essai%' and body not like '%Mois essai%') = 1, 'Inès reçoit ses tâches de demain : '
          || coalesce((select body from public.email_outbox where kind = 'rappel_taches' and to_email = 'ines@nuba.fr'), 'rien');
  assert (select count(*) from public.email_outbox where kind = 'rappel_taches' and to_email = 'boss@nuba.fr'
          and body like '%Cave essai (poste Cave)%' and body not like '%Vitres%') = 1, 'le gérant : la cave n''a personne';
  assert not exists (select 1 from public.email_outbox where kind = 'rappel_taches' and to_email = 'theo@nuba.fr'), 'Théo n''est pas au planning demain';
  assert public.send_task_reminders((d + time '19:00') at time zone 'Europe/Paris') = 0, 'une seule fois par jour';
  assert (select emails from public.task_reminder_days where day = d + 1) = 2, 'envoi noté';
end $$;

-- Une liste déjà faite pour sa période n'est pas rappelée
delete from public.task_reminder_days where true;
delete from public.email_outbox where kind = 'rappel_taches';
insert into public.checklist_ticks (item_id, period, done_by)
  select i.id, public._period('weekly', (select d + 1 from t_tache)), (select ines from t_tache)
  from public.checklist_items i join public.checklists c on c.id = i.checklist_id where c.name = 'Vitres essai';
do $$ begin
  assert public.send_task_reminders(((select d from t_tache) + time '18:00') at time zone 'Europe/Paris') = 1, 'seul le gérant (la cave), les vitres sont faites';
  assert not exists (select 1 from public.email_outbox where kind = 'rappel_taches' and to_email = 'ines@nuba.fr'), 'Inès n''a plus rien à faire demain';
end $$;

-- Coupé dans les réglages : rien
delete from public.task_reminder_days where true;
update public.email_settings set remind_tasks = false where true;
do $$ begin
  assert public.send_task_reminders(((select d from t_tache) + time '18:00') at time zone 'Europe/Paris') = 0, 'rappels coupés';
end $$;

-- 4. L'état des rappels : pour le gérant
set role authenticated;
set request.jwt.claims = :boss;
do $$ begin
  assert public.reminders_status() ->> 'tasks' = 'false', 'sans pg_cron, pas de tâche planifiée';
end $$;

-- Remise en état
reset role;
delete from public.checklists where name in ('Bar essai', 'Tous essai', 'Vitres essai', 'Cave essai', 'Mois essai');
delete from public.shifts
  where ((starts_at at time zone 'Europe/Paris') - interval '5 hours')::date between (select d from t_tache) and (select d + 1 from t_tache);
delete from public.task_reminder_days where true;
delete from public.email_outbox where kind = 'rappel_taches';
update public.email_settings set enabled = false, sender_email = '', remind_tasks = true where true;
