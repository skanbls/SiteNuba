-- Tests de la migration 0029 : stocks reliés à la mercuriale Nuba, réceptions de livraison. Produits et prix inventés.
\set ON_ERROR_STOP on
\set boss '''{"sub":"00000000-0000-0000-0000-000000000001"}'''
\set theo '''{"sub":"00000000-0000-0000-0000-000000000002"}'''
reset role;
reset request.headers;
update public.profiles set active = true where email = 'theo@nuba.fr';
delete from public.deliveries where true;
delete from public.merc_products where true;
update public.merc_sync set key_hash = sha256(convert_to('cle_produits', 'UTF8')), created_at = now() where id;
update public.email_settings set enabled = true, sender_email = 'appli@nuba.fr', notify_email = 'boss@nuba.fr', notify_delivery = true where true;
delete from public.email_outbox where kind = 'livraison';
insert into public.suppliers (name) values ('Grossiste Test'), ('Primeur Test');
insert into public.products (name, category, unit, unit_price) values ('Coca 33cl', 'Bar', 'bouteille', 0.4);
create temp table t_liv as select null::uuid as id, null::uuid as ord;
grant select, update on t_liv to anon, authenticated;

do $$ begin
  assert public._prod_key('Coca 33cl') = 'coca 33cl' and public._prod_key('Bière pression (Meteor)') = 'biere pression meteor'
     and public._prod_key('Crème liquide') = 'creme liquide' and public._prod_key('Onglet de Bœuf') = 'onglet de boeuf', 'clés de produit';
end $$;

-- 1. La mercuriale envoie ses produits
set role anon;
set request.jwt.claims = '';
do $$
declare r jsonb;
begin
  assert public.sync_merc_products('mauvaise', '{}') ->> 'error' = 'key', 'clé refusée';
  r := public.sync_merc_products('cle_produits', '{"brand": "produits", "products": [
    {"category": "FRUITS / LEGUMES", "name": "Carottes", "supplier": "Primeur Test", "price": 1.40, "unit": "kg"},
    {"category": "FRUITS / LEGUMES", "name": "Courge butternut", "supplier": "Primeur Test", "price": 1.30, "unit": "kg", "label": "Butternut"},
    {"category": "BOISSONS", "name": "Coca 33cl", "supplier": "Grossiste Test", "price": 0.50, "unit": "pièce", "invoice_date": "23/11/2026"},
    {"category": "CREMERIE", "name": "Crème liquide", "supplier": "Grossiste Test", "price": "3,60 €", "unit": "L"},
    {"category": "FRUITS / LEGUMES", "name": "carottes", "supplier": "Autre", "price": 9, "unit": "kg"}]}');
  assert (r ->> 'ok')::boolean and (r -> 'counts' ->> 'products')::int = 4 and (r -> 'counts' ->> 'linked')::int = 1
     and (r -> 'counts' ->> 'duplicates')::int = 1, 'reçu : ' || r::text;
end $$;
reset role;
do $$ begin
  assert (select price_ht = 3.60 from public.merc_product_prices where key = 'creme liquide'), 'prix lu « 3,60 € »';
  assert (select merc_key = 'coca 33cl' and category = 'BOISSONS' and unit = 'pièce' and unit_price = 0.50
            and supplier_id = (select id from public.suppliers where name = 'Grossiste Test') from public.products where name = 'Coca 33cl'),
    'le produit déjà suivi est relié et suit la mercuriale';
end $$;

-- 2. Qui lit quoi ; l'équipe ajoute un produit de la mercuriale à l'inventaire
set role authenticated;
set request.jwt.claims = :theo;
do $$
declare ids uuid[];
begin
  assert (select count(*) from public.merc_products) = 4, 'l''équipe lit la mercuriale';
  assert (select count(*) from public.merc_product_prices) = 0, 'mais pas ses prix';
  ids := public.stock_add_from_merc(array['carottes']);
  assert (select merc_key = 'carottes' and unit = 'kg' and quantity = 0 and category = 'FRUITS / LEGUMES' from public.products where id = ids[1]), 'carottes suivies';
  assert public.stock_add_from_merc(array['carottes']) = ids, 'pas de doublon';
  begin perform public.stock_add_from_merc(array['inconnu']); raise exception 'TEST: produit hors mercuriale ajouté';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
  begin perform public.link_product_merc(ids[1], ''); raise exception 'TEST: un équipier a délié un produit';
  exception when insufficient_privilege then null; end;
