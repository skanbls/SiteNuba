-- =====================================================================
-- Nuba Gestion · migration 0014 · mercuriales : dates envoyées comme des nombres
--
-- À exécuter une seule fois dans Supabase, après la 0013 :
--   SQL Editor > New query > coller tout ce fichier > Run.
-- Supabase doit répondre « Success. No rows returned ».
--
-- Dans une mercuriale, une date calculée par une formule peut être un simple nombre
-- mis en forme « jj/mm/aaaa » : le numéro de série de Google Sheets (46344 = 18/11/2026,
-- en jours depuis le 30/12/1899). Ces commandes étaient écartées faute de date lisible.
-- =====================================================================
begin;

create or replace function public._mdate(v jsonb) returns date
language plpgsql immutable set search_path = '' as $$
declare t text := btrim(coalesce(v #>> '{}', ''));
begin
  -- Numéro de série de Google Sheets : de 1927 à 2173.
  if t ~ '^\d{5}([.,]\d+)?$' then return date '1899-12-30' + floor(replace(t, ',', '.')::numeric)::int; end if;
  if t ~ '^\d{4}-\d{2}-\d{2}' then return left(t, 10)::date; end if;
  if t ~ '^\d{1,2}/\d{1,2}/\d{4}$' then return to_date(t, 'DD/MM/YYYY'); end if;
  return null;
exception when others then
  return null;
end $$;

revoke all on function public._mdate(jsonb) from public, anon, authenticated;

commit;
