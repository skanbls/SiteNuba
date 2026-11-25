-- =====================================================================
-- Nuba Gestion · migration 0028 · le dossier des salariés (Google Drive), copié dans l'appli
--
-- À exécuter une seule fois dans Supabase, après la 0027 :
--   SQL Editor > New query > coller tout ce fichier > Run.
-- Supabase doit répondre « Success. No rows returned ».
-- Tout passe ou rien ne passe : en cas d'erreur, la base reste comme avant.
--
-- Le script Google (le même que pour les mercuriales) parcourt le dossier Drive des salariés : un dossier
-- par personne, ses sous-dossiers (contrats, pièces d'identité, DPAE, bulletins de paie…) et les dossiers
-- communs. Il copie dans l'espace privé « staff-docs » chaque fichier nouveau ou modifié, et retire ceux
-- qui ont disparu du Drive. L'appli montre la même arborescence ; le gérant et la comptable téléchargent
-- les fichiers sans passer par le Drive. Personne d'autre ne les voit, ni sur l'iPad ni avec un compte.
--
-- Le script n'a pas de compte : pour chaque fichier à déposer ou à retirer, la base lui donne une
-- autorisation à usage précis (ce fichier-là, pendant 30 minutes). Sans elle, rien ne passe.
-- =====================================================================
begin;

do $$ begin
  if to_regprocedure('public.is_accountant()') is null or to_regprocedure('public._profile_by_name(text)') is null
     or to_regprocedure('public.merc_new_key(text, text, text, text, text)') is null then
    raise exception 'Il manque une mise à jour plus ancienne. Exécute d''abord : 0020, 0024 et 0027, puis relance celle-ci (0028).';
  end if;
end $$;

-- ---------- Types de fichiers acceptés -----------------------------------------------------
-- En plus des PDF et des photos : les documents de bureau. Un autre type est rangé « à télécharger » (octet-stream),
-- jamais affiché par le navigateur. 50 Mo par fichier, la limite de Supabase.
create function public._drive_mime(m text) returns text
language sql immutable set search_path = '' as $$
  select case when lower(coalesce(m, '')) = any (array[
      'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif', 'image/tiff',
      'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.spreadsheet',
      'application/rtf', 'text/plain', 'text/csv', 'application/zip'])
    then lower(m) else 'application/octet-stream' end
$$;

update storage.buckets
  set file_size_limit = 52428800,
      allowed_mime_types = array[
        'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif', 'image/tiff',
        'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.spreadsheet',
        'application/rtf', 'text/plain', 'text/csv', 'application/zip', 'application/octet-stream']
  where id = 'staff-docs';

-- ---------- Le dossier et son état ---------------------------------------------------------
create table public.drive_source (
  id         boolean primary key default true check (id),
  folder_url text not null default '' check (length(folder_url) <= 500),
  synced_at  timestamptz,
  counts     jsonb not null default '{}',
  problems   jsonb not null default '[]'
);
insert into public.drive_source default values;

-- Un fichier du Drive. folder : les dossiers depuis la racine, par exemple {"PRÉNOM NOM", "DPAE"}.
-- storage_path : la copie téléchargeable ; pending_path : la nouvelle version en cours de copie.
create table public.drive_files (
  id           text primary key check (id ~ '^[A-Za-z0-9_-]{10,120}$'),
  folder       text[] not null default '{}',
  name         text not null check (length(name) between 1 and 255),
  mime         text not null default 'application/octet-stream',
  size         bigint,
  modified_at  timestamptz not null,
  profile_id   uuid references public.profiles (id) on delete set null,
  storage_path text,
  pending_path text,
  seen_at      timestamptz not null default now()
);
create index drive_files_profile on public.drive_files (profile_id);

-- Autorisations données au script, fichier par fichier.
create table public.drive_tickets (
  name       text primary key,
  kind       text not null check (kind in ('upload', 'delete')),
  expires_at timestamptz not null
);

alter table public.drive_source  enable row level security;
alter table public.drive_files   enable row level security;
alter table public.drive_tickets enable row level security;
revoke all on public.drive_source, public.drive_files, public.drive_tickets from anon, authenticated;
-- Le gérant et la comptable, avec leur compte. Jamais l'équipe, les responsables ni l'iPad.
grant select on public.drive_source, public.drive_files to authenticated;
create policy "dossier salaries: gerant et comptable" on public.drive_source
  for select to authenticated using ((select public.is_gerant()) or (select public.is_accountant()));
create policy "fichiers du dossier salaries: gerant et comptable" on public.drive_files
  for select to authenticated using ((select public.is_gerant()) or (select public.is_accountant()));

-- ---------- Le script dépose et retire, fichier par fichier ------------------------------------
create function public._drive_ticket_ok(p_name text, p_kind text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.drive_tickets t where t.name = p_name and t.kind = p_kind and t.expires_at > now())
$$;

-- Les copies sont rangées sous « drive/ » : l'équipe ne les lit pas (son dossier est « <son id>/ »),
-- le gérant et la comptable les lisent avec la règle « documents: lecture » de la 0020.
create policy "dossier drive: depot du script" on storage.objects
  for insert to anon
  with check (bucket_id = 'staff-docs' and name like 'drive/%' and public._drive_ticket_ok(name, 'upload'));
create policy "dossier drive: controle du script" on storage.objects
  for select to anon
  using (bucket_id = 'staff-docs' and name like 'drive/%'
         and (public._drive_ticket_ok(name, 'upload') or public._drive_ticket_ok(name, 'delete')));
create policy "dossier drive: retrait du script" on storage.objects
  for delete to anon
  using (bucket_id = 'staff-docs' and name like 'drive/%' and public._drive_ticket_ok(name, 'delete'));

-- Chemin d'une version : drive/<id du fichier>/<date de modification en millisecondes>.
create function public._drive_path(p_id text, p_mod timestamptz) returns text
language sql immutable set search_path = '' as $$
  select 'drive/' || p_id || '/' || (extract(epoch from p_mod) * 1000)::bigint
$$;

-- La personne d'un dossier de premier niveau : le lien de sa fiche, sinon son nom (anciens membres compris).
create function public._drive_person(p_folder_id text, p_name text) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  v_id uuid;
  n    int;
begin
  if coalesce(p_folder_id, '') <> '' then
    select f.profile_id into v_id from public.profile_folders f where position(p_folder_id in f.url) > 0 limit 1;
    if v_id is not null then return v_id; end if;
  end if;
  v_id := public._profile_by_name(p_name);
  if v_id is not null then return v_id; end if;
  select min(p.id::text)::uuid, count(*) into v_id, n from public.profiles p
    where public._name_key(p.first_name || ' ' || coalesce(p.last_name, '')) = public._name_key(p_name);
  return case when n = 1 then v_id end;
end $$;

-- Ménage commun aux deux appels : versions déjà déposées, copies orphelines, autorisations à jour, état.
create function public._drive_tidy() returns void
language plpgsql security definer set search_path = '' as $$
begin
  -- Une version déposée dont l'accusé de réception s'est perdu : elle devient la copie.
  update public.drive_files d set storage_path = d.pending_path, pending_path = null
    where d.pending_path is not null
      and exists (select 1 from storage.objects o where o.bucket_id = 'staff-docs' and o.name = d.pending_path);
  -- Toute copie qui ne sert plus (ancienne version, fichier retiré du Drive) est à retirer.
  insert into public.drive_tickets (name, kind, expires_at)
    select o.name, 'delete', now() + interval '30 minutes' from storage.objects o
    where o.bucket_id = 'staff-docs' and o.name like 'drive/%'
      and not exists (select 1 from public.drive_files d where d.storage_path = o.name or d.pending_path = o.name)
    on conflict (name) do update set kind = 'delete', expires_at = excluded.expires_at;
  delete from public.drive_tickets t
    where t.kind = 'delete' and not exists (select 1 from storage.objects o where o.bucket_id = 'staff-docs' and o.name = t.name);
  -- Une autorisation de dépôt pour chaque version attendue, et rien d'autre.
  delete from public.drive_tickets t
    where t.kind = 'upload' and not exists (select 1 from public.drive_files d where d.pending_path = t.name);
  insert into public.drive_tickets (name, kind, expires_at)
    select d.pending_path, 'upload', now() + interval '30 minutes' from public.drive_files d where d.pending_path is not null
    on conflict (name) do update set kind = 'upload', expires_at = excluded.expires_at;
  update public.drive_source set counts = jsonb_build_object(
      'files', (select count(*) from public.drive_files),
      'copied', (select count(*) from public.drive_files where storage_path is not null and pending_path is null),
      'pending', (select count(*) from public.drive_files where pending_path is not null),
      'people', (select count(distinct profile_id) from public.drive_files),
      'folders', (select count(distinct folder[1]) from public.drive_files where cardinality(folder) > 0))
    where id;
end $$;

-- Ce que le script doit faire : il envoie la liste du Drive, la base répond avec les fichiers à déposer
-- (nouveaux ou modifiés) et les copies à retirer.
-- p_payload : { brand: 'documents', tops: [{id, name}], files: [{id, folder: [...], name, mime, size, modified}], problems: [...] }
create function public.drive_plan(p_key text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s        public.merc_sync;
  t        jsonb;
  f        jsonb;
  v_tops   jsonb := '{}';
  v_prof   uuid;
  v_id     text;
  v_name   text;
  v_mod    timestamptz;
  v_folder text[];
  v_old    public.drive_files;
  ids      text[] := '{}';
  n_new    int := 0;
  n_upd    int := 0;
  n_del    int := 0;
begin
  select * into s from public.merc_sync;
  if s.key_hash is null or coalesce(p_key, '') = '' or sha256(convert_to(p_key, 'UTF8')) <> s.key_hash then
    if (select count(*) from public.merc_sync_log where not ok and at > now() - interval '1 hour') < 50 then
      insert into public.merc_sync_log (brand, ok, message) values ('documents', false, 'Clé refusée');
    end if;
    return jsonb_build_object('ok', false, 'error', 'key');
  end if;
  if p_payload ->> 'brand' is distinct from 'documents' or coalesce(jsonb_typeof(p_payload -> 'files'), '') <> 'array'
     or jsonb_array_length(p_payload -> 'files') > 5000 then
    return jsonb_build_object('ok', false, 'error', 'payload');
  end if;
  -- Un dossier vu vide alors que l'appli a des fichiers : sans doute un dossier déplacé ou un accès perdu.
  if jsonb_array_length(p_payload -> 'files') = 0 and (select count(*) from public.drive_files) > 5 then
    insert into public.merc_sync_log (brand, ok, message)
      values ('documents', false, 'Dossier vu vide : rien n''a été retiré. Vérifie le lien du dossier des salariés.');
    return jsonb_build_object('ok', false, 'error', 'empty');
  end if;

  begin
    for t in select value from jsonb_array_elements(coalesce(p_payload -> 'tops', '[]')) loop
      v_prof := public._drive_person(case when (t ->> 'id') ~ '^[A-Za-z0-9_-]{10,120}$' then t ->> 'id' end, left(t ->> 'name', 120));
      if v_prof is not null then v_tops := v_tops || jsonb_build_object(left(btrim(t ->> 'name'), 120), v_prof); end if;
    end loop;

    for f in select value from jsonb_array_elements(p_payload -> 'files') loop
      v_id := f ->> 'id';
      v_name := left(btrim(coalesce(f ->> 'name', '')), 255);
      if v_id is null or v_id !~ '^[A-Za-z0-9_-]{10,120}$' or v_id = any (ids) or v_name = ''
         or coalesce(f ->> 'modified', '') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}' then continue; end if;
      v_mod := (f ->> 'modified')::timestamptz;
      v_folder := array(select left(btrim(x), 120) from jsonb_array_elements_text(coalesce(f -> 'folder', '[]')) x limit 8);
      v_prof := case when cardinality(v_folder) > 0 then (v_tops ->> v_folder[1])::uuid end;
      ids := ids || v_id;
      select * into v_old from public.drive_files where id = v_id;
      if not found then
        insert into public.drive_files (id, folder, name, mime, size, modified_at, profile_id, pending_path)
          values (v_id, v_folder, v_name, public._drive_mime(f ->> 'mime'), case when (f ->> 'size') ~ '^\d{1,12}$' then (f ->> 'size')::bigint end,
                  v_mod, v_prof, public._drive_path(v_id, v_mod));
        n_new := n_new + 1;
      else
        update public.drive_files set
            folder = v_folder, name = v_name, mime = public._drive_mime(f ->> 'mime'),
            size = case when (f ->> 'size') ~ '^\d{1,12}$' then (f ->> 'size')::bigint end,
            profile_id = v_prof, modified_at = v_mod, seen_at = now(),
            pending_path = case when v_old.modified_at is distinct from v_mod or v_old.storage_path is null
                                then public._drive_path(v_id, v_mod) end
          where id = v_id;
        if v_old.modified_at is distinct from v_mod then n_upd := n_upd + 1; end if;
      end if;
    end loop;

    -- Retirés du Drive : retirés de l'appli (leur copie part au ménage).
    delete from public.drive_files where not (id = any (ids));
    get diagnostics n_del = row_count;

    perform public._drive_tidy();
    update public.drive_source set synced_at = now(),
        problems = coalesce((select jsonb_agg(left(x, 200)) from (select x from jsonb_array_elements_text(coalesce(p_payload -> 'problems', '[]')) x limit 30) q), '[]')
      where id;
    delete from public.merc_sync_log where at < now() - interval '30 days';
    insert into public.merc_sync_log (brand, ok, message)
      values ('documents', true, n_new || ' nouveau(x), ' || n_upd || ' modifié(s), ' || n_del || ' retiré(s)');
    return jsonb_build_object('ok', true,
      'counts', jsonb_build_object('new', n_new, 'updated', n_upd, 'removed', n_del),
      'upload', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'path', d.pending_path, 'mime', d.mime) order by d.modified_at desc), '[]'::jsonb)
                 from public.drive_files d where d.pending_path is not null),
      'remove', (select coalesce(jsonb_agg(k.name order by k.name), '[]'::jsonb) from public.drive_tickets k where k.kind = 'delete'));
  exception when others then
    insert into public.merc_sync_log (brand, ok, message) values ('documents', false, left('Envoi refusé par la base : ' || sqlerrm, 300));
    return jsonb_build_object('ok', false, 'error', 'db', 'message', sqlerrm);
  end;