end $$;
set request.jwt.claims = :boss;
do $$ begin
  assert (select count(*) from public.merc_product_prices) = 4, 'le gérant lit les prix';
end $$;

-- 3. Une commande envoyée au grossiste ; Théo réceptionne : la commande est reprise d'elle-même
do $$
declare o uuid;
begin
  o := public.save_order(null, (select id from public.suppliers where name = 'Grossiste Test'), '',
                         jsonb_build_array(jsonb_build_object('product_id', (select id from public.products where name = 'Coca 33cl'), 'quantity', 24)));
  perform public.send_order(o);
  update t_liv set ord = o;
end $$;
set request.jwt.claims = :theo;
do $$
declare r jsonb;
begin
  r := public.delivery_open(null, 'grossiste test', null);
  update t_liv set id = (r ->> 'id')::uuid;
  assert (r ->> 'order_id')::uuid = (select ord from t_liv) and r ->> 'supplier_name' = 'Grossiste Test', 'commande reprise : ' || r::text;
  assert (select count(*) from jsonb_array_elements(r -> 'lines') e where e ->> 'product_name' = 'Coca 33cl' and (e ->> 'ordered')::numeric = 24
          and (e ->> 'quantity')::numeric = 24) = 1, 'ligne attendue, supposée livrée';
  assert public.delivery_open(null, '', (select ord from t_liv)) ->> 'id' = r ->> 'id', 'la réception de la commande se reprend';
  assert public.delivery_add_photo((r ->> 'id')::uuid, 'image/jpeg', 'QUJD') = 1, 'première page';
  begin perform public.delivery_add_photo((r ->> 'id')::uuid, 'application/pdf', 'QUJD'); raise exception 'TEST: un PDF accepté';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
  -- Ici, ni pg_net ni coffre : la lecture n'est pas disponible, tout le reste marche.
  assert public.delivery_scan((r ->> 'id')::uuid) ->> 'status' = 'unavailable', 'lecture indisponible sans clé';
end $$;

-- 4. Ce que Claude aurait lu
reset role;
do $$
declare v_id uuid := (select id from t_liv);
begin
  perform public._delivery_apply_scan(v_id, jsonb_build_object(
    'readable', true, 'supplier', 'GROSSISTE TEST SAS', 'bl_number', 'BL-77', 'bl_date', '2026-11-25', 'total_ht', 50, 'remarks', '',
    'lines', jsonb_build_array(
      jsonb_build_object('label', 'COCA COLA 33CL x24', 'product', 'Coca 33cl', 'quantity', 24, 'unit', 'pièce', 'unit_price', 0.55, 'lot', '', 'use_by', ''),
      jsonb_build_object('label', 'CREME LIQ 1L UHT', 'product', 'Crème liquide', 'quantity', 6, 'unit', 'L', 'unit_price', 3.60, 'lot', 'L123',
                         'use_by', to_char(public.service_day() + 1, 'YYYY-MM-DD')),
      jsonb_build_object('label', 'BUTTERNUT', 'product', '', 'quantity', 2, 'unit', 'kg', 'unit_price', 1.30, 'lot', '', 'use_by', ''),
      jsonb_build_object('label', 'Transport', 'product', '', 'quantity', 1, 'unit', '', 'unit_price', 5, 'lot', '', 'use_by', ''))));
  assert (select scan_status = 'done' and bl_number = 'BL-77' and bl_total_ht = 50 from public.deliveries where deliveries.id = v_id), 'en-tête lu';
  assert (select l.quantity = 24 and l.unit_price = 0.55 and l.source = 'order' from public.delivery_lines l join public.products p on p.id = l.product_id
          where l.delivery_id = v_id and p.name = 'Coca 33cl'), 'la ligne attendue reçoit la quantité lue';
  assert (select merc_key = 'creme liquide' and product_id is null and lot = 'L123' from public.delivery_lines where delivery_id = v_id and label = 'CREME LIQ 1L UHT'), 'crème : produit de la mercuriale';
  assert (select merc_key = 'courge butternut' from public.delivery_lines where delivery_id = v_id and label = 'BUTTERNUT'), 'reconnu par le nom sur l''étiquette';
  assert (select product_id is null and merc_key is null from public.delivery_lines where delivery_id = v_id and label = 'Transport'), 'transport : à relier';
