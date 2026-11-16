-- =====================================================================
-- Nuba Gestion · migration 0003 · relier une borne avec un code à 6 chiffres
--
-- À exécuter une seule fois dans Supabase, après la 0002 :
--   SQL Editor > New query > coller tout ce fichier > Run.
--
-- Avant : la borne se reliait par un lien ou un QR code, peu pratique sur un iPad.
-- Maintenant : le gérant obtient un code à 6 chiffres, valable 10 minutes, et le tape
-- sur l'appareil. Relier un appareil remplace le précédent : une borne, un appareil.
-- =====================================================================

alter table public.kiosks
  add column pair_code_hash bytea,
  add column pair_expires_at timestamptz;

-- Codes de liaison refusés, pour limiter les essais (tous appareils confondus).
create table public.kiosk_pair_failures (
  at timestamptz not null default now()
);
create index kiosk_pair_failures_recent on public.kiosk_pair_failures (at desc);
alter table public.kiosk_pair_failures enable row level security;
revoke all on public.kiosk_pair_failures from anon, authenticated;

-- Code à 6 chiffres qui n'est pas déjà en cours pour une autre borne.
create function public._new_pair_code() returns text
language plpgsql security definer set search_path = '' as $$
declare
  c text;
begin
  loop
    c := lpad((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::bigint % 1000000)::text, 6, '0');
    exit when not exists (
      select 1 from public.kiosks
      where pair_code_hash = sha256(convert_to(c, 'UTF8')) and pair_expires_at > now()
    );
  end loop;
  return c;
end $$;

-- Donne un code de liaison pour une borne existante. Réservé au gérant.
create function public.start_kiosk_pairing(p_kiosk uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  c text;
begin
  if not public.is_gerant() then
    raise exception 'Réservé au gérant.' using errcode = '42501';
  end if;
  c := public._new_pair_code();
  update public.kiosks
    set pair_code_hash = sha256(convert_to(c, 'UTF8')), pair_expires_at = now() + interval '10 minutes'
    where id = p_kiosk and revoked_at is null;
  if not found then raise exception 'Borne introuvable ou désactivée.' using errcode = 'P0001'; end if;
  return c;
end $$;

-- Crée une borne et donne tout de suite son code de liaison. Réservé au gérant.
create function public.add_kiosk(p_site uuid, p_label text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if not public.is_gerant() then
    raise exception 'Réservé au gérant.' using errcode = '42501';
  end if;
  -- Jeton provisoire que personne ne connaît : la borne ne marche qu'une fois reliée par son code.
  insert into public.kiosks (site_id, label, token_hash, created_by)
    values (p_site, btrim(p_label),
            sha256(convert_to(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'UTF8')),
            public.my_profile_id())
    returning id into v_id;
  return jsonb_build_object('id', v_id, 'code', public.start_kiosk_pairing(v_id));
end $$;

-- L'appareil échange le code contre le jeton de la borne. Appelable sans compte.
-- Renvoie {ok:true, token, label} ou {ok:false, error}. Le code ne sert qu'une fois,
-- et l'appareil relié auparavant à cette borne cesse d'afficher le code de pointage.
create function public.claim_kiosk(p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  k public.kiosks;
  t text;
begin
  delete from public.kiosk_pair_failures where at < now() - interval '1 day';
  if (select count(*) from public.kiosk_pair_failures where at > now() - interval '10 minutes') >= 20 then
    return jsonb_build_object('ok', false, 'error', 'too_many');
  end if;

  select * into k from public.kiosks
    where pair_code_hash = sha256(convert_to(btrim(coalesce(p_code, '')), 'UTF8'))
      and pair_expires_at > now() and revoked_at is null
    limit 1
    for update;
  if not found then
    insert into public.kiosk_pair_failures default values;
    return jsonb_build_object('ok', false, 'error', 'code');
  end if;

  t := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  update public.kiosks
    set token_hash = sha256(convert_to(t, 'UTF8')), pair_code_hash = null, pair_expires_at = null, last_seen_at = null
    where id = k.id;
  return jsonb_build_object('ok', true, 'token', t, 'label', k.label);
end $$;

revoke all on function public.start_kiosk_pairing(uuid), public.add_kiosk(uuid, text) from public, anon;
grant execute on function public.start_kiosk_pairing(uuid), public.add_kiosk(uuid, text) to authenticated;
revoke all on function public.claim_kiosk(text) from public;
grant execute on function public.claim_kiosk(text) to anon, authenticated;
revoke all on function public._new_pair_code() from public, anon, authenticated;
