-- Tests de la migration 0005 (checklists et hygiène). Joués en dernier, sur la même base.
\set ON_ERROR_STOP on
\set boss  '''{"sub":"00000000-0000-0000-0000-000000000001"}'''
\set theo  '''{"sub":"00000000-0000-0000-0000-000000000002"}'''
\set intru '''{"sub":"00000000-0000-0000-0000-000000000003"}'''
\set ines  '''{"sub":"00000000-0000-0000-0000-000000000005"}'''

reset role;
reset request.headers;
do $$ begin
  assert (select count(*) from public.checklists) = 7 and (select count(*) from public.checklist_items) = 35, 'les modèles de checklists doivent être en place';
  assert (select count(*) from public.cold_units) = 5, 'les enceintes modèles doivent être en place';
  assert public._period('weekly', date '2026-11-18') = date '2026-11-16', 'la semaine commence le lundi';
  assert public._period('monthly', date '2026-11-18') = date '2026-11-01', 'le mois commence le 1er';
  assert public._period('daily', date '2026-11-18') = date '2026-11-18', 'le jour reste le jour';
end $$;

-- 1. Cocher : chacun coche, on ne décoche que sa case, le gérant décoche tout
set role authenticated;
set request.jwt.claims = :theo;
do $$
declare
  lists jsonb := public.checklists_today();
  item uuid := (lists -> 0 -> 'items' -> 0 ->> 'id')::uuid;
  r jsonb;
begin
  assert jsonb_array_length(lists) = 7 and lists -> 0 ->> 'name' = 'Ouverture bar', 'les listes doivent arriver dans l''ordre';
  assert not (lists -> 0 -> 'items' -> 0 ->> 'done')::boolean, 'rien n''est coché au départ';
  assert ((public.tick_item(item, true)) ->> 'ok')::boolean and ((public.tick_item(item, true)) ->> 'ok')::boolean, 'cocher deux fois ne casse rien';
  lists := public.checklists_today();
  assert (lists -> 0 -> 'items' -> 0 ->> 'done')::boolean and lists -> 0 -> 'items' -> 0 ->> 'done_by_name' = 'Théo', 'la case garde qui l''a cochée';
  assert (select count(*) from public.checklist_ticks) = 1, 'une seule coche par case et par période';
  assert (public.tick_item(gen_random_uuid(), true)) ->> 'error' = 'item', 'une case inconnue est refusée';
  begin
    insert into public.checklist_ticks (item_id, period) values (item, current_date - 1);
    raise exception 'TEST: une coche a pu être écrite sans passer par tick_item';
  exception when insufficient_privilege then null; end;
  begin
    perform public.save_checklist(null, 'Pirate', 'service', 'daily', '[]');
    raise exception 'TEST: un équipier a pu créer une checklist';
  exception when insufficient_privilege then null; end;
end $$;
set request.jwt.claims = :ines;
do $$
declare item uuid := (select item_id from public.checklist_ticks limit 1);
begin
  assert (public.tick_item(item, false)) ->> 'error' = 'not_yours', 'on ne décoche pas la case d''un autre';
end $$;
set request.jwt.claims = :boss;
do $$
declare item uuid := (select item_id from public.checklist_ticks limit 1);
begin
  assert ((public.tick_item(item, false)) ->> 'ok')::boolean, 'le gérant peut décocher';
  assert (select count(*) from public.checklist_ticks) = 0, 'la coche doit avoir disparu';
end $$;

-- 2. Le gérant compose une checklist : création, renommage, ordre, case retirée sans perdre l'historique
do $$
declare
  c uuid;
  a uuid; b uuid;
