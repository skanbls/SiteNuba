-- =====================================================================
-- Nuba Gestion · migration 0020 · absences, documents de l'équipe, récap comptable,
-- cases de la liste de courses
--
-- À exécuter une seule fois dans Supabase, après la 0019 :
--   SQL Editor > New query > coller tout ce fichier > Run.
-- Supabase doit répondre « Success. No rows returned ».
-- Tout passe ou rien ne passe : en cas d'erreur, la base reste comme avant.
--
-- 1. Planning : chaque absence a un motif (congés payés, maladie, accident du travail,
--    événement familial…), comme dans les logiciels de planning, et peut porter sur une demi-journée.
--    Les collègues voient qu'une personne est absente, jamais pourquoi : le motif reste
--    à la personne, aux responsables, au gérant et à la comptable.
-- 2. Documents de l'équipe (arrêt de travail, pièce d'identité, carte Vitale, DPAE, contrat…) :
--    rangés dans un espace de stockage privé de Supabase (« staff-docs »). Chacun envoie et voit
--    les siens ; le gérant et la comptable voient tout ; ni les responsables ni les collègues.
--    Un arrêt de travail envoyé avec ses dates devient une absence « maladie » du planning,
--    et la comptable reçoit un e-mail (sans pièce jointe : elle ouvre son espace).
-- 3. Récap mensuel de la comptable : heures et absences par motif.
-- 4. Lien vers la caisse Zelty pour la comptable (en attendant la lecture des Z par l'appli).
-- 5. Liste de courses : les cases cochées, partagées entre tous les appareils.
--
-- Elle s'appuie sur les mises à jour 0010 (administration) et 0016 (accès comptable) :
-- s'il en manque une, elle s'arrête tout de suite en disant laquelle exécuter d'abord.
-- =====================================================================
begin;

do $$
declare missing text := '';
begin
  if to_regclass('public.profile_folders') is null or to_regprocedure('public._email_queue(text, text, text, text)') is null then
    missing := missing || ' 0010 (administration),';
  end if;
  if to_regclass('public.accountants') is null or to_regprocedure('public._accountant_id()') is null then
    missing := missing || ' 0016 (accès comptable),';
  end if;
  if missing <> '' then
    raise exception 'Il manque une mise à jour plus ancienne. Exécute d''abord :% puis relance celle-ci (0020).', rtrim(missing, ',');
  end if;
end $$;

-- ---------- 1. Motifs d'absence ----------------------------------------------------
alter table public.leave_requests
  add column reason      text not null default 'conges_payes',
  add column part        text not null default 'full',
  add column document_id uuid;
update public.leave_requests set reason = 'autre' where kind = 'indisponibilite';
alter table public.leave_requests
  add constraint leave_requests_reason check (reason in (
    'conges_payes', 'recuperation', 'ferie', 'maladie', 'accident_travail', 'enfant_malade', 'maternite',
    'paternite', 'parental', 'evenement_familial', 'formation', 'absence_autorisee', 'sans_solde',
    'absence_injustifiee', 'mise_a_pied', 'autre')),
  add constraint leave_requests_part check (part in ('full', 'am', 'pm') and (part = 'full' or start_date = end_date));

-- Le motif d'une absence ne regarde pas les collègues : chacun lit les siennes, les responsables
-- et le gérant toutes. Les autres savent seulement qui est absent, par team_absences.
alter policy "conges: lecture" on public.leave_requests
  using (profile_id = (select public.my_profile_id()) or (select public.is_manager()));

create function public.team_absences(p_since date) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when public.my_profile_id() is null then '[]'::jsonb else coalesce((
    select jsonb_agg(jsonb_build_object('id', l.id, 'profile_id', l.profile_id, 'start_date', l.start_date,
                                        'end_date', l.end_date, 'part', l.part) order by l.start_date)
    from public.leave_requests l
    where l.status = 'approved' and l.end_date >= p_since and l.start_date <= p_since + 400), '[]'::jsonb) end
$$;

-- ---------- La comptable, reconnue par les règles d'accès ----------------------------
create function public.is_accountant() returns boolean
language sql stable security definer set search_path = '' as $$
  select public._accountant_id() is not null
$$;

-- ---------- 2. Documents de l'équipe -------------------------------------------------
create table public.staff_documents (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references public.profiles (id) on delete cascade,
  category    text not null check (category in (
                'arret', 'accident', 'justificatif', 'identite', 'sejour', 'vitale', 'rib', 'mutuelle',
                'medecine', 'diplome', 'dpae', 'contrat', 'autre')),
  title       text not null default '' check (length(title) <= 120),
  file_path   text not null unique,
  file_name   text not null default '' check (length(file_name) <= 200),
  mime        text not null default '',
  size_bytes  int,
  start_date  date,
  end_date    date,
  note        text not null default '' check (length(note) <= 300),
  uploaded_by uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  constraint staff_documents_dates check (end_date is null or start_date is null or end_date >= start_date)
);
create index staff_documents_by_profile on public.staff_documents (profile_id, created_at desc);
alter table public.leave_requests
  add constraint leave_requests_document foreign key (document_id) references public.staff_documents (id) on delete set null;

alter table public.email_settings add column notify_documents boolean not null default true;

-- Espace de stockage privé : 10 Mo par fichier, PDF et photos.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('staff-docs', 'staff-docs', false, 10485760,
          array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
  on conflict (id) do nothing;

-- Un fichier se range sous le dossier de la personne : « <id de la personne>/<nom> ».
create policy "documents: depot" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'staff-docs'
              and ((storage.foldername(name))[1] = (select public.my_profile_id())::text or (select public.is_gerant())));
create policy "documents: lecture" on storage.objects
  for select to authenticated
  using (bucket_id = 'staff-docs'
         and ((storage.foldername(name))[1] = (select public.my_profile_id())::text
              or (select public.is_gerant()) or (select public.is_accountant())));
create policy "documents: suppression" on storage.objects
  for delete to authenticated
  using (bucket_id = 'staff-docs' and (select public.is_gerant()));

-- Libellé d'une catégorie, pour les e-mails.
create function public._doc_label(c text) returns text
language sql immutable set search_path = '' as $$
  select case c
    when 'arret' then 'un arrêt de travail' when 'accident' then 'un document d''accident du travail'
    when 'justificatif' then 'un justificatif d''absence' when 'identite' then 'une pièce d''identité'
    when 'sejour' then 'un titre de séjour' when 'vitale' then 'une carte Vitale'
    when 'rib' then 'un RIB' when 'mutuelle' then 'un document de mutuelle'
    when 'medecine' then 'un document de médecine du travail' when 'diplome' then 'un diplôme ou une attestation'
    when 'dpae' then 'une DPAE' when 'contrat' then 'un contrat de travail'
    else 'un document' end
$$;

-- Enregistre un document déjà déposé dans l'espace de stockage. Appelé juste après l'envoi du fichier.
-- Un arrêt (ou un accident du travail) avec ses dates devient une absence du planning.
-- La comptable et le gérant sont prévenus par e-mail ; l'envoi ne bloque jamais l'enregistrement.
create function public.add_staff_document(
  p_profile uuid, p_category text, p_title text, p_path text, p_file_name text, p_mime text, p_size int,
  p_start date, p_end date, p_note text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me   uuid := public.my_profile_id();
  v_id uuid;
  p    public.profiles;
  m    public.email_settings;
  a    record;
  what text;
begin
  if me is null then
    raise exception 'Connecte-toi avec ton compte pour envoyer un document.' using errcode = '42501';
  end if;
  if p_profile is distinct from me and not public.is_gerant() then
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
                                      start_date, end_date, note, uploaded_by)
    values (p_profile, p_category, left(btrim(coalesce(p_title, '')), 120), p_path, left(coalesce(p_file_name, ''), 200),
            left(coalesce(p_mime, ''), 80), p_size, p_start, coalesce(p_end, p_start), left(btrim(coalesce(p_note, '')), 300), me)
    returning id into v_id;

  if p_category in ('arret', 'accident') then
    insert into public.leave_requests (profile_id, kind, reason, start_date, end_date, note, status, decided_by, decided_at, document_id)
      values (p_profile, 'conge', case when p_category = 'arret' then 'maladie' else 'accident_travail' end,
              p_start, greatest(coalesce(p_end, p_start), p_start), 'Arrêt envoyé par l''appli', 'approved', me, now(), v_id);
  end if;

  -- E-mails : jamais bloquants.
  begin
    select * into m from public.email_settings;
    if m.enabled and m.notify_documents then
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

-- Tous les documents, avec le nom de chacun et le lien de son dossier Drive : gérant et comptable.
create function public.team_documents() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_gerant() and not public.is_accountant() then
    raise exception 'Réservé au gérant et à la comptable.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'people', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'first_name', p.first_name, 'last_name', p.last_name,
                                 'active', p.active, 'folder_url', f.url) order by p.active desc, p.first_name, p.last_name), '[]'::jsonb)
               from public.profiles p left join public.profile_folders f on f.profile_id = p.id
               where p.active or exists (select 1 from public.staff_documents d where d.profile_id = p.id)),
    'documents', (select coalesce(jsonb_agg(to_jsonb(d) order by d.created_at desc), '[]'::jsonb) from public.staff_documents d));