end $$;
-- Une photo illisible
do $$ begin
  insert into public.deliveries (supplier_name) values ('Flou');
  perform public._delivery_apply_scan((select id from public.deliveries where supplier_name = 'Flou'), '{"readable": false, "lines": []}');
  assert (select scan_status = 'error' and scan_error like 'Le bon n''est pas lisible%' from public.deliveries where supplier_name = 'Flou'), 'illisible';
  delete from public.deliveries where supplier_name = 'Flou';
end $$;

-- 5. Théo vérifie, marque le transport « pas en stock » et valide
set role authenticated;
set request.jwt.claims = :theo;
do $$
declare
  v_id uuid := (select id from t_liv);
  r jsonb;
begin
  begin perform public.delivery_validate(v_id, true, 3.5, ''); raise exception 'TEST: une ligne sans produit a été acceptée';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
  perform public.delivery_save(v_id, (select jsonb_agg(case when e ->> 'label' = 'Transport' then e || '{"skip": true}' else e end order by (e ->> 'position')::int)
                                    from jsonb_array_elements(public.delivery_get(v_id) -> 'lines') e), '{}');
  r := public.delivery_validate(v_id, true, 3.5, '');
  assert r ->> 'status' = 'done' and r ->> 'received_by_name' = 'Théo', 'validée : ' || r::text;
  assert (select count(*) from jsonb_array_elements(r -> 'issues') i where i ->> 'kind' = 'price' and i ->> 'product' = 'Coca 33cl' and i ->> 'text' like 'Prix en hausse de 10 %%') = 1, 'hausse de prix : ' || (r -> 'issues')::text;
  assert (select count(*) from jsonb_array_elements(r -> 'issues') i where i ->> 'kind' = 'use_by' and i ->> 'product' = 'Crème liquide') = 1, 'date limite courte';
  assert (select count(*) from jsonb_array_elements(r -> 'issues') i where i ->> 'kind' = 'total') = 1, 'le total du bon ne colle pas';
  begin perform public.delivery_validate(v_id, true, 3.5, ''); raise exception 'TEST: validée deux fois';
  exception when sqlstate 'P0001' then if sqlerrm like 'TEST:%' then raise; end if; end;
end $$;
reset role;
do $$ begin
  assert (select quantity from public.products where name = 'Coca 33cl') = 24, 'stock du coca';
  assert (select quantity = 6 and merc_key = 'creme liquide' and unit = 'L' from public.products where name = 'Crème liquide'), 'crème suivie et en stock';
  assert (select quantity from public.products where merc_key = 'courge butternut') = 2, 'butternut en stock';
  assert not exists (select 1 from public.products where name = 'Transport'), 'le transport ne se suit pas';
  assert (select status = 'received' and reception_temp = 3.5 from public.orders where id = (select ord from t_liv)), 'commande close';
  assert (select received_quantity from public.order_lines where order_id = (select ord from t_liv)) = 24, 'quantité reçue notée';
  assert (select count(*) from public.stock_moves where reason = 'reception' and note = 'Livraison Grossiste Test · BL BL-77') = 3, 'mouvements';
  assert (select count(*) from public.email_outbox where kind = 'livraison' and to_email = 'boss@nuba.fr'
          and subject = 'Livraison Grossiste Test : 3 écart(s)' and body like '%Coca 33cl : Prix en hausse de 10 %%') = 1,
    'le gérant est prévenu : ' || coalesce((select subject || ' / ' || body from public.email_outbox where kind = 'livraison'), 'rien');
end $$;

-- 6. Le gérant relie un produit ; l'état de la lecture
set role authenticated;
set request.jwt.claims = :boss;
do $$ begin
  perform public.link_product_merc((select id from public.products where name = 'Coca 33cl'), '');
  assert (select merc_key is null from public.products where name = 'Coca 33cl'), 'délié';
  perform public.link_product_merc((select id from public.products where name = 'Coca 33cl'), 'coca 33cl');
  assert (public.delivery_scan_status() ->> 'products')::int = 4 and not (public.delivery_scan_status() ->> 'key')::boolean, 'état';
end $$;
set request.jwt.claims = :theo;
do $$ begin
  begin perform public.delivery_scan_status(); raise exception 'TEST: un équipier voit l''état de la clé';
  exception when insufficient_privilege then null; end;
end $$;

-- 7. L'appel à Claude, avec l'imitation de pg_net et du coffre du banc d'essai : la demande envoyée, puis la réponse lue.
reset role;
insert into vault.decrypted_secrets (name, decrypted_secret) values ('anthropic_api_key', 'cle-de-test')
  on conflict (name) do update set decrypted_secret = excluded.decrypted_secret;