begin
  c := public.save_checklist(null, '  Brunch  ', 'service', 'weekly', '[{"label":"Dresser le buffet"},{"label":"  "},{"label":"Presser les oranges"}]');
  assert (select name = 'Brunch' and frequency = 'weekly' from public.checklists where id = c), 'la checklist doit être créée, nom nettoyé';
  assert (select count(*) from public.checklist_items where checklist_id = c and active) = 2, 'les cases vides sont ignorées';
  select id into a from public.checklist_items where checklist_id = c and label = 'Dresser le buffet';
  select id into b from public.checklist_items where checklist_id = c and label = 'Presser les oranges';
  perform public.tick_item(a, true);
  perform public.save_checklist(c, 'Brunch du dimanche', 'service', 'weekly', jsonb_build_array(jsonb_build_object('id', b, 'label', 'Presser les agrumes'), jsonb_build_object('label', 'Sortir les viennoiseries')));
  assert (select label = 'Presser les agrumes' and position = 1 from public.checklist_items where id = b), 'renommer et réordonner';
  assert (select not active from public.checklist_items where id = a), 'une case retirée est désactivée';
  assert (select count(*) from public.checklist_ticks where item_id = a) = 1, 'son historique est conservé';
  assert (select jsonb_array_length(l -> 'items') from jsonb_array_elements(public.checklists_today()) l where l ->> 'name' = 'Brunch du dimanche') = 2, 'la liste du jour ne montre que les cases actives';
  begin
    perform public.save_checklist(null, 'X', 'service', 'chaque heure', '[]');
    raise exception 'TEST: une fréquence inconnue a été acceptée';
  exception when check_violation then null; end;
  update public.checklists set active = false where id = c;
  assert (select count(*) from jsonb_array_elements(public.checklists_today()) l where l ->> 'name' = 'Brunch du dimanche') = 0, 'une checklist désactivée disparaît';
end $$;

-- 3. Températures : relevé, hors limite, action corrective
set request.jwt.claims = :theo;
do $$
declare
  frigo uuid := (select id from public.cold_units where name = 'Frigo bar');
  congel uuid := (select id from public.cold_units where name = 'Congélateur');
  t jsonb := public.today_tasks();
  r jsonb;
begin
  assert (t ->> 'temps_due')::int = 5 and (t ->> 'temps_alerts')::int = 0, 'au départ, les 5 enceintes sont à relever : ' || t::text;
  r := public.record_temp(frigo, 3.44);
  assert (r ->> 'ok')::boolean and not (r ->> 'out_of_range')::boolean, 'un relevé dans la cible est conforme';
  assert (select value = 3.4 and taken_by is not null and day = public.service_day() from public.temp_readings where id = (r ->> 'id')::uuid), 'le relevé est arrondi, signé et daté';
  r := public.record_temp(congel, -12);
  assert (r ->> 'out_of_range')::boolean, 'un congélateur à -12 est hors limite';
  t := public.today_tasks();
  assert (t ->> 'temps_due')::int = 3 and (t ->> 'temps_alerts')::int = 1, 'deux enceintes relevées, une alerte : ' || t::text;
  begin
    perform public.note_corrective((r ->> 'id')::uuid, '   ');
    raise exception 'TEST: une action corrective vide a été acceptée';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
  perform public.note_corrective((r ->> 'id')::uuid, 'Porte mal fermée, recontrôle dans 30 min');
  assert ((public.today_tasks()) ->> 'temps_alerts')::int = 0, 'l''action corrective lève l''alerte';
  assert (public.record_temp(gen_random_uuid(), 2)) ->> 'error' = 'unit', 'une enceinte inconnue est refusée';
  assert (public.record_temp(frigo, 99)) ->> 'error' = 'value', 'une valeur absurde est refusée';
  begin
    insert into public.temp_readings (unit_id, value, day, slot, out_of_range) values (frigo, 2, current_date, 'matin', false);
    raise exception 'TEST: un relevé a pu être écrit sans passer par record_temp';
  exception when insufficient_privilege then null; end;
  update public.cold_units set max_temp = 20;
  assert (select count(*) from public.cold_units where max_temp = 20) = 0, 'un équipier ne modifie pas une enceinte';
  delete from public.temp_readings;
  assert (select count(*) from public.temp_readings) = 2, 'un équipier ne supprime pas de relevé';
end $$;

-- 4. Traçabilité et huile
do $$
declare
  me uuid := public.my_profile_id();
  d date := public.service_day();
  v uuid;
