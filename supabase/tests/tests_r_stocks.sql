-- Tests de la migration 0006 (stocks, fournisseurs, commandes). Joués en dernier, sur la même base.
\set ON_ERROR_STOP on
\set boss  '''{"sub":"00000000-0000-0000-0000-000000000001"}'''
\set theo  '''{"sub":"00000000-0000-0000-0000-000000000002"}'''
\set intru '''{"sub":"00000000-0000-0000-0000-000000000003"}'''
reset role;
reset request.headers;

-- 1. Le gérant tient le catalogue ; la quantité ne s'écrit pas directement
set role authenticated;
set request.jwt.claims = :boss;
insert into public.suppliers (name, delivery_days) values ('Cave et spiritueux', 'Mardi et vendredi'), ('Primeur', 'Tous les jours');
insert into public.products (name, category, unit, threshold, target, unit_price, supplier_id) values
  ('Gin', 'Bar', 'bouteille 70 cl', 3, 8, 21, (select id from public.suppliers where name = 'Cave et spiritueux')),
  ('Vin blanc', 'Cave', 'bouteille', 12, null, 6.5, (select id from public.suppliers where name = 'Cave et spiritueux')),
  ('Citrons verts', 'Bar', 'kg', 2, 5, 4, (select id from public.suppliers where name = 'Primeur')),
  ('Ancien produit', 'Bar', '', 0, null, 0, null);
update public.products set active = false where name = 'Ancien produit';
do $$ begin
  begin
    insert into public.products (name, quantity) values ('Triche', 50);
    raise exception 'TEST: une quantité a pu être écrite à la création';
  exception when insufficient_privilege then null; end;
  begin
    update public.products set quantity = 99 where name = 'Gin';
    raise exception 'TEST: une quantité a pu être écrite sans mouvement de stock';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.stock_moves (product_id, delta, quantity_after, reason) values ((select id from public.products where name = 'Gin'), 5, 5, 'ajustement');
    raise exception 'TEST: un mouvement a pu être écrit à la main';
  exception when insufficient_privilege then null; end;
end $$;

-- 2. L'équipe ajuste et compte ; chaque changement laisse un mouvement signé
set request.jwt.claims = :theo;
do $$
declare
  gin uuid := (select id from public.products where name = 'Gin');
  vin uuid := (select id from public.products where name = 'Vin blanc');
  me uuid := public.my_profile_id();
  n int;
begin
  assert (select count(*) from public.products) = 4 and (select count(*) from public.suppliers) = 2, 'un équipier lit le catalogue';
  begin
    insert into public.products (name) values ('Pirate');
    raise exception 'TEST: un équipier a pu créer un produit';
  exception when insufficient_privilege then null; end;
  update public.products set threshold = 0 where id = gin;
  assert (select threshold from public.products where id = gin) = 3, 'un équipier ne modifie pas un produit';

  assert public.adjust_stock(gin, 3) = 3, 'ajouter 3';
  assert public.adjust_stock(gin, -5) = 0, 'le stock ne descend pas sous zéro';
  assert (select array_agg(delta order by id) from public.stock_moves where product_id = gin) = array[3, -3]::numeric[], 'les mouvements notent ce qui a vraiment changé';
  assert (select bool_and(done_by = me and reason = 'ajustement') from public.stock_moves), 'les mouvements sont signés';
  assert public.adjust_stock(gin, -1) = 0 and (select count(*) from public.stock_moves where product_id = gin) = 2, 'retirer d''un stock vide ne crée pas de mouvement';
  begin perform public.adjust_stock(gin, 0); raise exception 'TEST: un ajustement nul a été accepté';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
  begin perform public.adjust_stock((select id from public.products where name = 'Ancien produit'), 1); raise exception 'TEST: un produit retiré a été ajusté';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;

  n := public.count_stock(jsonb_build_array(
    jsonb_build_object('id', gin, 'quantity', 2), jsonb_build_object('id', vin, 'quantity', 0),
    jsonb_build_object('id', gen_random_uuid(), 'quantity', 4), jsonb_build_object('id', vin, 'quantity', -3)));
  assert n = 1, 'seul le produit dont la quantité change compte : ' || n;
  assert (select quantity from public.products where id = gin) = 2, 'l''inventaire fixe la quantité';
  assert (select reason from public.stock_moves order by id desc limit 1) = 'inventaire', 'le mouvement est un inventaire';
  assert ((public.today_tasks()) ->> 'low_stock')::int = 3, 'gin, vin blanc et citrons sont sous leur seuil';
