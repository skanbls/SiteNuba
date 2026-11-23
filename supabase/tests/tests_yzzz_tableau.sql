-- Tests de la migration 0019 (tableau de bord financier, gérants seulement). Données inventées.
\set ON_ERROR_STOP on
\set boss   '''{"sub":"00000000-0000-0000-0000-000000000001"}'''
\set theo   '''{"sub":"00000000-0000-0000-0000-000000000002"}'''
\set ines   '''{"sub":"00000000-0000-0000-0000-000000000005"}'''
\set compta '''{"sub":"00000000-0000-0000-0000-000000000013"}'''
reset role;
reset request.headers;
delete from public.merc_sync_log;
insert into auth.users (id, email, email_confirmed_at) values ('00000000-0000-0000-0000-000000000013', 'tdb@compta.fr', now());
insert into public.accountants (email, name) values ('tdb@compta.fr', 'Cabinet');
create temp table t_tdb (k text, payload jsonb);
grant select, update, insert on t_tdb to anon, authenticated;
insert into t_tdb (payload) values ($json${
  "brand": "tableau", "file": "TABLEAU TEST",
  "tabs": {
    "Tableau de bord": {"d": [["Tableau test"], [], ["Trésorerie"], ["Solde bancaire retenu", "10 000 €", "01/12/2026"]],
                        "v": [["Tableau test"], [], ["Trésorerie"], ["Solde bancaire retenu", 10000, "2026-12-01"]]},
    "Tréso 13 semaines": {"d": [["Solde fin de semaine", "", "9 000 €"]], "v": [["Solde fin de semaine", "", 9000]]}
  }
}$json$::jsonb);

-- 1. Sans clé, rien ne passe ; une responsable ne crée pas de clé
set role anon;
set request.jwt.claims = '';
do $$ begin
  assert (public.sync_dashboard('', (select payload from t_tdb))) ->> 'error' = 'key', 'sans clé, refusé';
  assert (public.sync_dashboard('nuba_au_hasard', (select payload from t_tdb))) ->> 'error' = 'key', 'clé inventée refusée';
  begin perform count(*) from public.dashboard_source; raise exception 'TEST: le public a lu le tableau';
  exception when insufficient_privilege then null; end;
end $$;
set role authenticated;
set request.jwt.claims = :ines;
do $$ begin
  begin perform public.merc_new_key('', '', '', ''); raise exception 'TEST: une responsable a créé une clé';
  exception when insufficient_privilege then null; end;
end $$;

-- 2. Le gérant crée la clé avec le lien du tableau ; le script envoie
set request.jwt.claims = :boss;
do $$ begin
  begin perform public.merc_new_key('', '', '', 'https://exemple.fr/feuille'); raise exception 'TEST: un lien qui n''est pas une feuille Google a été accepté';
  exception when check_violation then null; end;
end $$;
update t_tdb set k = public.merc_new_key('', '', '', 'https://docs.google.com/spreadsheets/d/Tableau_Invente-456/edit');
do $$ begin
  assert (select sheet_url from public.dashboard_source) like '%Tableau_Invente-456%', 'lien du tableau rangé à part';
  assert not exists (select 1 from public.merc_sources where sheet_url like '%Tableau_Invente%'), 'pas avec les mercuriales, que l''équipe lit';
end $$;
set role anon;
set request.jwt.claims = '';
do $$
declare r jsonb;
begin
  assert (public.sync_dashboard((select k from t_tdb), jsonb_build_object('brand', 'nuba', 'tabs', '{}'::jsonb))) ->> 'error' = 'brand', 'mauvaise marque';
  assert (public.sync_dashboard((select k from t_tdb), '{"brand": "tableau", "tabs": []}')) ->> 'error' = 'payload', 'onglets illisibles';
  assert (public.sync_dashboard((select k from t_tdb), '{"brand": "tableau", "tabs": {}}')) ->> 'error' = 'payload', 'aucun onglet';
  assert (public.sync_dashboard((select k from t_tdb), '{"brand": "tableau", "tabs": {"X": {"d": "texte", "v": []}}}')) ->> 'error' = 'payload', 'grille illisible';
  r := public.sync_dashboard((select k from t_tdb), (select payload from t_tdb));
  assert (r ->> 'ok')::boolean and r -> 'counts' ->> 'tabs' = '2', 'envoi accepté : ' || r::text;
  begin perform count(*) from public.dashboard_source; raise exception 'TEST: le script a lu le tableau';
  exception when insufficient_privilege then null; end;
end $$;

-- 3. Le gérant lit ; personne d'autre
set role authenticated;
set request.jwt.claims = :boss;
do $$ begin
  assert (select tabs -> 'Tableau de bord' -> 'd' -> 3 ->> 1 from public.dashboard_source) = '10 000 €', 'le gérant lit le tableau';
  assert (select file_name = 'TABLEAU TEST' and synced_at is not null from public.dashboard_source), 'date et nom du fichier';
  begin update public.dashboard_source set tabs = '{}' where id; raise exception 'TEST: le tableau a été modifié hors du script';
  exception when insufficient_privilege then null; end;
end $$;
set request.jwt.claims = :theo;
do $$ begin
  assert (select count(*) from public.dashboard_source) = 0, 'un équipier ne lit pas le tableau';
end $$;
set request.jwt.claims = :boss;
do $$ begin
  perform public.set_rights((select id from public.profiles where email = 'ines@nuba.fr'), array['fiches', 'stocks', 'pointages']);
end $$;
set request.jwt.claims = :ines;
do $$ begin
  assert (select count(*) from public.dashboard_source) = 0, 'une responsable ne le lit pas, même avec des accès';
end $$;
set request.jwt.claims = :compta;
do $$ begin
  assert public.accountant_me() is not null and (select count(*) from public.dashboard_source) = 0, 'la comptable ne le lit pas';
end $$;

-- 4. Code PIN (iPad), même pour le gérant : rien
set request.jwt.claims = :boss;
insert into t_tdb (k) values ((public.add_kiosk((select id from public.sites limit 1), 'iPad tableau')) ->> 'code');
set role anon;
set request.jwt.claims = '';
do $$
declare
  tok text := (public.claim_kiosk((select k from t_tdb where payload is null))) ->> 'token';
  ines uuid := (select (e ->> 'id')::uuid from jsonb_array_elements(public.kiosk_team(tok)) e where e ->> 'first_name' = 'Inès');
begin
  update t_tdb set k = (public.kiosk_login(tok, ines, '7391')) ->> 'ticket' where payload is null;
end $$;
select set_config('request.headers', json_build_object('x-nuba-ticket', (select k from t_tdb where payload is null))::text, false) \gset ignore_
do $$ begin
  assert public.my_profile_id() is not null, 'session à code PIN ouverte';
  begin perform count(*) from public.dashboard_source; raise exception 'TEST: une session à code PIN a lu le tableau';
  exception when insufficient_privilege then null; end;
end $$;
reset request.headers;

-- 5. Journal et remplacement
reset role;
do $$ begin
  assert exists (select 1 from public.merc_sync_log where brand = 'tableau' and ok and message = '2 onglets reçus'), 'journal';
  assert exists (select 1 from public.merc_sync_log where brand = 'tableau' and not ok and message = 'Clé refusée'), 'clé refusée notée';
end $$;

-- Remise en état
reset role;
update public.dashboard_source set tabs = '{}', synced_at = null, sheet_url = '', file_name = '' where id;
delete from public.merc_sync_log;
delete from public.accountants;
update public.kiosks set revoked_at = now() where revoked_at is null;
