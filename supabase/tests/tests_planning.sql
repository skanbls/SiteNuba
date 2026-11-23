-- Tests de la migration 0002 (planning, congés, échanges). Joués après tests.sql, sur la même base.
\set ON_ERROR_STOP on
\set boss  '''{"sub":"00000000-0000-0000-0000-000000000001"}'''
\set theo  '''{"sub":"00000000-0000-0000-0000-000000000002"}'''
\set intru '''{"sub":"00000000-0000-0000-0000-000000000003"}'''
\set ines  '''{"sub":"00000000-0000-0000-0000-000000000005"}'''

reset role;
update public.profiles set active = true where email = 'theo@nuba.fr';

-- 1. Le gérant écrit le planning ; les chevauchements et les durées absurdes sont refusés
set role authenticated;
set request.jwt.claims = :boss;
do $$
declare
  theo uuid := (select id from public.profiles where email = 'theo@nuba.fr');
  ines uuid := (select id from public.profiles where email = 'ines@nuba.fr');
  d timestamptz := date_trunc('day', now()) + interval '2 days';
begin
  insert into public.shifts (profile_id, starts_at, ends_at, area) values (theo, d + interval '18 hours', d + interval '24 hours', '  Salle ');
  assert (select area from public.shifts where profile_id = theo) = 'Salle', 'le poste doit être nettoyé';
  begin
    insert into public.shifts (profile_id, starts_at, ends_at) values (theo, d + interval '23 hours', d + interval '26 hours');
    raise exception 'TEST: deux services se chevauchent pour la même personne';
  exception when sqlstate 'P0001' then
    if sqlerrm like 'TEST:%' then raise; end if;
  end;
  begin
    insert into public.shifts (profile_id, starts_at, ends_at) values (ines, d, d + interval '17 hours');
    raise exception 'TEST: un service de 17 heures a été accepté';
  exception when check_violation then null; end;
  insert into public.shifts (profile_id, starts_at, ends_at, area) values (ines, d + interval '18 hours', d + interval '24 hours', 'Bar');
  insert into public.shifts (profile_id, starts_at, ends_at, area) values (theo, d + interval '24 hours', d + interval '30 hours', 'Salle');
end $$;

-- 2. Un équipier lit le planning mais ne l'écrit pas
set request.jwt.claims = :theo;
do $$
declare n int;
begin
  assert (select count(*) from public.shifts) = 3, 'un équipier doit voir tout le planning';
  begin
    insert into public.shifts (profile_id, starts_at, ends_at) values ((select public.my_profile_id()), now() + interval '9 days', now() + interval '9 days 4 hours');
    raise exception 'TEST: un équipier a pu ajouter un service';
  exception when insufficient_privilege then null; end;
  update public.shifts set area = 'Pirate';
  get diagnostics n = row_count;
  assert n = 0, 'un équipier ne doit pas modifier le planning';
  delete from public.shifts;
  get diagnostics n = row_count;
  assert n = 0, 'un équipier ne doit pas supprimer de service';
end $$;

-- 3. Congés : chacun demande pour soi, seul le gérant décide
do $$
declare me uuid := (select public.my_profile_id()); ines uuid := (select id from public.profiles where email = 'ines@nuba.fr');
begin
  insert into public.leave_requests (profile_id, start_date, end_date, note) values (me, current_date + 10, current_date + 12, 'Mariage');
  begin
    insert into public.leave_requests (profile_id, start_date, end_date, status) values (me, current_date + 20, current_date + 21, 'approved');
    raise exception 'TEST: un équipier a pu s''accorder un congé';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.leave_requests (profile_id, start_date, end_date) values (ines, current_date + 20, current_date + 21);
    raise exception 'TEST: un équipier a pu demander un congé pour quelqu''un d''autre';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.leave_requests (profile_id, start_date, end_date) values (me, current_date + 5, current_date + 4);
    raise exception 'TEST: un congé qui finit avant de commencer a été accepté';
  exception when check_violation then null; end;
  begin
    perform public.decide_leave((select id from public.leave_requests limit 1), true);
    raise exception 'TEST: un équipier a pu décider d''un congé';
  exception when insufficient_privilege then null; end;
  begin
    update public.leave_requests set status = 'approved';
    raise exception 'TEST: un équipier a pu modifier une demande de congé';
  exception when insufficient_privilege then null; end;
end $$;
set request.jwt.claims = :ines;
do $$ begin
  assert (select count(*) from public.leave_requests) = 1, 'une responsable voit les demandes en attente';
  insert into public.leave_requests (profile_id, start_date, end_date, kind) values ((select public.my_profile_id()), current_date + 30, current_date + 30, 'indisponibilite');
  begin
    perform public.decide_leave((select id from public.leave_requests where note = 'Mariage'), true);
    raise exception 'TEST: une responsable a pu décider d''un congé';
  exception when insufficient_privilege then null; end;