end $$;

alter table public.staff_documents enable row level security;
revoke all on public.staff_documents from anon, authenticated;
grant select on public.staff_documents to authenticated;
grant delete on public.staff_documents to authenticated;
create policy "documents de l'equipe: lecture" on public.staff_documents
  for select to authenticated
  using (profile_id = (select public.my_profile_id()) or (select public.is_gerant()) or (select public.is_accountant()));
create policy "documents de l'equipe: suppression par le gerant" on public.staff_documents
  for delete to authenticated using ((select public.is_gerant()));

-- ---------- 3. Récap de la comptable : heures et absences ------------------------------
create or replace function public.hours_report(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  t0 timestamptz;
  t1 timestamptz;
begin
  if public._accountant_id() is null and not public.is_gerant() then
    raise exception 'Réservé à la comptable et au gérant.' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'Choisis une période de 400 jours au plus.' using errcode = 'P0001';
  end if;
  t0 := p_from::timestamp at time zone 'Europe/Paris';
  t1 := (p_to + 1)::timestamp at time zone 'Europe/Paris';
  return jsonb_build_object(
    'people', (select coalesce(jsonb_agg(jsonb_build_object(
                  'id', p.id, 'first_name', p.first_name, 'last_name', p.last_name, 'contract', p.contract,
                  'weekly_hours', p.weekly_hours, 'active', p.active) order by p.first_name, p.last_name), '[]'::jsonb)
               from public.profiles p
               where p.active
                  or exists (select 1 from public.time_entries e where e.profile_id = p.id and e.clock_in >= t0 and e.clock_in < t1)
                  or exists (select 1 from public.leave_requests l where l.profile_id = p.id and l.status = 'approved'
                             and l.kind = 'conge' and l.start_date <= p_to and l.end_date >= p_from)),
    'entries', (select coalesce(jsonb_agg(jsonb_build_object(
                  'id', e.id, 'profile_id', e.profile_id, 'site_id', e.site_id, 'clock_in', e.clock_in, 'clock_out', e.clock_out,
                  'source', e.source, 'note', '', 'needs_review', e.needs_review,
                  'profiles', jsonb_build_object('first_name', p.first_name, 'last_name', p.last_name),
                  'sites', case when s.id is null then null else jsonb_build_object('name', s.name) end,
                  'time_breaks', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'entry_id', b.entry_id, 'started_at', b.started_at, 'ended_at', b.ended_at)
                                                            order by b.started_at), '[]'::jsonb)
                                  from public.time_breaks b where b.entry_id = e.id))
                  order by e.clock_in), '[]'::jsonb)
                from public.time_entries e
                join public.profiles p on p.id = e.profile_id
                left join public.sites s on s.id = e.site_id
                where e.clock_in >= t0 and e.clock_in < t1),
    -- Absences acceptées qui touchent la période, sans les notes ; « document » : un justificatif a été envoyé.
    'absences', (select coalesce(jsonb_agg(jsonb_build_object(
                  'id', l.id, 'profile_id', l.profile_id, 'reason', l.reason, 'start_date', l.start_date,
                  'end_date', l.end_date, 'part', l.part, 'document', l.document_id is not null) order by l.start_date), '[]'::jsonb)
                 from public.leave_requests l
                 where l.status = 'approved' and l.kind = 'conge' and l.start_date <= p_to and l.end_date >= p_from));
