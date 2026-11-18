-- =====================================================================
-- Nuba Gestion · migration 0015 · numéros utiles
--
-- À exécuter une seule fois dans Supabase, après la 0014 :
--   SQL Editor > New query > coller tout ce fichier > Run.
-- Supabase doit répondre « Success. No rows returned ».
--
-- Les numéros à appeler : urgences, dépannage, fournisseurs, équipe…
-- Toute l'équipe les lit, y compris sur l'iPad par code PIN.
-- Seuls le gérant et les responsables, connectés avec leur compte, les modifient.
-- =====================================================================
begin;

create table public.contacts (
  id         uuid primary key default gen_random_uuid(),
  category   text not null default 'autre' check (category in ('urgence', 'equipe', 'depannage', 'fournisseur', 'administratif', 'autre')),
  name       text not null check (length(btrim(name)) > 0 and length(name) <= 80),
  phone      text not null check (phone ~ '^[0-9+][0-9 .()+-]{1,24}$'),
  note       text not null default '' check (length(note) <= 300),
  urgent     boolean not null default false,
  position   int not null default 0,
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now()
);
create index contacts_order on public.contacts (category, position, name);

-- Qui a modifié un numéro, et quand.
create function public.contacts_stamp() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.name := btrim(new.name);
  new.phone := btrim(new.phone);
  new.note := btrim(new.note);
  new.updated_by := public.my_profile_id();
  new.updated_at := now();
  return new;
end $$;
create trigger contacts_stamp before insert or update on public.contacts
  for each row execute function public.contacts_stamp();

-- Modèles : les numéros d'urgence nationaux et les dépannages de Haute-Garonne.
insert into public.contacts (category, name, phone, note, urgent, position) values
  ('urgence', 'SAMU, urgence médicale', '15', 'Malaise, blessure grave, brûlure importante.', true, 1),
  ('urgence', 'Pompiers', '18', 'Incendie, accident, personne en danger.', true, 2),
  ('urgence', 'Police secours', '17', 'Agression, bagarre, vol en cours.', true, 3),
  ('urgence', 'Numéro d''urgence européen', '112', 'Depuis n''importe quel téléphone, même sans réseau de ton opérateur.', true, 4),
  ('urgence', 'Urgences par SMS', '114', 'Pour les personnes sourdes, malentendantes ou qui ne peuvent pas parler.', true, 5),
  ('depannage', 'Urgence gaz (GRDF)', '0 800 47 33 33', 'Odeur de gaz : coupe le gaz, aère, sors, n''allume rien, puis appelle. Gratuit, jour et nuit.', true, 10),
  ('depannage', 'Panne d''électricité (Enedis, Haute-Garonne)', '09 72 67 50 31', 'Coupure de courant dans le quartier, câble endommagé.', false, 11);

alter table public.contacts enable row level security;
revoke all on public.contacts from anon, authenticated;
grant select on public.contacts to anon, authenticated;
grant insert, update, delete on public.contacts to authenticated;

-- Lecture : toute l'équipe, y compris dans une session à code PIN.
create policy "numeros: lecture" on public.contacts
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
-- Écriture : gérant et responsables, avec leur compte (jamais par code PIN : is_manager() y est faux).
create policy "numeros: ajout par l'encadrement" on public.contacts
  for insert to authenticated with check ((select public.is_manager()));
create policy "numeros: modification par l'encadrement" on public.contacts
  for update to authenticated using ((select public.is_manager())) with check ((select public.is_manager()));
create policy "numeros: suppression par l'encadrement" on public.contacts
  for delete to authenticated using ((select public.is_manager()));

revoke all on function public.contacts_stamp() from public, anon, authenticated;

commit;