end $$;
set request.jwt.claims = :theo;
do $$ begin
  assert (select count(*) from public.leave_requests) = 1, 'un équipier ne voit pas les demandes en attente des autres';
end $$;
set request.jwt.claims = :boss;
do $$ begin
  assert (select count(*) from public.leave_requests) = 2, 'le gérant voit toutes les demandes';
  perform public.decide_leave((select id from public.leave_requests where kind = 'indisponibilite'), true);
  perform public.decide_leave((select id from public.leave_requests where note = 'Mariage'), false);
  assert (select count(*) from public.leave_requests where decided_by is not null and decided_at is not null) = 2, 'la décision doit être signée et datée';
end $$;
set request.jwt.claims = :theo;
do $$
declare n int;
begin
  -- Depuis la 0020 : chacun lit ses propres absences ; celles des autres, sans motif, par team_absences.
  assert (select count(*) from public.leave_requests) = 1, 'un équipier lit ses propres absences';
  assert exists (select 1 from jsonb_array_elements(public.team_absences(current_date)) a
                 where a ->> 'profile_id' = (select id::text from public.profiles where email = 'ines@nuba.fr')), 'une absence acceptée est connue de toute l''équipe';
  assert (select status from public.leave_requests where note = 'Mariage') = 'refused', 'Théo voit sa demande refusée';
  delete from public.leave_requests;
  get diagnostics n = row_count;
  assert n = 0, 'une demande déjà traitée ne s''annule plus';
  insert into public.leave_requests (profile_id, start_date, end_date) values ((select public.my_profile_id()), current_date + 40, current_date + 41);
  delete from public.leave_requests where status = 'pending';
  get diagnostics n = row_count;
  assert n = 1, 'chacun annule sa demande en attente';
end $$;

-- 4. Échanges : céder un service à un collègue, sous réserve de l'accord du gérant
do $$
declare
  me uuid := (select public.my_profile_id());
  ines uuid := (select id from public.profiles where email = 'ines@nuba.fr');
  mine uuid := (select id from public.shifts where profile_id = me order by starts_at limit 1);
  hers uuid := (select id from public.shifts where profile_id = ines limit 1);
begin
  begin
    perform public.request_swap(hers, me, '');
    raise exception 'TEST: on a pu céder le service de quelqu''un d''autre';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
  begin
    perform public.request_swap(mine, me, '');
    raise exception 'TEST: on a pu se céder un service à soi-même';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
  perform public.request_swap(mine, ines, 'Rendez-vous médical');
  begin
    perform public.request_swap(mine, ines, '');
    raise exception 'TEST: deux demandes en attente pour le même service';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
  begin
    perform public.decide_swap((select id from public.shift_swaps limit 1), true);
    raise exception 'TEST: un équipier a pu accepter un échange';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.shift_swaps (shift_id, from_profile, to_profile) values (mine, me, ines);
    raise exception 'TEST: un échange a pu être créé sans passer par request_swap';
  exception when insufficient_privilege then null; end;
end $$;
set request.jwt.claims = :ines;
do $$ begin
  assert (select count(*) from public.shift_swaps) = 1, 'la collègue concernée voit la demande';
end $$;
set request.jwt.claims = :boss;
do $$
declare
  w public.shift_swaps;
  ines uuid := (select id from public.profiles where email = 'ines@nuba.fr');
begin
  select * into w from public.shift_swaps;
  -- Inès travaille déjà sur ce créneau : l'échange ne peut pas passer.
  begin
    perform public.decide_swap(w.id, true);
    raise exception 'TEST: un échange a créé un chevauchement';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
  assert (select status from public.shift_swaps where id = w.id) = 'pending', 'un échange impossible reste en attente';
  delete from public.shifts where profile_id = ines;
  perform public.decide_swap(w.id, true);
  assert (select profile_id from public.shifts where id = w.shift_id) = ines, 'le service accepté passe à la collègue';
  assert (select status = 'approved' and decided_by is not null from public.shift_swaps where id = w.id), 'la décision doit être signée';
  begin
    perform public.decide_swap(w.id, false);
    raise exception 'TEST: une demande déjà traitée a été retraitée';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
end $$;

-- 5. Un inconnu ne voit rien du planning
set request.jwt.claims = :intru;
do $$ begin
  assert (select count(*) from public.shifts) = 0, 'un inconnu ne doit pas lire le planning';
  assert (select count(*) from public.leave_requests) = 0, 'un inconnu ne doit pas lire les congés';
  assert (select count(*) from public.shift_swaps) = 0, 'un inconnu ne doit pas lire les échanges';
end $$;
reset role;