end $$;

-- ---------- 4. Caisse Zelty pour la comptable -----------------------------------------
create table public.accounting_settings (
  id        boolean primary key default true check (id),
  zelty_url text not null default '' check (zelty_url = '' or (zelty_url ~ '^https://[^\s]+$' and length(zelty_url) <= 300))
);
insert into public.accounting_settings default values;
alter table public.accounting_settings enable row level security;
revoke all on public.accounting_settings from anon, authenticated;
grant select on public.accounting_settings to authenticated;
grant update (zelty_url) on public.accounting_settings to authenticated;
create policy "comptabilite: lecture" on public.accounting_settings
  for select to authenticated using ((select public.is_gerant()) or (select public.is_accountant()));
create policy "comptabilite: le gerant modifie" on public.accounting_settings
  for update to authenticated using ((select public.is_gerant())) with check ((select public.is_gerant()));

-- ---------- 5. Liste de courses : cases cochées ---------------------------------------
create table public.shopping_checks (
  day        date not null,
  item       text not null check (length(item) between 1 and 200),
  checked_by uuid references public.profiles (id) on delete set null,
  checked_at timestamptz not null default now(),
  primary key (day, item)
);
alter table public.shopping_checks enable row level security;
revoke all on public.shopping_checks from anon, authenticated;
grant select on public.shopping_checks to anon, authenticated;
create policy "courses cochees: lecture" on public.shopping_checks
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);