end $$;

-- 3. Commandes : brouillon, envoi, réception partielle avec contrôle
do $$
declare
  cave uuid := (select id from public.suppliers where name = 'Cave et spiritueux');
  gin uuid := (select id from public.products where name = 'Gin');
  vin uuid := (select id from public.products where name = 'Vin blanc');
  me uuid := public.my_profile_id();
  o uuid; l_gin uuid; l_vin uuid;
begin
  o := public.save_order(null, cave, '  Livrer avant 16 h ', jsonb_build_array(
    jsonb_build_object('product_id', gin, 'quantity', 6), jsonb_build_object('product_id', vin, 'quantity', 0),
    jsonb_build_object('product_id', (select id from public.products where name = 'Ancien produit'), 'quantity', 2)));
  assert (select status = 'draft' and note = 'Livrer avant 16 h' and created_by = me from public.orders where id = o), 'le brouillon est créé et signé';
  assert (select count(*) from public.order_lines where order_id = o) = 1, 'quantités nulles et produits retirés sont ignorés';
  assert (select unit_price from public.order_lines where order_id = o) = 21, 'le prix du jour est mémorisé';
  perform public.save_order(o, cave, '', jsonb_build_array(jsonb_build_object('product_id', gin, 'quantity', 6), jsonb_build_object('product_id', vin, 'quantity', 24)));
  assert (select count(*) from public.order_lines where order_id = o) = 2, 'modifier le brouillon remplace ses lignes';
  begin perform public.save_order(null, gen_random_uuid(), '', '[]'); raise exception 'TEST: une commande sans fournisseur a été créée';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
  begin perform public.receive_order(o, '[]', true, null, ''); raise exception 'TEST: un brouillon a été réceptionné';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;

  perform public.send_order(o);
  assert (select status = 'sent' and sent_by = me and sent_at is not null from public.orders where id = o), 'l''envoi est signé et daté';
  assert ((public.today_tasks()) ->> 'deliveries')::int = 1, 'une livraison est attendue';
  begin perform public.save_order(o, cave, '', '[]'); raise exception 'TEST: une commande envoyée a été modifiée';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
  begin perform public.delete_order(o); raise exception 'TEST: une commande envoyée a été supprimée';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
  begin perform public.cancel_order(o); raise exception 'TEST: un équipier a annulé une commande';
  exception when insufficient_privilege then null; end;

  select id into l_gin from public.order_lines where order_id = o and product_id = gin;
  select id into l_vin from public.order_lines where order_id = o and product_id = vin;
  begin perform public.receive_order(o, '[]', false, null, '  '); raise exception 'TEST: un problème de réception sans explication a été accepté';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
  perform public.receive_order(o, jsonb_build_array(jsonb_build_object('line_id', l_vin, 'received', 18)), false, 6.5, '6 bouteilles manquantes');
  assert (select quantity from public.products where id = gin) = 8, 'une ligne non précisée est reçue en entier : 2 + 6';
  assert (select quantity from public.products where id = vin) = 18, 'une ligne précisée prend la quantité reçue';
  assert (select received_quantity from public.order_lines where id = l_vin) = 18, 'la quantité reçue est gardée';
  assert (select status = 'received' and received_by = me and not reception_ok and reception_temp = 6.5 and reception_note = '6 bouteilles manquantes' from public.orders where id = o), 'le contrôle à réception est enregistré';
  assert (select count(*) from public.stock_moves where reason = 'reception' and note = 'Livraison Cave et spiritueux') = 2, 'la réception écrit ses mouvements';
  begin perform public.receive_order(o, '[]', true, null, ''); raise exception 'TEST: une commande a été réceptionnée deux fois';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;

  begin perform public.send_order(public.save_order(null, cave, '', '[]')); raise exception 'TEST: une commande vide a été envoyée';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
end $$;
do $$
declare o uuid := (select id from public.orders where status = 'draft' limit 1);
begin
  assert o is null, 'le brouillon vide créé dans le test précédent a été annulé avec lui';
end $$;

