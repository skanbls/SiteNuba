-- =====================================================================
-- Nuba Gestion · migration 0019 · tableau de bord financier (gérants seulement)
--
-- À exécuter une seule fois dans Supabase, après la 0018 :
--   SQL Editor > New query > coller tout ce fichier > Run.
-- Supabase doit répondre « Success. No rows returned ».
--
-- Le fichier Google Sheets « Tableau de bord financier » du gérant reste la référence.
-- Le script Google des mercuriales l'envoie aussi (même clé) : onglets Tableau de bord,
-- Tréso 13 semaines, Prévisionnel 12 mois et Historique KPI, tels qu'ils s'affichent.
-- Seuls les gérants le lisent : ni les responsables, ni l'équipe, ni l'iPad (code PIN),
-- ni la comptable. Le lien du fichier est rangé ici aussi, jamais avec les mercuriales,
-- que toute l'équipe peut lire.
-- =====================================================================
begin;

create table public.dashboard_source (
  id        boolean primary key default true check (id),
  sheet_url text not null default '' check (sheet_url = '' or sheet_url ~ '^https://docs\.google\.com/spreadsheets/d/[A-Za-z0-9_-]+'),
  file_name text not null default '',
  synced_at timestamptz,
  tabs      jsonb not null default '{}'   -- {"Tableau de bord": {"d": [[…]], "v": [[…]]}, …}
);
insert into public.dashboard_source default values;

-- ---------- Réception du tableau de bord -------------------------------------------
-- Appelée par le script Google, avec la clé des mercuriales. Remplace tout le tableau.
-- Chaque onglet arrive en deux grilles : « d », le texte affiché ; « v », les valeurs brutes.
create function public.sync_dashboard(p_key text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s    public.merc_sync;
  t    jsonb := p_payload -> 'tabs';
  n    int;
  tab  record;
begin
  select * into s from public.merc_sync;
  if s.key_hash is null or coalesce(p_key, '') = '' or sha256(convert_to(p_key, 'UTF8')) <> s.key_hash then
    if (select count(*) from public.merc_sync_log where not ok and at > now() - interval '1 hour') < 50 then
      insert into public.merc_sync_log (brand, ok, message) values ('tableau', false, 'Clé refusée');
    end if;
    return jsonb_build_object('ok', false, 'error', 'key');
  end if;
  if (select count(*) from public.merc_sync_log where ok and at > now() - interval '10 minutes') >= 30 then
    return jsonb_build_object('ok', false, 'error', 'too_many');
  end if;
  if p_payload ->> 'brand' is distinct from 'tableau' then
    return jsonb_build_object('ok', false, 'error', 'brand');
  end if;
  if coalesce(jsonb_typeof(t), '') <> 'object' or octet_length(t::text) > 900000 then
    return jsonb_build_object('ok', false, 'error', 'payload');
  end if;
  for tab in select key, value from jsonb_each(t) loop
    if coalesce(jsonb_typeof(tab.value -> 'd'), '') <> 'array' or coalesce(jsonb_typeof(tab.value -> 'v'), '') <> 'array'
       or jsonb_array_length(tab.value -> 'd') > 400 or length(tab.key) > 60 then
      return jsonb_build_object('ok', false, 'error', 'payload');
    end if;
  end loop;
  select count(*) into n from jsonb_object_keys(t);
  if n = 0 or n > 10 then
    return jsonb_build_object('ok', false, 'error', 'payload');
  end if;

  update public.dashboard_source
    set tabs = t, synced_at = now(), file_name = public._mtext(p_payload -> 'file', 120)
    where id;
  delete from public.merc_sync_log where at < now() - interval '30 days';
  insert into public.merc_sync_log (brand, ok, message) values ('tableau', true, n || ' onglets reçus');
  return jsonb_build_object('ok', true, 'counts', jsonb_build_object('tabs', n));
end $$;

-- ---------- Nouvelle clé, avec le lien du tableau de bord ----------------------------
create function public.merc_new_key(p_sn_url text, p_cm_url text, p_nuba_url text, p_dashboard_url text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_key text := 'nuba_' || replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  if not public.is_gerant() then
    raise exception 'Réservé au gérant.' using errcode = '42501';
  end if;
  update public.merc_sources set sheet_url = btrim(coalesce(p_sn_url, '')) where brand = 'saveurs_nomades';
  update public.merc_sources set sheet_url = btrim(coalesce(p_cm_url, '')) where brand = 'comptoir';
  update public.merc_sources set sheet_url = btrim(coalesce(p_nuba_url, '')) where brand = 'nuba';
  update public.dashboard_source set sheet_url = btrim(coalesce(p_dashboard_url, '')) where id;
  update public.merc_sync set key_hash = sha256(convert_to(v_key, 'UTF8')), created_at = now() where id;
  return v_key;
end $$;

-- ---------- Sécurité : les gérants seulement ----------------------------------------
alter table public.dashboard_source enable row level security;
revoke all on public.dashboard_source from anon, authenticated;
grant select on public.dashboard_source to authenticated;
create policy "tableau de bord: les gerants" on public.dashboard_source
  for select to authenticated using ((select public.is_gerant()));

revoke all on function public.sync_dashboard(text, jsonb), public.merc_new_key(text, text, text, text) from public, anon, authenticated;
-- Le script Google appelle avec la clé publique de l'appli (rôle anon), puis la clé de synchronisation.
grant execute on function public.sync_dashboard(text, jsonb) to anon, authenticated;
grant execute on function public.merc_new_key(text, text, text, text) to authenticated;

commit;
