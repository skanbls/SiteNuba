-- =====================================================================
-- Nuba Gestion · migration 0021 · bulletins de paie
--
-- À exécuter une seule fois dans Supabase, après la 0020 :
--   SQL Editor > New query > coller tout ce fichier > Run.
-- Supabase doit répondre « Success. No rows returned ».
-- Tout passe ou rien ne passe : en cas d'erreur, la base reste comme avant.
--
-- La comptable (et le gérant) déposent le bulletin de paie de chaque salarié, mois par mois.
-- Chaque salarié retrouve les siens dans Mon compte et reçoit un e-mail quand un bulletin arrive.
-- Les responsables et les collègues ne les voient jamais.
-- La comptable ne dépose que des bulletins de paie, et ne retire que ceux qu'elle a déposés.
-- =====================================================================
begin;

do $$ begin
  if to_regclass('public.staff_documents') is null or to_regprocedure('public.is_accountant()') is null then
    raise exception 'Il manque une mise à jour plus ancienne. Exécute d''abord : 0020 (absences et documents), puis relance celle-ci (0021).';
  end if;
end $$;

-- ---------- Le bulletin de paie, une catégorie de document ---------------------------
alter table public.staff_documents drop constraint staff_documents_category_check;
alter table public.staff_documents add constraint staff_documents_category_check check (category in (
  'arret', 'accident', 'justificatif', 'identite', 'sejour', 'vitale', 'rib', 'mutuelle',
  'medecine', 'diplome', 'dpae', 'contrat', 'paie', 'autre'));
-- Qui l'a déposé, quand c'est la comptable (elle n'a pas de fiche dans l'équipe).
alter table public.staff_documents add column accountant_id uuid references public.accountants (id) on delete set null;
create index staff_documents_payslips on public.staff_documents (profile_id, start_date desc) where category = 'paie';

alter table public.email_settings add column notify_payslips boolean not null default true;

-- ---------- Stockage : la comptable dépose et retire les bulletins --------------------
-- Un bulletin se range sous le dossier du salarié, avec un nom qui commence par « paie- ».
drop policy "documents: depot" on storage.objects;
create policy "documents: depot" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'staff-docs'
              and ((storage.foldername(name))[1] = (select public.my_profile_id())::text
                   or (select public.is_gerant())
                   or ((select public.is_accountant()) and name ~ '^[0-9a-f-]{36}/paie-[^/]+$')));
-- Elle retire seulement un fichier de bulletin qui n'est plus enregistré : delete_payslip retire d'abord
-- la fiche (et vérifie que c'est elle qui l'a déposée) ; un bulletin déposé par le gérant reste protégé.
create policy "documents: retrait des bulletins par la comptable" on storage.objects
  for delete to authenticated
  using (bucket_id = 'staff-docs' and (select public.is_accountant()) and name ~ '^[0-9a-f-]{36}/paie-[^/]+$'
         and not exists (select 1 from public.staff_documents d where d.file_path = name));

create function public._fr_month(d date) returns text
language sql immutable set search_path = '' as $$
  select (array['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août',
                'septembre', 'octobre', 'novembre', 'décembre'])[extract(month from d)::int] || ' ' || extract(year from d)::int
$$;