begin
  insert into public.trace_items (name, made_on, use_by, created_by) values ('Chimichurri', d - 1, d + 2, me);
  insert into public.trace_items (name, made_on, use_by, created_by) values ('Magret tranché', d - 2, d, me);
  insert into public.trace_items (name, kind, made_on, use_by, created_by) values ('Crème pâtissière', 'preparation', d - 3, d - 1, me) returning id into v;
  begin
    insert into public.trace_items (name, made_on, use_by, created_by) values ('Faux', d, d, (select id from public.profiles where email = 'ines@nuba.fr'));
    raise exception 'TEST: une étiquette a pu être signée d''un autre nom';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.trace_items (name, made_on, use_by, created_by) values ('Impossible', d, d - 1, me);
    raise exception 'TEST: une date limite avant la fabrication a été acceptée';
  exception when check_violation then null; end;
  assert ((public.today_tasks()) ->> 'dlc_today')::int = 1 and ((public.today_tasks()) ->> 'dlc_late')::int = 1, 'une préparation pour aujourd''hui, une dépassée';
  perform public.close_trace(v, 'jete');
  assert (select closed_reason = 'jete' and closed_by = me from public.trace_items where id = v), 'la sortie est signée';
  assert ((public.today_tasks()) ->> 'dlc_late')::int = 0, 'une préparation jetée ne compte plus';
  begin
    perform public.close_trace(v, 'utilise');
    raise exception 'TEST: une étiquette a été sortie deux fois';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;

  begin
    insert into public.oil_logs (action, done_by) values ('test', me);
    raise exception 'TEST: un test d''huile sans valeur a été accepté';
  exception when check_violation then null; end;
  insert into public.oil_logs (action, polar_pct, done_by) values ('test', 18, me);
  insert into public.oil_logs (action, done_by) values ('changement', me);
  begin
    insert into public.oil_logs (action, done_by) values ('changement', (select id from public.profiles where email = 'ines@nuba.fr'));
    raise exception 'TEST: un changement d''huile a pu être signé d''un autre nom';
  exception when insufficient_privilege then null; end;
end $$;

-- 5. Un inconnu ne voit rien
set request.jwt.claims = :intru;
do $$ begin
  assert public.checklists_today() is null and public.today_tasks() is null, 'un inconnu ne reçoit rien';
  assert (public.tick_item(gen_random_uuid(), true)) ->> 'error' = 'no_profile', 'un inconnu ne coche rien';
  assert (public.record_temp(gen_random_uuid(), 2)) ->> 'error' = 'no_profile', 'un inconnu ne relève rien';
  assert (select count(*) from public.checklists) = 0 and (select count(*) from public.temp_readings) = 0
     and (select count(*) from public.trace_items) = 0 and (select count(*) from public.oil_logs) = 0, 'un inconnu ne lit rien';
end $$;

-- 6. Sur l'iPad, par code PIN : mêmes gestes, sans les droits du gérant
set request.jwt.claims = :boss;
create temp table t_hyg as select public.add_kiosk((select id from public.sites limit 1), 'iPad cuisine hygiène') as k, null::text as ticket;
grant select, update on t_hyg to anon, authenticated;
set role anon;
set request.jwt.claims = '';
do $$
declare
  tok text := (public.claim_kiosk((select k ->> 'code' from t_hyg))) ->> 'token';
  hugo uuid := (select (e ->> 'id')::uuid from jsonb_array_elements(public.kiosk_team(tok)) e where e ->> 'first_name' = 'Hugo');
begin
  update t_hyg set ticket = (public.kiosk_login(tok, hugo, '8642')) ->> 'ticket';
  assert (select ticket from t_hyg) is not null, 'la session de Hugo doit s''ouvrir';
  assert public.checklists_today() is null, 'sans ticket, pas de checklists';
end $$;
select set_config('request.headers', json_build_object('x-nuba-ticket', (select ticket from t_hyg))::text, false) \gset ignore_
do $$
declare
  me uuid := public.my_profile_id();
  lists jsonb := public.checklists_today();
  item uuid := (lists -> 1 -> 'items' -> 0 ->> 'id')::uuid;
  d date := public.service_day();
begin
  assert jsonb_array_length(lists) = 7, 'la session à code PIN voit les checklists';
  assert ((public.tick_item(item, true)) ->> 'ok')::boolean, 'la session à code PIN coche';
  assert (select done_by = me from public.checklist_ticks where item_id = item), 'la coche est signée Hugo';
  assert ((public.record_temp((select id from public.cold_units where name = 'Timbre cuisine'), 2.5)) ->> 'ok')::boolean, 'la session à code PIN relève une température';
  insert into public.trace_items (name, made_on, use_by, created_by) values ('Sirop de gingembre', d, d + 4, me);
  insert into public.oil_logs (action, polar_pct, done_by) values ('test', 20, me);
  assert (select count(*) from public.trace_items) = 4 and (select count(*) from public.temp_readings) = 3, 'la session à code PIN lit l''hygiène';
  begin
    perform public.save_checklist(null, 'Pirate', 'service', 'daily', '[]');
    raise exception 'TEST: une session à code PIN a pu créer une checklist';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.cold_units (name, min_temp, max_temp) values ('Pirate', 0, 4);
    raise exception 'TEST: une session à code PIN a pu créer une enceinte';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.temp_readings;
    raise exception 'TEST: une session à code PIN a pu supprimer des relevés';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
reset request.headers;
update public.kiosks set revoked_at = now() where revoked_at is null;
