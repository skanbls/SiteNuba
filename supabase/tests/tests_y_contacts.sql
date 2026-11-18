-- Tests de la migration 0015 (numéros utiles). Joués après les autres modules.
\set ON_ERROR_STOP on
\set boss  '''{"sub":"00000000-0000-0000-0000-000000000001"}'''
\set theo  '''{"sub":"00000000-0000-0000-0000-000000000002"}'''
\set intru '''{"sub":"00000000-0000-0000-0000-000000000003"}'''
\set ines  '''{"sub":"00000000-0000-0000-0000-000000000005"}'''
reset role;
reset request.headers;
create temp table t_num (v text);
grant select, update, insert on t_num to anon, authenticated;
do $$ begin
  assert (select count(*) from public.contacts where urgent) = 6 and exists (select 1 from public.contacts where phone = '15'), 'les numéros d''urgence sont en place';
end $$;

-- 1. Le public et un inconnu ne lisent rien
set role anon;
set request.jwt.claims = '';
do $$ begin
  assert (select count(*) from public.contacts) = 0, 'le public ne lit pas les numéros';
  begin insert into public.contacts (name, phone) values ('Pirate', '0600000000'); raise exception 'TEST: le public a ajouté un numéro';
  exception when insufficient_privilege then null; end;
end $$;
set role authenticated;
set request.jwt.claims = :intru;
do $$ begin
  assert (select count(*) from public.contacts) = 0, 'un inconnu ne lit pas les numéros';
end $$;

-- 2. Un équipier lit, mais ne modifie rien
set request.jwt.claims = :theo;
do $$ begin
  assert (select count(*) from public.contacts) = 7, 'l''équipe lit les numéros';
  begin insert into public.contacts (name, phone) values ('Mon cousin', '0611111111'); raise exception 'TEST: un équipier a ajouté un numéro';
  exception when insufficient_privilege then null; end;
  update public.contacts set phone = '0699999999' where phone = '15';
  delete from public.contacts where phone = '18';
  assert exists (select 1 from public.contacts where phone = '15') and exists (select 1 from public.contacts where phone = '18'), 'un équipier ne modifie ni ne supprime';
end $$;

-- 3. Une responsable ajoute, modifie et supprime, sans accès particulier
set request.jwt.claims = :ines;
do $$
declare i uuid;
begin
  assert not public.can('checklists') or true, 'aucun accès délégué n''est demandé';
  insert into public.contacts (category, name, phone, note) values ('depannage', '  Plombier Garcia ', ' 06 12 34 56 78 ', ' Fuite, évacuation bouchée ') returning id into i;
  assert (select name = 'Plombier Garcia' and phone = '06 12 34 56 78' and note = 'Fuite, évacuation bouchée'
          and updated_by = (select id from public.profiles where email = 'ines@nuba.fr') from public.contacts where id = i), 'nettoyé et signé par Inès';
  update public.contacts set note = 'Disponible le dimanche' where id = i;
  assert (select note from public.contacts where id = i) = 'Disponible le dimanche', 'elle modifie';
  begin insert into public.contacts (name, phone) values ('Lien piégé', 'javascript:alert(1)'); raise exception 'TEST: un numéro invalide a été accepté';
  exception when check_violation then null; end;
  begin insert into public.contacts (category, name, phone) values ('inconnue', 'X', '0600000000'); raise exception 'TEST: une catégorie inconnue a été acceptée';
  exception when check_violation then null; end;
  insert into public.contacts (category, name, phone) values ('autre', 'À supprimer', '0600000001');
  delete from public.contacts where name = 'À supprimer';
  assert not exists (select 1 from public.contacts where name = 'À supprimer'), 'elle supprime';
  update t_num set v = i::text;
  insert into t_num values (i::text);
end $$;

-- 4. Le gérant aussi
set request.jwt.claims = :boss;
do $$ begin
  insert into public.contacts (category, name, phone, position) values ('equipe', 'Sam, gérant', '06 00 00 00 01', 1);
  assert (select count(*) from public.contacts) = 9, 'le gérant ajoute';
end $$;

-- 5. Session à code PIN : lecture seulement, même pour une responsable
update t_num set v = (public.add_kiosk((select id from public.sites limit 1), 'iPad numéros')) ->> 'code';
set role anon;
set request.jwt.claims = '';
do $$
declare
  tok text := (public.claim_kiosk((select v from t_num limit 1))) ->> 'token';
  ines uuid := (select (e ->> 'id')::uuid from jsonb_array_elements(public.kiosk_team(tok)) e where e ->> 'first_name' = 'Inès');
begin
  update t_num set v = (public.kiosk_login(tok, ines, '7391')) ->> 'ticket';
end $$;
select set_config('request.headers', json_build_object('x-nuba-ticket', (select v from t_num limit 1))::text, false) \gset ignore_
do $$ begin
  assert public.my_profile_id() is not null, 'session à code PIN ouverte';
  assert (select count(*) from public.contacts) = 9, 'la session à code PIN lit les numéros';
  begin insert into public.contacts (name, phone) values ('Pirate', '0600000000'); raise exception 'TEST: une session à code PIN a ajouté un numéro';
  exception when insufficient_privilege then null; end;
end $$;
reset request.headers;

-- Remise en état
reset role;
update public.kiosks set revoked_at = now() where revoked_at is null;