set role authenticated;
set request.jwt.claims = :theo;
do $$
declare r jsonb;
begin
  r := public.delivery_open((select id from public.suppliers where name = 'Primeur Test'), '', null);
  update t_liv set id = (r ->> 'id')::uuid;
  perform public.delivery_add_photo((r ->> 'id')::uuid, 'image/jpeg', 'QUJD');
  assert public.delivery_scan((r ->> 'id')::uuid) ->> 'status' = 'pending', 'lecture lancée';
  assert public.delivery_scan_poll((r ->> 'id')::uuid) ->> 'scan_status' = 'pending', 'pas encore de réponse';
end $$;
reset role;
do $$
declare q net.sent;
begin
  select * into q from net.sent order by id desc limit 1;
  assert q.url = 'https://api.anthropic.com/v1/messages', 'adresse';
  assert q.headers ->> 'x-api-key' = 'cle-de-test' and q.headers ->> 'anthropic-version' = '2026-10-21'
     and q.headers ->> 'anthropic-beta' = 'server-side-fallback-2026-07-01', 'en-têtes : ' || q.headers::text;
  assert q.body ->> 'model' = 'claude-opus-5-5' and q.body ->> 'fallbacks' = 'default' and (q.body ->> 'max_tokens')::int = 16000
     and q.body #>> '{output_config,effort}' = 'medium' and q.body #>> '{output_config,format,type}' = 'json_schema', 'corps : ' || (q.body - 'messages')::text;
  assert q.body #>> '{messages,0,content,0,type}' = 'image' and q.body #>> '{messages,0,content,0,source,data}' = 'QUJD', 'la photo';
  assert q.body #>> '{messages,0,content,1,text}' like '%Fournisseur attendu : Primeur Test.%Carottes | kg | Primeur Test%Courge butternut | kg | Primeur Test | aussi appelé : Butternut%',
    'la consigne et la liste : ' || (q.body #>> '{messages,0,content,1,text}');
  insert into net._http_response (id, status_code, content) values (q.id, 200, jsonb_build_object(
    'stop_reason', 'end_turn',
    'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', jsonb_build_object(
      'readable', true, 'supplier', 'Primeur Test', 'bl_number', 'P-12', 'bl_date', '2026-11-25', 'total_ht', 16.2, 'remarks', '',
      'lines', jsonb_build_array(jsonb_build_object('label', 'CAROTTES CAT 1', 'product', 'Carottes', 'quantity', 10, 'unit', 'kg',
                                                    'unit_price', 1.40, 'lot', '', 'use_by', '')))::text)))::text);
end $$;
set role authenticated;
set request.jwt.claims = :theo;
do $$
declare r jsonb := public.delivery_scan_poll((select id from t_liv));
begin
  assert r ->> 'scan_status' = 'done' and r ->> 'bl_number' = 'P-12', 'réponse lue : ' || r::text;
  assert (select count(*) from jsonb_array_elements(r -> 'lines') e where e ->> 'product_name' = 'Carottes' and (e ->> 'quantity')::numeric = 10) = 1, 'carottes reconnues';
  -- Une clé refusée : le message le dit.
  perform public.delivery_scan((select id from t_liv));
end $$;
reset role;
insert into net._http_response (id, status_code, content) select max(id), 401, '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}' from net.sent;
set role authenticated;
set request.jwt.claims = :theo;
do $$ begin
  assert public.delivery_scan_poll((select id from t_liv)) ->> 'scan_error' like 'La clé d''Anthropic est refusée%', 'clé refusée';
end $$;
reset role;
delete from vault.decrypted_secrets where name = 'anthropic_api_key';
delete from net.sent where url = 'https://api.anthropic.com/v1/messages';

-- Remise en état
reset role;
delete from public.deliveries where true;
delete from public.stock_moves where product_id in (select id from public.products where merc_key is not null or name = 'Coca 33cl');
delete from public.orders where id = (select ord from t_liv);
delete from public.products where merc_key is not null or name = 'Coca 33cl';
delete from public.suppliers where name in ('Grossiste Test', 'Primeur Test');
delete from public.merc_products where true;
delete from public.email_outbox where kind = 'livraison';
update public.merc_sync set key_hash = null, created_at = null where id;
update public.email_settings set enabled = false, sender_email = '' where true;