-- Cocher ou décocher un article de la liste d'un jour (p_item vide : tout décocher).
create function public.check_shopping(p_day date, p_item text, p_on boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare me uuid := public.my_profile_id();
begin
  if me is null then
    raise exception 'Identifie-toi pour cocher la liste.' using errcode = '42501';
  end if;
  delete from public.shopping_checks where day < current_date - 60;
  if coalesce(p_item, '') = '' then
    delete from public.shopping_checks where day = p_day;
  elsif p_on then
    insert into public.shopping_checks (day, item, checked_by) values (p_day, left(p_item, 200), me)
      on conflict (day, item) do nothing;
  else
    delete from public.shopping_checks where day = p_day and item = p_item;
  end if;
end $$;

-- ---------- Droits sur les fonctions ---------------------------------------------------
revoke all on function public.team_absences(date), public.is_accountant(), public._doc_label(text),
  public.add_staff_document(uuid, text, text, text, text, text, int, date, date, text), public.team_documents(),
  public.check_shopping(date, text, boolean)
  from public, anon, authenticated;
grant execute on function public.team_absences(date), public.check_shopping(date, text, boolean) to anon, authenticated;
grant execute on function public.is_accountant(), public.team_documents(),
  public.add_staff_document(uuid, text, text, text, text, text, int, date, date, text) to authenticated;

commit;