end $$;

-- Le script a déposé ces versions : elles deviennent les copies, et les anciennes sont à retirer.
-- p_done : [{id, path}]
create function public.drive_done(p_key text, p_done jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.merc_sync;
  n int := 0;
begin
  select * into s from public.merc_sync;
  if s.key_hash is null or coalesce(p_key, '') = '' or sha256(convert_to(p_key, 'UTF8')) <> s.key_hash then
    return jsonb_build_object('ok', false, 'error', 'key');
  end if;
  if coalesce(jsonb_typeof(p_done), '') <> 'array' or jsonb_array_length(p_done) > 500 then
    return jsonb_build_object('ok', false, 'error', 'payload');
  end if;
  update public.drive_files d set storage_path = d.pending_path, pending_path = null
    from jsonb_array_elements(p_done) x
    where d.id = x.value ->> 'id' and d.pending_path = x.value ->> 'path'
      and exists (select 1 from storage.objects o where o.bucket_id = 'staff-docs' and o.name = d.pending_path);
  get diagnostics n = row_count;
  perform public._drive_tidy();
  return jsonb_build_object('ok', true, 'copied', n,
    'remove', (select coalesce(jsonb_agg(k.name order by k.name), '[]'::jsonb) from public.drive_tickets k where k.kind = 'delete'));
end $$;

-- ---------- Nouvelle clé, avec le lien du dossier des salariés ---------------------------------
create function public.merc_new_key(p_sn_url text, p_cm_url text, p_nuba_url text, p_dashboard_url text, p_site_url text, p_docs_url text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_key text;
begin
  if not public.is_gerant() then
    raise exception 'Réservé au gérant.' using errcode = '42501';
  end if;
  if coalesce(p_docs_url, '') <> '' and btrim(p_docs_url) !~ '^https://drive\.google\.com/\S+$' then
    raise exception 'Le lien du dossier des salariés doit être un lien Google Drive.' using errcode = 'P0001';
  end if;
  v_key := public.merc_new_key(p_sn_url, p_cm_url, p_nuba_url, p_dashboard_url, p_site_url);
  update public.drive_source set folder_url = left(btrim(coalesce(p_docs_url, '')), 500) where id;
  return v_key;
end $$;

-- ---------- Droits ------------------------------------------------------------------------
revoke all on function public._drive_mime(text), public._drive_ticket_ok(text, text), public._drive_path(text, timestamptz),
  public._drive_person(text, text), public._drive_tidy(), public.drive_plan(text, jsonb), public.drive_done(text, jsonb),
  public.merc_new_key(text, text, text, text, text, text)
  from public, anon, authenticated;
-- Les règles de stockage appellent _drive_ticket_ok avec le rôle du script (anon).
grant execute on function public._drive_ticket_ok(text, text) to anon, authenticated;
-- Le script Google appelle avec la clé publique de l'appli (rôle anon), puis la clé de synchronisation.
grant execute on function public.drive_plan(text, jsonb), public.drive_done(text, jsonb) to anon, authenticated;
grant execute on function public.merc_new_key(text, text, text, text, text, text) to authenticated;

commit;
