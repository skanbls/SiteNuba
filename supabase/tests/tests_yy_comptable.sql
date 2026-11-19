-- Tests de la migration 0016 (accès de la comptable).
\set ON_ERROR_STOP on
\set boss  '''{"sub":"00000000-0000-0000-0000-000000000001"}'''
\set theo  '''{"sub":"00000000-0000-0000-0000-000000000002"}'''
\set ines  '''{"sub":"00000000-0000-0000-0000-000000000005"}'''
\set compta '''{"sub":"00000000-0000-0000-0000-000000000009"}'''
\set faux   '''{"sub":"00000000-0000-0000-0000-000000000010"}'''
reset role;
reset request.headers;
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-000000000009', 'Compta@Cabinet.fr', now()),
  ('00000000-0000-0000-0000-000000000010', 'compta2@cabinet.fr', null);
create temp table t_cpt (v text);
grant select, insert, update on t_cpt to anon, authenticated;

-- 1. Seul le gérant enregistre la comptable
set role authenticated;
set request.jwt.claims = :ines;
do $$ begin
  begin insert into public.accountants (email) values ('compta@cabinet.fr'); raise exception 'TEST: une responsable a créé un accès comptable';
  exception when insufficient_privilege then null; end;
  assert (select count(*) from public.accountants) = 0, 'une responsable ne lit pas les accès comptables';
end $$;
set request.jwt.claims = :boss;
do $$ begin
  begin insert into public.accountants (email) values ('theo@nuba.fr'); raise exception 'TEST: une adresse de l''équipe a été acceptée';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
  insert into public.accountants (email, name) values ('  COMPTA@cabinet.fr ', ' Cabinet Durand ');
  insert into public.accountants (email, name) values ('compta2@cabinet.fr', 'Pas confirmée');
  assert (select email = 'compta@cabinet.fr' and name = 'Cabinet Durand' from public.accountants where name = 'Cabinet Durand'), 'adresse et nom nettoyés';
  assert (public.hours_report(current_date - 30, current_date) -> 'entries') is not null, 'le gérant peut voir ce que voit la comptable';
end $$;

-- 2. La comptable : son compte se rattache, elle lit les heures et rien d'autre
set request.jwt.claims = :compta;
do $$
declare r jsonb; e jsonb;
begin
  assert (select count(*) from public.me()) = 0, 'la comptable n''est pas dans l''équipe';
  assert public.accountant_me() ->> 'name' = 'Cabinet Durand', 'son accès est reconnu';
  r := public.hours_report(current_date - 400, current_date);
  assert jsonb_array_length(r -> 'entries') > 0, 'elle lit les pointages : ' || jsonb_array_length(r -> 'entries');
  e := r -> 'entries' -> 0;
  assert e ? 'clock_in' and e ? 'time_breaks' and e -> 'profiles' ? 'first_name' and e ->> 'note' = '', 'forme des pointages, sans les notes : ' || e::text;
  assert exists (select 1 from jsonb_array_elements(r -> 'people') p where p ->> 'first_name' = 'Théo' and p ? 'weekly_hours' and not p ? 'email'), 'contrat et heures prévues, sans coordonnées';
  assert (select count(*) from public.time_entries) = 0 and (select count(*) from public.profiles) = 0, 'aucun accès direct aux tables de l''équipe';
  assert (select count(*) from public.reservations) = 0 and (select count(*) from public.contacts) = 0 and (select count(*) from public.shifts) = 0, 'ni réservations, ni numéros, ni planning';
  assert (select count(*) from public.accountants) = 0, 'elle ne lit pas les accès';
  assert public.today_tasks() is null, 'pas d''accueil de l''équipe';
  begin perform public.hours_report(current_date - 500, current_date); raise exception 'TEST: une période trop longue a été acceptée';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
  begin insert into public.time_entries (profile_id, clock_in) values ((select id from public.profiles limit 1), now()); raise exception 'TEST: la comptable a écrit un pointage';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
  assert (select user_id = '00000000-0000-0000-0000-000000000009' and last_seen_at is not null from public.accountants where name = 'Cabinet Durand'), 'compte rattaché, dernière visite notée';
end $$;

-- 3. Adresse non confirmée, équipier, public, code PIN : refusés
set role authenticated;
set request.jwt.claims = :faux;
do $$ begin
  assert public.accountant_me() is null, 'une adresse non confirmée n''ouvre rien';
  begin perform public.hours_report(current_date - 30, current_date); raise exception 'TEST: un compte non confirmé a lu les heures';
  exception when insufficient_privilege then null; end;
end $$;
set request.jwt.claims = :theo;
do $$ begin
  assert public.accountant_me() is null, 'un équipier n''est pas comptable';
  begin perform public.hours_report(current_date - 30, current_date); raise exception 'TEST: un équipier a lu les heures de tous';
  exception when insufficient_privilege then null; end;
end $$;
set request.jwt.claims = :ines;
do $$ begin
  begin perform public.hours_report(current_date - 30, current_date); raise exception 'TEST: une responsable a lu le rapport de la comptable';
  exception when insufficient_privilege then null; end;
end $$;
set role anon;
set request.jwt.claims = '';
do $$ begin
  begin perform public.hours_report(current_date - 30, current_date); raise exception 'TEST: le public a lu les heures';
  exception when insufficient_privilege then null; end;
  begin perform public.accountant_me(); raise exception 'TEST: le public a appelé accountant_me';
  exception when insufficient_privilege then null; end;
end $$;

-- 4. Accès désactivé : plus rien
set role authenticated;
set request.jwt.claims = :boss;
update public.accountants set active = false where name = 'Cabinet Durand';
set request.jwt.claims = :compta;
do $$ begin
  assert public.accountant_me() is null, 'accès désactivé';
  begin perform public.hours_report(current_date - 30, current_date); raise exception 'TEST: un accès désactivé a lu les heures';
  exception when insufficient_privilege then null; end;
end $$;

-- Remise en état
reset role;
delete from public.accountants;
