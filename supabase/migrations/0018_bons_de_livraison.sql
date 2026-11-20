-- =====================================================================
-- Nuba Gestion · migration 0018 · bons de livraison Saveurs Nomades et Comptoir
--
-- À exécuter une seule fois dans Supabase, après la 0017 :
--   SQL Editor > New query > coller tout ce fichier > Run.
-- Supabase doit répondre « Success. No rows returned ».
--
-- Les bons de livraison se fabriquent tout seuls dans l'appli, à partir des commandes
-- reçues des mercuriales (onglet PRESTATIONS). Cette table garde seulement leur en-tête :
-- l'expéditeur, le client, le lieu de livraison, le créneau, le livreur, la DLC et le lot.
-- Ces coordonnées restent dans la base, jamais dans le code de l'appli.
-- Toute l'équipe les lit (pour imprimer un bon, y compris sur l'iPad) ; le gérant les modifie.
-- =====================================================================
begin;

create table public.delivery_settings (
  id              boolean primary key default true check (id),
  sender_name     text not null default '' check (length(sender_name) <= 80),
  sender_tagline  text not null default '' check (length(sender_tagline) <= 120),
  sender_address  text not null default '' check (length(sender_address) <= 200),
  sender_siret    text not null default '' check (length(sender_siret) <= 40),
  sender_contact  text not null default '' check (length(sender_contact) <= 120),
  client_name     text not null default '' check (length(client_name) <= 80),
  client_address  text not null default '' check (length(client_address) <= 200),
  client_siret    text not null default '' check (length(client_siret) <= 40),
  place_name      text not null default '' check (length(place_name) <= 120),
  place_address   text not null default '' check (length(place_address) <= 200),
  place_access    text not null default '' check (length(place_access) <= 200),
  slot            text not null default '' check (length(slot) <= 40),     -- créneau de livraison, « 06h30 »
  driver          text not null default '' check (length(driver) <= 80),
  dlc_days        int not null default 3 check (dlc_days between 0 and 30),  -- DLC = livraison + n jours
  lot_days_before int not null default 1 check (lot_days_before between 0 and 14), -- lot = jour de production
  updated_at      timestamptz,
  updated_by      uuid references public.profiles (id) on delete set null
);
insert into public.delivery_settings default values;

-- Textes nettoyés, auteur et date de la modification.
create function public.delivery_settings_stamp() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.id := true;
  new.sender_name := btrim(new.sender_name);       new.sender_tagline := btrim(new.sender_tagline);
  new.sender_address := btrim(new.sender_address); new.sender_siret := btrim(new.sender_siret);
  new.sender_contact := btrim(new.sender_contact); new.client_name := btrim(new.client_name);
  new.client_address := btrim(new.client_address); new.client_siret := btrim(new.client_siret);
  new.place_name := btrim(new.place_name);         new.place_address := btrim(new.place_address);
  new.place_access := btrim(new.place_access);     new.slot := btrim(new.slot);
  new.driver := btrim(new.driver);
  new.updated_at := now();
  new.updated_by := public.my_profile_id();
  return new;
end $$;
create trigger delivery_settings_stamp before update on public.delivery_settings
  for each row execute function public.delivery_settings_stamp();

alter table public.delivery_settings enable row level security;
revoke all on public.delivery_settings from anon, authenticated;
grant select on public.delivery_settings to anon, authenticated;
grant update (sender_name, sender_tagline, sender_address, sender_siret, sender_contact, client_name, client_address,
              client_siret, place_name, place_address, place_access, slot, driver, dlc_days, lot_days_before)
  on public.delivery_settings to authenticated;

create policy "bons de livraison: lecture" on public.delivery_settings
  for select to anon, authenticated using ((select public.my_profile_id()) is not null);
create policy "bons de livraison: le gerant modifie" on public.delivery_settings
  for update to authenticated using ((select public.is_gerant())) with check ((select public.is_gerant()));

revoke all on function public.delivery_settings_stamp() from public, anon, authenticated;

commit;
