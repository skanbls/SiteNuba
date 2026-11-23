-- Tests de la migration 0021 : bulletins de paie. Données inventées.
\set ON_ERROR_STOP on
\set boss   '''{"sub":"00000000-0000-0000-0000-000000000001"}'''
\set theo   '''{"sub":"00000000-0000-0000-0000-000000000002"}'''
\set ines   '''{"sub":"00000000-0000-0000-0000-000000000005"}'''
\set compta '''{"sub":"00000000-0000-0000-0000-000000000015"}'''
reset role;
reset request.headers;
insert into auth.users (id, email, email_confirmed_at) values ('00000000-0000-0000-0000-000000000015', 'paie@compta.fr', now());
insert into public.accountants (email, name) values ('paie@compta.fr', 'Cabinet paie');
update public.email_settings set enabled = true, sender_email = 'appli@nuba.fr', notify_payslips = true where id;
delete from public.email_outbox where kind = 'bulletin';
create temp table t_paie (k text, v text);
grant select, insert, update on t_paie to anon, authenticated;
insert into t_paie values ('theo', (select id::text from public.profiles where email = 'theo@nuba.fr')),
                          ('ines', (select id::text from public.profiles where email = 'ines@nuba.fr'));

-- 1. La comptable dépose le bulletin de Théo ; rien d'autre
set role authenticated;
set request.jwt.claims = :compta;
do $$
declare
  theo text := (select v from t_paie where k = 'theo');
  d uuid;
begin
  assert public.accountant_me() is not null, 'la comptable est reconnue';
  insert into storage.objects (bucket_id, name) values ('staff-docs', theo || '/paie-2026-11-a.pdf');
  begin insert into storage.objects (bucket_id, name) values ('staff-docs', theo || '/cni.pdf');
    raise exception 'TEST: la comptable a déposé autre chose qu''un bulletin';
  exception when insufficient_privilege then null; end;
  d := public.add_staff_document(theo::uuid, 'paie', 'Bulletin', theo || '/paie-2026-11-a.pdf', 'novembre.pdf', 'application/pdf', 900, '2026-11-15', null, '');
  assert (select start_date = '2026-11-01' and end_date = '2026-11-30' and accountant_id is not null and uploaded_by is null
          from public.staff_documents where id = d), 'rangé au mois, signé par la comptable';
  begin perform public.add_staff_document(theo::uuid, 'identite', '', theo || '/paie-2026-11-a.pdf', 'x', '', 1, null, null, '');
    raise exception 'TEST: la comptable a enregistré un autre document';
  exception when insufficient_privilege then null; end;
  begin perform public.add_staff_document(theo::uuid, 'paie', '', theo || '/paie-2026-11-a.pdf', 'x', '', 1, null, null, '');
    raise exception 'TEST: un bulletin sans mois a été accepté';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
  insert into t_paie values ('doc', d::text);
end $$;
reset role;
do $$ begin
  assert (select count(*) from public.email_outbox where kind = 'bulletin' and to_email = 'theo@nuba.fr'
          and subject = 'Ton bulletin de paie de novembre 2026') = 1, 'Théo est prévenu par e-mail';
  assert not exists (select 1 from public.email_outbox where kind = 'document' and subject like '%Théo%' and created_at > now() - interval '1 minute'
                     and to_email = 'paie@compta.fr'), 'la comptable n''est pas prévenue de son propre dépôt';
end $$;

-- 2. Théo voit son bulletin ; les autres non ; il n'en dépose pas
set role authenticated;
set request.jwt.claims = :theo;
do $$
declare theo text := (select v from t_paie where k = 'theo');
begin
  assert exists (select 1 from public.staff_documents where category = 'paie'), 'Théo voit son bulletin';
  assert exists (select 1 from storage.objects where name = theo || '/paie-2026-11-a.pdf'), 'et l''ouvre';
  insert into storage.objects (bucket_id, name) values ('staff-docs', theo || '/paie-faux.pdf');
  begin perform public.add_staff_document(theo::uuid, 'paie', '', theo || '/paie-faux.pdf', 'x', '', 1, '2026-11-01', null, '');
    raise exception 'TEST: un salarié a déposé un bulletin';
  exception when insufficient_privilege then null; end;
  begin perform public.delete_payslip((select v::uuid from t_paie where k = 'doc')); raise exception 'TEST: un salarié a retiré son bulletin';
  exception when insufficient_privilege then null; end;
end $$;
set request.jwt.claims = :ines;
do $$ begin
  assert not exists (select 1 from public.staff_documents where category = 'paie'
                     and profile_id = (select v::uuid from t_paie where k = 'theo')), 'une responsable ne voit pas le bulletin de Théo';
end $$;

-- 3. Le gérant dépose aussi ; la comptable ne retire que les siens
set request.jwt.claims = :boss;
do $$
declare ines text := (select v from t_paie where k = 'ines');
begin
  insert into storage.objects (bucket_id, name) values ('staff-docs', ines || '/paie-2026-10-b.pdf');
  insert into t_paie values ('gerant', public.add_staff_document(ines::uuid, 'paie', '', ines || '/paie-2026-10-b.pdf', 'octobre.pdf', 'application/pdf', 800, '2026-10-03', null, '')::text);
end $$;
set request.jwt.claims = :compta;
do $$ begin
  begin perform public.delete_payslip((select v::uuid from t_paie where k = 'gerant')); raise exception 'TEST: la comptable a retiré un bulletin du gérant';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
  assert public.delete_payslip((select v::uuid from t_paie where k = 'doc')) like '%/paie-2026-11-a.pdf', 'elle retire le sien';
  delete from storage.objects where name like '%/paie-2026-11-a.pdf';
  assert not exists (select 1 from storage.objects where name like '%/paie-2026-11-a.pdf'), 'et son fichier';
  delete from storage.objects where name like '%/paie-2026-10-b.pdf';
end $$;
reset role;
do $$ begin
  assert exists (select 1 from storage.objects where name like '%/paie-2026-10-b.pdf'), 'le fichier d''un bulletin déposé par le gérant reste';
end $$;

-- Remise en état
reset role;
delete from public.staff_documents where true;
delete from storage.objects where bucket_id = 'staff-docs';
delete from public.accountants;
delete from public.email_outbox where kind in ('bulletin', 'document');
update public.email_settings set enabled = false, sender_email = '' where id;
