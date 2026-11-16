-- Tests de la migration 0009 (fiches techniques, pannes, échéances, procédures). Joués en dernier.
\set ON_ERROR_STOP on
\set boss  '''{"sub":"00000000-0000-0000-0000-000000000001"}'''
\set theo  '''{"sub":"00000000-0000-0000-0000-000000000002"}'''
\set intru '''{"sub":"00000000-0000-0000-0000-000000000003"}'''
reset role;
reset request.headers;
do $$ begin assert (select count(*) from public.procedures) = 3, 'les modèles de procédures doivent être en place'; end $$;

-- 1. Fiches techniques : le gérant écrit, l'équipe lit
set role authenticated;
set request.jwt.claims = :boss;
do $$
declare gin uuid := (select id from public.products where name = 'Gin'); r uuid;
begin
  r := public.save_recipe(null, jsonb_build_object('name', '  Gin tonic ', 'category', 'Cocktails', 'portions', 1, 'sale_price', 9, 'vat', 20,
        'method', 'Verre rempli de glace, gin, tonic, zeste.', 'allergens', jsonb_build_array('sulfites')),
      jsonb_build_array(jsonb_build_object('product_id', gin, 'label', 'Gin', 'quantity', 4, 'unit', 'cl', 'pack_size', 70),
                        jsonb_build_object('label', 'Tonic', 'quantity', 12, 'unit', 'cl', 'manual_cost', 0.35),
                        jsonb_build_object('label', 'Ligne vide', 'quantity', 0)));
  assert (select name = 'Gin tonic' and category = 'Cocktails' and vat = 20 and allergens = array['sulfites'] from public.recipes where id = r), 'la fiche est créée';
  assert (select count(*) from public.recipe_items where recipe_id = r) = 2, 'les lignes sans quantité sont ignorées';
  assert (select pack_size = 70 and product_id = gin from public.recipe_items where recipe_id = r and label = 'Gin'), 'un ingrédient garde son produit et son conditionnement';
  perform public.save_recipe(r, jsonb_build_object('name', 'Gin tonic', 'category', 'Cocktails', 'portions', 1, 'sale_price', 10, 'allergens', '[]'::jsonb),
      jsonb_build_array(jsonb_build_object('product_id', gin, 'label', 'Gin', 'quantity', 5, 'unit', 'cl', 'pack_size', 70)));
  assert (select sale_price = 10 and allergens = '{}' from public.recipes where id = r) and (select count(*) from public.recipe_items where recipe_id = r) = 1, 'modifier remplace les ingrédients';
end $$;
set request.jwt.claims = :theo;
do $$ begin
  assert (select count(*) from public.recipes) = 1 and (select count(*) from public.recipe_items) = 1, 'l''équipe lit les fiches';
  begin perform public.save_recipe(null, jsonb_build_object('name', 'Pirate'), '[]'); raise exception 'TEST: un équipier a écrit une fiche';
  exception when insufficient_privilege then null; end;
  delete from public.recipes;
  assert (select count(*) from public.recipes) = 1, 'un équipier ne supprime pas de fiche';
end $$;

-- 2. Pannes : tout le monde signale et suit
do $$
declare me uuid := public.my_profile_id(); i uuid;
begin
  i := public.report_issue('  Frigo bar qui goutte ', 'Bar', 'Flaque sous la porte', true);
  assert (select title = 'Frigo bar qui goutte' and urgent and status = 'open' and reported_by = me from public.issues where id = i), 'la panne est signalée et signée';
  begin perform public.report_issue('  ', '', '', false); raise exception 'TEST: une panne sans titre a été acceptée';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
  perform public.set_issue_status(i, 'doing', 'Dépanneur appelé');
  assert (select status = 'doing' and closed_at is null and resolution = 'Dépanneur appelé' from public.issues where id = i), 'en cours';
  perform public.set_issue_status(i, 'done', '');
  assert (select status = 'done' and closed_by = me and closed_at is not null and resolution = 'Dépanneur appelé' from public.issues where id = i), 'réparée, signée';
  begin perform public.set_issue_status(i, 'oubliée', ''); raise exception 'TEST: un statut inconnu a été accepté';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
  perform public.report_issue('Ampoule grillée', 'Terrasse', '', false);
  assert ((public.today_tasks()) ->> 'issues_open')::int = 1 and ((public.today_tasks()) ->> 'issues_urgent')::int = 0, 'une panne reste ouverte';
end $$;

-- 3. Échéances : réservées au gérant
do $$ begin
  assert (select count(*) from public.deadlines) = 0, 'un équipier ne lit pas les échéances';
  begin insert into public.deadlines (title, due_date) values ('Pirate', current_date); raise exception 'TEST: un équipier a créé une échéance';
  exception when insufficient_privilege then null; end;
  assert (public.today_tasks()) -> 'deadlines_due' = 'null'::jsonb, 'l''accueil d''un équipier ne compte pas les échéances';