-- ---------- Enregistrer un document (bulletins de paie compris) -----------------------
-- Même rôle que dans la 0020, avec en plus :
--   * un bulletin de paie : déposé par le gérant ou la comptable, rangé au mois (du 1er au dernier jour),
--     et le salarié reçoit un e-mail (sans pièce jointe) ;
--   * la comptable ne dépose que des bulletins.
create or replace function public.add_staff_document(
  p_profile uuid, p_category text, p_title text, p_path text, p_file_name text, p_mime text, p_size int,
  p_start date, p_end date, p_note text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me    uuid := public.my_profile_id();
  acc   uuid := public._accountant_id();
  v_id  uuid;
  v_s   date := p_start;
  v_e   date := coalesce(p_end, p_start);
  p     public.profiles;
  m     public.email_settings;
  a     record;
  what  text;
begin
  if me is null and acc is null then
    raise exception 'Connecte-toi avec ton compte pour envoyer un document.' using errcode = '42501';
  end if;
  if p_category = 'paie' then
    if acc is null and not public.is_gerant() then
      raise exception 'Seuls le gérant et la comptable déposent les bulletins de paie.' using errcode = '42501';
    end if;
    if p_start is null then
      raise exception 'Indique le mois du bulletin.' using errcode = 'P0001';
    end if;
    v_s := date_trunc('month', p_start)::date;
    v_e := (v_s + interval '1 month' - interval '1 day')::date;
  elsif me is null then
    raise exception 'La comptable dépose seulement les bulletins de paie.' using errcode = '42501';
  elsif p_profile is distinct from me and not public.is_gerant() then
    raise exception 'Tu ne peux envoyer que tes propres documents.' using errcode = '42501';
  end if;
  select * into p from public.profiles where id = p_profile;
  if not found then raise exception 'Personne introuvable.' using errcode = 'P0001'; end if;
  if coalesce(p_path, '') = '' or split_part(p_path, '/', 1) <> p_profile::text
     or not exists (select 1 from storage.objects o where o.bucket_id = 'staff-docs' and o.name = p_path) then
    raise exception 'Le fichier n''est pas arrivé : recommence l''envoi.' using errcode = 'P0001';
  end if;
  if p_category in ('arret', 'accident') and p_start is null then
    raise exception 'Indique la date de début de l''arrêt.' using errcode = 'P0001';
  end if;

  insert into public.staff_documents (profile_id, category, title, file_path, file_name, mime, size_bytes,
                                      start_date, end_date, note, uploaded_by, accountant_id)
    values (p_profile, p_category, left(btrim(coalesce(p_title, '')), 120), p_path, left(coalesce(p_file_name, ''), 200),
            left(coalesce(p_mime, ''), 80), p_size, v_s, v_e, left(btrim(coalesce(p_note, '')), 300), me, acc)
    returning id into v_id;

  if p_category in ('arret', 'accident') then
    insert into public.leave_requests (profile_id, kind, reason, start_date, end_date, note, status, decided_by, decided_at, document_id)
      values (p_profile, 'conge', case when p_category = 'arret' then 'maladie' else 'accident_travail' end,
              p_start, greatest(coalesce(p_end, p_start), p_start), 'Arrêt envoyé par l''appli', 'approved', me, now(), v_id);
  end if;

  -- E-mails : jamais bloquants.
  begin
    select * into m from public.email_settings;
    if m.enabled and p_category = 'paie' then
      if m.notify_payslips and coalesce(p.email, '') <> '' and p.active then
        perform public._email_queue('bulletin', p.email,
          'Ton bulletin de paie de ' || public._fr_month(v_s),
          'Bonjour ' || p.first_name || ',' || E'\n\n'
          || 'Ton bulletin de paie de ' || public._fr_month(v_s) || ' est disponible dans l''appli de la Nuba, '
          || 'rubrique Mon compte, « Mes bulletins de paie » : ' || m.app_url || '#/compte' || E'\n\n' || m.signature);
      end if;
    elsif m.enabled and m.notify_documents then
      what := public._doc_label(p_category);
      for a in select email from public.accountants where active loop
        perform public._email_queue('document', a.email,
          'Nouveau document : ' || p.first_name || ' ' || p.last_name,
          p.first_name || ' ' || p.last_name || ' a envoyé ' || what
          || case when p_start is not null then ', du ' || to_char(p_start, 'DD/MM/YYYY') || ' au '
                  || to_char(coalesce(p_end, p_start), 'DD/MM/YYYY') else '' end || '.' || E'\n\n'
          || 'Il t''attend dans ton espace, rubrique Documents : ' || m.app_url || E'\n\n' || m.signature);
      end loop;
      if p_category in ('arret', 'accident') and m.notify_email <> '' then
        perform public._email_queue('document', m.notify_email,
          'Arrêt de travail : ' || p.first_name || ' ' || p.last_name,
          p.first_name || ' ' || p.last_name || ' a envoyé ' || what || ', du ' || to_char(p_start, 'DD/MM/YYYY')
          || ' au ' || to_char(coalesce(p_end, p_start), 'DD/MM/YYYY') || '. L''absence est notée dans le planning.'
          || E'\n\n' || m.app_url || '#/planning');
      end if;
    end if;
  exception when others then
    null;
  end;
  return v_id;
end $$;

-- ---------- Retirer un bulletin déposé par erreur ------------------------------------
-- La comptable retire ceux qu'elle a déposés ; le gérant, n'importe lequel.
-- Renvoie le chemin du fichier, que l'appli retire ensuite de l'espace de stockage.
create function public.delete_payslip(p_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  acc  uuid := public._accountant_id();
  path text;
begin
  if acc is null and not public.is_gerant() then
    raise exception 'Réservé au gérant et à la comptable.' using errcode = '42501';
  end if;
  delete from public.staff_documents
    where id = p_id and category = 'paie' and (public.is_gerant() or accountant_id = acc)
    returning file_path into path;
  if path is null then raise exception 'Bulletin introuvable.' using errcode = 'P0001'; end if;
  return path;
end $$;

revoke all on function public._fr_month(date), public.delete_payslip(uuid) from public, anon, authenticated;
grant execute on function public.delete_payslip(uuid) to authenticated;

commit;
