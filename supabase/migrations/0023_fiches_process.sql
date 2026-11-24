-- =====================================================================
-- Nuba Gestion · migration 0023 · fiches process de production (Mijote)
--
-- À exécuter une seule fois dans Supabase, après la 0022 :
--   SQL Editor > New query > coller tout ce fichier > Run.
-- Supabase doit répondre « Success. No rows returned ».
-- Tout passe ou rien ne passe : en cas d'erreur, la base reste comme avant.
--
-- Pour chaque plat des mercuriales Saveurs Nomades et Comptoir (une fiche, ou un plat sur mesure
-- « Base + Protéine + Légume »), une fiche process : les étapes de production, le dressage,
-- les points d'hygiène et une photo du dressage attendu.
-- Les quantités restent celles des mercuriales (onglet COMPOSITION) : l'appli les calcule pour la commande.
-- Toute l'équipe lit les fiches process, y compris sur l'iPad avec le code PIN ;
-- le gérant et les responsables qui tiennent les fiches techniques les écrivent.
-- Les photos vont dans un espace de stockage « dish-photos », lisible par lien (ce ne sont que des photos de plats).
-- =====================================================================
begin;

do $$ begin
  if to_regclass('public.merc_recipes') is null or to_regprocedure('public.can(text)') is null then
    raise exception 'Il manque une mise à jour plus ancienne. Exécute d''abord : 0010 (administration) et 0011 (production), puis relance celle-ci (0023).';
  end if;
end $$;

-- ---------- Fiches process ------------------------------------------------------------
-- dish_key : le nom du plat en minuscules, sans accents, espaces simples (calculé par l'appli),
-- pour retrouver la fiche même si la mercuriale change une majuscule.
-- Pas de lien vers merc_recipes : la synchronisation des mercuriales remplace les fiches, pas les process.
create table public.merc_process (
  brand      text not null check (brand in ('saveurs_nomades', 'comptoir')),
  dish_key   text not null check (dish_key = lower(dish_key) and length(dish_key) between 1 and 300),
  name       text not null check (length(btrim(name)) between 1 and 300),
  steps      text not null default '' check (length(steps) <= 8000),
  dressing   text not null default '' check (length(dressing) <= 3000),
  haccp      text not null default '' check (length(haccp) <= 3000),
  photo_path text not null default '' check (length(photo_path) <= 300),
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (brand, dish_key)
);

alter table public.merc_process enable row level security;
revoke all on public.merc_process from anon, authenticated;
grant select on public.merc_process to anon, authenticated;
create policy "fiches process: lecture" on public.merc_process
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
-- Aucune écriture directe : save_process et delete_process.

-- ---------- Photos des plats -------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('dish-photos', 'dish-photos', true, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do nothing;

-- Une photo se range sous le dossier de la mercuriale : « saveurs_nomades/<nom> » ou « comptoir/<nom> ».
create policy "photos des plats: lecture" on storage.objects
  for select to anon, authenticated using (bucket_id = 'dish-photos');
create policy "photos des plats: depot" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'dish-photos' and (select public.can('fiches'))
              and name ~ '^(saveurs_nomades|comptoir)/[A-Za-z0-9._-]+$');
-- Retrait : seulement une photo qu'aucune fiche n'utilise plus (save_process ou delete_process la libère d'abord).
create policy "photos des plats: retrait" on storage.objects
  for delete to authenticated
  using (bucket_id = 'dish-photos' and (select public.can('fiches'))
         and not exists (select 1 from public.merc_process p where p.photo_path = storage.objects.name));

-- ---------- Écrire une fiche process -----------------------------------------------------
-- Crée ou remplace la fiche. Renvoie le chemin de l'ancienne photo quand elle change (l'appli la retire), sinon ''.
create function public.save_process(
  p_brand text, p_key text, p_name text, p_steps text, p_dressing text, p_haccp text, p_photo text
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  me    uuid := public.my_profile_id();
  old   text;
  photo text := btrim(coalesce(p_photo, ''));
begin
  if not public.can('fiches') then
    raise exception 'Réservé au gérant et aux responsables qui tiennent les fiches techniques.' using errcode = '42501';
  end if;
  if p_brand is null or p_brand not in ('saveurs_nomades', 'comptoir') then
    raise exception 'Mercuriale inconnue.' using errcode = 'P0001';
  end if;
  if coalesce(btrim(p_key), '') = '' or coalesce(btrim(p_name), '') = '' then
    raise exception 'Indique le plat.' using errcode = 'P0001';
  end if;
  if photo <> '' and (split_part(photo, '/', 1) <> p_brand
                      or not exists (select 1 from storage.objects o where o.bucket_id = 'dish-photos' and o.name = photo)) then
    raise exception 'La photo n''est pas arrivée : recommence l''envoi.' using errcode = 'P0001';
  end if;
  select photo_path into old from public.merc_process where brand = p_brand and dish_key = lower(btrim(p_key));
  insert into public.merc_process (brand, dish_key, name, steps, dressing, haccp, photo_path, updated_by, updated_at)
    values (p_brand, lower(btrim(p_key)), btrim(p_name), left(btrim(coalesce(p_steps, '')), 8000),
            left(btrim(coalesce(p_dressing, '')), 3000), left(btrim(coalesce(p_haccp, '')), 3000), photo, me, now())
    on conflict (brand, dish_key) do update
      set name = excluded.name, steps = excluded.steps, dressing = excluded.dressing, haccp = excluded.haccp,
          photo_path = excluded.photo_path, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  return case when coalesce(old, '') <> '' and old <> photo then old else '' end;
end $$;

-- Supprime une fiche process. Renvoie le chemin de sa photo (l'appli la retire), ou ''.
create function public.delete_process(p_brand text, p_key text) returns text
language plpgsql security definer set search_path = '' as $$
declare path text;
begin
  if not public.can('fiches') then
    raise exception 'Réservé au gérant et aux responsables qui tiennent les fiches techniques.' using errcode = '42501';
  end if;
  delete from public.merc_process where brand = p_brand and dish_key = lower(btrim(p_key)) returning photo_path into path;
  if not found then raise exception 'Fiche process introuvable.' using errcode = 'P0001'; end if;
  return coalesce(path, '');
end $$;

revoke all on function public.save_process(text, text, text, text, text, text, text), public.delete_process(text, text)
  from public, anon, authenticated;
grant execute on function public.save_process(text, text, text, text, text, text, text), public.delete_process(text, text)
  to authenticated;

commit;