end $$;
set request.jwt.claims = :boss;
do $$
declare a uuid; b uuid; theo uuid := (select id from public.profiles where email = 'theo@nuba.fr');
begin
  insert into public.deadlines (title, category, due_date, repeat_months) values ('Extincteurs', 'controle', current_date + 12, 12) returning id into a;
  insert into public.deadlines (title, category, due_date, profile_id) values ('Titre de séjour', 'document', current_date - 2, theo) returning id into b;
  insert into public.deadlines (title, category, due_date) values ('Renouvellement du bail', 'contrat', current_date + 400);
  assert ((public.today_tasks()) ->> 'deadlines_due')::int = 2, 'deux échéances dans les 30 jours ou dépassées';
  perform public.complete_deadline(a, current_date, 'Vérifiés par le prestataire');
  assert (select due_date = (current_date + interval '12 months')::date and active from public.deadlines where id = a), 'une échéance annuelle est reportée d''un an';
  perform public.complete_deadline(b, null, '');
  assert (select not active from public.deadlines where id = b), 'une échéance unique est classée';
  assert (select count(*) from public.deadline_done where done_by is not null) = 2, 'chaque échéance faite est signée';
  assert ((public.today_tasks()) ->> 'deadlines_due')::int = 0, 'plus rien d''urgent';
  begin perform public.complete_deadline(b, null, ''); raise exception 'TEST: une échéance classée a été refaite';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
end $$;

-- 4. Procédures : lecture confirmée, suivie par le gérant
set request.jwt.claims = :theo;
do $$
declare me uuid := public.my_profile_id(); p uuid := (select id from public.procedures order by position limit 1);
begin
  assert ((public.today_tasks()) ->> 'procedures_unread')::int = 3, 'trois procédures à lire';
  perform public.ack_procedure(p);
  perform public.ack_procedure(p);
  assert (select count(*) from public.procedure_reads where profile_id = me) = 1, 'une seule lecture par personne et par procédure';
  assert ((public.today_tasks()) ->> 'procedures_unread')::int = 2, 'il en reste deux';
  begin perform public.save_procedure(null, 'Pirate', '', '', true, false); raise exception 'TEST: un équipier a écrit une procédure';
  exception when insufficient_privilege then null; end;
  begin insert into public.procedure_reads (procedure_id, profile_id) values (p, (select id from public.profiles where email = 'ines@nuba.fr')); raise exception 'TEST: une lecture a été écrite pour un autre';
  exception when insufficient_privilege then null; end;
end $$;
set request.jwt.claims = :boss;
do $$
declare p uuid := (select id from public.procedures order by position limit 1); n uuid;
begin
  assert (select count(*) from public.procedure_reads) = 1, 'le gérant voit les lectures de l''équipe';
  perform public.save_procedure(p, 'Bienvenue à la Nuba', 'Accueil', 'Nouveau texte', true, true);
  assert (select title = 'Bienvenue à la Nuba' and body = 'Nouveau texte' from public.procedures where id = p) and (select count(*) from public.procedure_reads) = 0, 'modifier avec « redemander la lecture » efface les lectures';
  n := public.save_procedure(null, 'Fermeture de la caisse', 'Service', 'Étapes…', false, false);
  assert (select not must_read from public.procedures where id = n), 'une procédure peut être facultative';
  update public.procedures set active = false where id = n;
  assert (select not active from public.procedures where id = n), 'le gérant retire une procédure';
end $$;

-- 5. Un inconnu ne voit rien
set request.jwt.claims = :intru;
do $$ begin
  assert (select count(*) from public.recipes) = 0 and (select count(*) from public.issues) = 0 and (select count(*) from public.procedures) = 0 and (select count(*) from public.deadlines) = 0, 'un inconnu ne lit rien';
  begin perform public.report_issue('X', '', '', false); raise exception 'TEST: un inconnu a signalé une panne';
  exception when insufficient_privilege then null; end;
end $$;

-- 6. Sur l'iPad, par code PIN
set request.jwt.claims = :boss;
create temp table t_pil as select (public.add_kiosk((select id from public.sites limit 1), 'iPad pilotage')) ->> 'code' as v;
grant select, update on t_pil to anon, authenticated;
set role anon;
set request.jwt.claims = '';
do $$
declare
  tok text := (public.claim_kiosk((select v from t_pil))) ->> 'token';
  hugo uuid := (select (e ->> 'id')::uuid from jsonb_array_elements(public.kiosk_team(tok)) e where e ->> 'first_name' = 'Hugo');
begin
  update t_pil set v = (public.kiosk_login(tok, hugo, '8642')) ->> 'ticket';
end $$;
select set_config('request.headers', json_build_object('x-nuba-ticket', (select v from t_pil))::text, false) \gset ignore_
do $$
declare me uuid := public.my_profile_id();
begin
  assert (select count(*) from public.recipes) = 1 and (select count(*) from public.procedures where active) = 3, 'la session à code PIN lit fiches et procédures';
  perform public.report_issue('Tireuse qui mousse', 'Bar', '', false);
  perform public.ack_procedure((select id from public.procedures where active order by position limit 1));
  assert (select count(*) from public.procedure_reads where profile_id = me) = 1, 'la lecture est signée Hugo';
  assert (select count(*) from public.procedure_reads) = 1, 'une session à code PIN ne voit que ses lectures';
  begin perform * from public.deadlines; raise exception 'TEST: une session à code PIN a lu les échéances';
  exception when insufficient_privilege then null; end;
  begin perform public.save_recipe(null, jsonb_build_object('name', 'Pirate'), '[]'); raise exception 'TEST: une session à code PIN a écrit une fiche';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
reset request.headers;
update public.kiosks set revoked_at = now() where revoked_at is null;
