-- Tests de la migration 0023 : fiches process de production. Données inventées.
\set ON_ERROR_STOP on
\set boss '''{"sub":"00000000-0000-0000-0000-000000000001"}'''
\set theo '''{"sub":"00000000-0000-0000-0000-000000000002"}'''
reset role;
reset request.headers;
delete from public.merc_process;
delete from storage.objects where bucket_id = 'dish-photos';

-- 1. Le gérant écrit une fiche process, avec sa photo
set role authenticated;
set request.jwt.claims = :boss;
do $$ begin
  insert into storage.objects (bucket_id, name) values ('dish-photos', 'saveurs_nomades/essai-a.jpg');
  begin insert into storage.objects (bucket_id, name) values ('dish-photos', 'ailleurs/essai.jpg');
    raise exception 'TEST: une photo rangée hors des dossiers des mercuriales';
  exception when insufficient_privilege then null; end;
  assert public.save_process('saveurs_nomades', 'puree test + poulet test', 'Purée test + Poulet test',
    E'# Cuisson\nCuire.\nRefroidir.', 'Dans la barquette.', 'Cœur à 75 °C.', 'saveurs_nomades/essai-a.jpg') = '', 'première fiche : pas d''ancienne photo';
  assert (select name = 'Purée test + Poulet test' and steps like '# Cuisson%' and photo_path = 'saveurs_nomades/essai-a.jpg'
          and updated_by is not null from public.merc_process), 'la fiche est enregistrée';
  begin perform public.save_process('saveurs_nomades', 'x', 'X', '', '', '', 'saveurs_nomades/absente.jpg');
    raise exception 'TEST: une photo absente a été acceptée';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
  begin perform public.save_process('saveurs_nomades', 'x', 'X', '', '', '', 'comptoir/essai-a.jpg');
    raise exception 'TEST: la photo d''une autre mercuriale a été acceptée';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
  begin perform public.save_process('nuba', 'x', 'X', '', '', '', '');
    raise exception 'TEST: une mercuriale inconnue a été acceptée';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
  -- La photo utilisée par une fiche ne se retire pas.
  delete from storage.objects where name = 'saveurs_nomades/essai-a.jpg';
  assert exists (select 1 from storage.objects where name = 'saveurs_nomades/essai-a.jpg'), 'la photo d''une fiche reste';
  -- Nouvelle photo : la fonction rend l'ancienne, qui peut alors partir.
  insert into storage.objects (bucket_id, name) values ('dish-photos', 'saveurs_nomades/essai-b.jpg');
  assert public.save_process('saveurs_nomades', 'PUREE TEST + POULET TEST', 'Purée test + Poulet test', 'Cuire.', '', '', 'saveurs_nomades/essai-b.jpg')
         = 'saveurs_nomades/essai-a.jpg', 'l''ancienne photo est rendue';
  assert (select count(*) from public.merc_process) = 1, 'même plat, même fiche (clé en minuscules)';
  delete from storage.objects where name = 'saveurs_nomades/essai-a.jpg';
  assert not exists (select 1 from storage.objects where name = 'saveurs_nomades/essai-a.jpg'), 'l''ancienne photo est retirée';
end $$;

-- 2. L'équipe lit, n'écrit pas
set request.jwt.claims = :theo;
do $$ begin
  assert (select count(*) from public.merc_process) = 1, 'un équipier lit les fiches process';
  begin perform public.save_process('saveurs_nomades', 'y', 'Y', '', '', '', ''); raise exception 'TEST: un équipier a écrit une fiche process';
  exception when insufficient_privilege then null; end;
  begin insert into storage.objects (bucket_id, name) values ('dish-photos', 'saveurs_nomades/pirate.jpg'); raise exception 'TEST: un équipier a déposé une photo';
  exception when insufficient_privilege then null; end;
  begin update public.merc_process set steps = 'x' where true; raise exception 'TEST: écriture directe';
  exception when insufficient_privilege then null; end;
end $$;
set role anon;
set request.jwt.claims = '';
do $$ begin
  assert (select count(*) from public.merc_process) = 0, 'un inconnu ne lit pas les fiches process';
  begin perform public.save_process('saveurs_nomades', 'y', 'Y', '', '', '', ''); raise exception 'TEST: un inconnu a écrit une fiche process';
  exception when insufficient_privilege then null; end;
end $$;

-- 3. Suppression par le gérant : la photo est rendue
set role authenticated;
set request.jwt.claims = :boss;
do $$ begin
  assert public.delete_process('saveurs_nomades', 'puree test + poulet test') = 'saveurs_nomades/essai-b.jpg', 'suppression : la photo est rendue';
  delete from storage.objects where name = 'saveurs_nomades/essai-b.jpg';
  assert not exists (select 1 from public.merc_process), 'plus de fiche';
  begin perform public.delete_process('saveurs_nomades', 'puree test + poulet test'); raise exception 'TEST: suppression d''une fiche absente';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
end $$;

reset role;
delete from storage.objects where bucket_id = 'dish-photos';