-- 4. Annulation par le gérant, brouillon supprimé par l'équipe
do $$
declare
  prim uuid := (select id from public.suppliers where name = 'Primeur');
  citron uuid := (select id from public.products where name = 'Citrons verts');
  d uuid;
begin
  d := public.save_order(null, prim, '', jsonb_build_array(jsonb_build_object('product_id', citron, 'quantity', 3)));
  perform public.delete_order(d);
  assert not exists (select 1 from public.orders where id = d), 'un brouillon se supprime';
  d := public.save_order(null, prim, '', jsonb_build_array(jsonb_build_object('product_id', citron, 'quantity', 3)));
  perform public.send_order(d);
end $$;
set request.jwt.claims = :boss;
do $$
declare o uuid := (select id from public.orders where status = 'sent');
begin
  perform public.cancel_order(o);
  assert (select status from public.orders where id = o) = 'cancelled', 'le gérant annule une commande envoyée';
  begin perform public.cancel_order((select id from public.orders where status = 'received')); raise exception 'TEST: une commande reçue a été annulée';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
  assert (select quantity from public.products where name = 'Citrons verts') = 0, 'une commande annulée ne touche pas au stock';
end $$;

-- 5. Un inconnu ne voit rien et ne peut rien
set request.jwt.claims = :intru;
do $$ begin
  assert (select count(*) from public.products) = 0 and (select count(*) from public.suppliers) = 0
     and (select count(*) from public.orders) = 0 and (select count(*) from public.stock_moves) = 0, 'un inconnu ne lit rien';
  begin perform public.adjust_stock(gen_random_uuid(), 1); raise exception 'TEST: un inconnu a ajusté un stock';
  exception when insufficient_privilege then null; end;
  begin perform public.save_order(null, gen_random_uuid(), '', '[]'); raise exception 'TEST: un inconnu a créé une commande';
  exception when insufficient_privilege then null; end;
end $$;

-- 6. Sur l'iPad, par code PIN : stock et commandes, sans le catalogue
set request.jwt.claims = :boss;
create temp table t_stk as select public.add_kiosk((select id from public.sites limit 1), 'iPad réserve') as k, null::text as ticket;
grant select, update on t_stk to anon, authenticated;
set role anon;
set request.jwt.claims = '';
do $$
declare
  tok text := (public.claim_kiosk((select k ->> 'code' from t_stk))) ->> 'token';
  hugo uuid := (select (e ->> 'id')::uuid from jsonb_array_elements(public.kiosk_team(tok)) e where e ->> 'first_name' = 'Hugo');
begin
  update t_stk set ticket = (public.kiosk_login(tok, hugo, '8642')) ->> 'ticket';
  assert (select count(*) from public.products) = 0, 'sans ticket, pas de catalogue';
end $$;
select set_config('request.headers', json_build_object('x-nuba-ticket', (select ticket from t_stk))::text, false) \gset ignore_
do $$
declare
  me uuid := public.my_profile_id();
  prim uuid := (select id from public.suppliers where name = 'Primeur');
  citron uuid := (select id from public.products where name = 'Citrons verts');
  o uuid;
begin
  assert (select count(*) from public.products) = 4, 'la session à code PIN lit le catalogue';
  assert public.adjust_stock(citron, 1) = 1, 'la session à code PIN ajuste le stock';
  o := public.save_order(null, prim, '', jsonb_build_array(jsonb_build_object('product_id', citron, 'quantity', 4)));
  perform public.send_order(o);
  perform public.receive_order(o, '[]', true, 4.5, '');
  assert (select quantity from public.products where id = citron) = 5, 'la session à code PIN réceptionne : 1 + 4';
  assert (select received_by = me and reception_ok from public.orders where id = o), 'la réception est signée Hugo';
  begin insert into public.products (name) values ('Pirate'); raise exception 'TEST: une session à code PIN a créé un produit';
  exception when insufficient_privilege then null; end;
  begin insert into public.suppliers (name) values ('Pirate'); raise exception 'TEST: une session à code PIN a créé un fournisseur';
  exception when insufficient_privilege then null; end;
  begin perform public.cancel_order(o); raise exception 'TEST: une session à code PIN a annulé une commande';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
reset request.headers;
update public.kiosks set revoked_at = now() where revoked_at is null;
