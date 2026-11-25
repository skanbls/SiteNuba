-- =====================================================================
-- Nuba Gestion · migration 0026 · fermeture de caisse
--
-- À exécuter une seule fois dans Supabase, après la 0025 :
--   SQL Editor > New query > coller tout ce fichier > Run.
-- Supabase doit répondre « Success. No rows returned ».
-- Tout passe ou rien ne passe : en cas d'erreur, la base reste comme avant.
--
-- Chaque soir, la personne qui ferme remplit la fermeture du jour de service (de 5 h à 5 h) :
--   * le ticket Z de la caisse Zelty : numéro, CA TTC, couverts, tickets, répartition des paiements ;
--   * le comptage des espèces, billet par billet et pièce par pièce, le fond de caisse et les dépenses payées en espèces ;
--   * le ticket de fin de journée du terminal CB, les titres-restaurant et les chèques comptés ;
--   * la photo du Z.
-- La base calcule les écarts et la remise en banque ; un écart de plus de 2 € demande une explication.
-- Toute l'équipe peut faire la fermeture du jour, sur son téléphone ou sur l'iPad avec son code PIN.
-- Les jours passés et l'historique : le gérant, les responsables qui ont l'accès « Caisse », et la comptable (lecture).
-- À la clôture, le gérant reçoit un e-mail récapitulatif.
-- =====================================================================
begin;

do $$ begin
  if to_regprocedure('public.can(text)') is null or to_regprocedure('public.is_accountant()') is null
     or to_regprocedure('public._email_queue(text, text, text, text)') is null then
    raise exception 'Il manque une mise à jour plus ancienne. Exécute d''abord : 0010, 0016 et 0020, puis relance celle-ci (0026).';
  end if;
end $$;

-- ---------- Un nouvel accès à confier : la caisse -----------------------------------------
alter table public.profile_rights drop constraint profile_rights_area_check;
alter table public.profile_rights add constraint profile_rights_area_check check (area in (
  'planning', 'pointages', 'checklists', 'hygiene', 'stocks', 'reservations', 'evenements', 'fiches',
  'maintenance', 'procedures', 'caisse'));

alter table public.email_settings add column notify_closing boolean not null default true;

-- ---------- Fermetures -----------------------------------------------------------------
create table public.cash_closings (
  id             uuid primary key default gen_random_uuid(),
  day            date not null unique,
  status         text not null default 'draft' check (status in ('draft', 'closed')),
  -- Ticket Z
  z_number       text not null default '' check (length(z_number) <= 40),
  z_total        numeric(10, 2) check (z_total >= 0),
  z_covers       int check (z_covers >= 0),
  z_tickets      int check (z_tickets >= 0),
  z_cash         numeric(10, 2) check (z_cash >= 0),
  z_card         numeric(10, 2) check (z_card >= 0),
  z_meal         numeric(10, 2) check (z_meal >= 0),
  z_cheque       numeric(10, 2) check (z_cheque >= 0),
  z_other        numeric(10, 2) check (z_other >= 0),
  -- Espèces
  float_start    numeric(10, 2) check (float_start >= 0),
  cash_counts    jsonb not null default '{}',   -- {"5000": 3} : nombre de billets de 50 € (clé en centimes)
  cash_counted   numeric(10, 2),                -- calculé à partir de cash_counts
  expenses       jsonb not null default '[]',   -- [{"label": "Glaçons", "amount": 12.5}]
  expenses_total numeric(10, 2) not null default 0,
  float_end      numeric(10, 2) check (float_end >= 0),
  -- Autres moyens de paiement comptés
  card_counted   numeric(10, 2) check (card_counted >= 0),
  meal_counted   numeric(10, 2) check (meal_counted >= 0),
  cheque_counted numeric(10, 2) check (cheque_counted >= 0),
  tips           numeric(10, 2) check (tips >= 0),
  -- Calculés par la base
  cash_expected  numeric(10, 2),
  cash_gap       numeric(10, 2),
  card_gap       numeric(10, 2),
  meal_gap       numeric(10, 2),
  cheque_gap     numeric(10, 2),
  bank_deposit   numeric(10, 2),
  note           text not null default '' check (length(note) <= 1000),
  has_photo      boolean not null default false,
  closed_by      uuid references public.profiles (id) on delete set null,
  closed_at      timestamptz,
  updated_by     uuid references public.profiles (id) on delete set null,
  updated_at     timestamptz not null default now()
);
create index cash_closings_by_day on public.cash_closings (day desc);

-- La photo du Z, à part (réduite par l'appli, 600 ko au plus).
create table public.cash_closing_photos (
  closing_id uuid primary key references public.cash_closings (id) on delete cascade,
  mime       text not null check (mime in ('image/jpeg', 'image/png', 'image/webp')),
  data       text not null check (length(data) <= 820000),   -- base64
  created_at timestamptz not null default now()
);

alter table public.cash_closings enable row level security;
alter table public.cash_closing_photos enable row level security;
revoke all on public.cash_closings, public.cash_closing_photos from anon, authenticated;
-- L'historique : le gérant, les responsables qui ont l'accès « Caisse », la comptable. Jamais une session à code PIN.
grant select on public.cash_closings to authenticated;
create policy "caisse: lecture" on public.cash_closings
  for select to authenticated using ((select public.can('caisse')) or (select public.is_accountant()));
-- Les écritures passent par save_cash_closing ; les photos par cash_closing_photo.

-- ---------- Calculs -------------------------------------------------------------------------
-- Un montant à la française : « 1 234,50 € » (avec le signe si p_sign : « +2,00 € », « -1,50 € »).
create function public._eur(v numeric, p_sign boolean default false) returns text
language sql immutable set search_path = '' as $$
  select case when v is null then '–' else
    case when p_sign and v > 0 then '+' when v < 0 then '-' else '' end
    || replace(replace(to_char(abs(round(v, 2)), 'FM999G999G990D00'), ',', ' '), '.', ',') || ' €' end
$$;

-- Total des espèces comptées : la somme des coupures (clés en centimes). Null si rien n'est compté.
create function public._cash_total(p_counts jsonb) returns numeric
language sql immutable set search_path = '' as $$
  select case when count(*) = 0 then null else round(sum(k.key::numeric * greatest(0, coalesce((k.value #>> '{}')::numeric, 0))) / 100, 2) end
  from jsonb_each(coalesce(p_counts, '{}')) k
  where k.key ~ '^\d{1,6}$' and k.key::int in (1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000)
$$;

create function public._closing_calc() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.cash_counted := public._cash_total(new.cash_counts);
  new.expenses_total := coalesce((select round(sum(greatest(0, coalesce((e ->> 'amount')::numeric, 0))), 2)
                                  from jsonb_array_elements(case when jsonb_typeof(new.expenses) = 'array' then new.expenses else '[]' end) e), 0);
  -- Espèces attendues = fond de départ + espèces encaissées (Z) − dépenses payées en espèces.
  new.cash_expected := case when new.float_start is not null and new.z_cash is not null
                            then new.float_start + new.z_cash - new.expenses_total end;
  new.cash_gap := new.cash_counted - new.cash_expected;
  new.card_gap := new.card_counted - new.z_card;
  new.meal_gap := new.meal_counted - new.z_meal;
  new.cheque_gap := new.cheque_counted - new.z_cheque;
  -- Remise en banque : ce qui est compté, moins le fond laissé pour demain.
  new.bank_deposit := case when new.cash_counted is not null and new.float_end is not null
                           then greatest(0, new.cash_counted - new.float_end) end;
  new.updated_at := now();
  return new;
end $$;
create trigger cash_closings_calc before insert or update on public.cash_closings
  for each row execute function public._closing_calc();

-- ---------- La fermeture du jour, pour toute l'équipe ----------------------------------------
-- La fermeture du jour de service en cours (ou d'un autre jour pour le gérant et l'accès « Caisse »),
-- avec le fond de caisse laissé la veille pour préremplir le fond de départ.
create function public.cash_closing_get(p_day date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  d   date := coalesce(p_day, public.service_day());
  c   public.cash_closings;
  prev numeric;
begin
  perform public._member();
  if d <> public.service_day() and not public.can('caisse') then
    raise exception 'Seuls le gérant et les responsables de la caisse ouvrent un autre jour.' using errcode = '42501';
  end if;
  select * into c from public.cash_closings where day = d;
  select float_end into prev from public.cash_closings where day < d and status = 'closed' and float_end is not null order by day desc limit 1;
  return jsonb_build_object(
    'day', d,
    'closing', case when c.id is null then null else to_jsonb(c) - 'updated_by' end,
    'previous_float', prev,
    'closed_by_name', (select first_name from public.profiles where id = c.closed_by),
    'can_edit', c.id is null or c.status = 'draft' or public.can('caisse'));
end $$;

-- Enregistrer (et clôturer si p_close) une fermeture. Renvoie la fermeture comme cash_closing_get.
create function public.save_cash_closing(p_day date, p jsonb, p_close boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me  uuid := public._member();
  d   date := coalesce(p_day, public.service_day());
  c   public.cash_closings;
  n   numeric;
  m   public.email_settings;
  v_body text;
begin
  if d <> public.service_day() and not public.can('caisse') then
    raise exception 'Seuls le gérant et les responsables de la caisse corrigent un autre jour.' using errcode = '42501';
  end if;
  select * into c from public.cash_closings where day = d;
  if c.status = 'closed' and not public.can('caisse') then
    raise exception 'La caisse de ce jour est déjà clôturée : demande au gérant ou à un responsable pour la corriger.' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p, '{}')) <> 'object' then
    raise exception 'Contenu illisible.' using errcode = 'P0001';
  end if;

  insert into public.cash_closings (day, z_number, z_total, z_covers, z_tickets, z_cash, z_card, z_meal, z_cheque, z_other,
                                    float_start, cash_counts, expenses, float_end, card_counted, meal_counted, cheque_counted, tips,
                                    note, updated_by)
    values (d, left(btrim(coalesce(p ->> 'z_number', '')), 40),
            nullif(p ->> 'z_total', '')::numeric, nullif(p ->> 'z_covers', '')::int, nullif(p ->> 'z_tickets', '')::int,
            nullif(p ->> 'z_cash', '')::numeric, nullif(p ->> 'z_card', '')::numeric, nullif(p ->> 'z_meal', '')::numeric,
            nullif(p ->> 'z_cheque', '')::numeric, nullif(p ->> 'z_other', '')::numeric,
            nullif(p ->> 'float_start', '')::numeric, coalesce(p -> 'cash_counts', '{}'),
            case when jsonb_typeof(p -> 'expenses') = 'array' then (
              select coalesce(jsonb_agg(jsonb_build_object('label', left(btrim(e ->> 'label'), 80), 'amount', round((e ->> 'amount')::numeric, 2))), '[]')
              from jsonb_array_elements(p -> 'expenses') e
              where btrim(coalesce(e ->> 'label', '')) <> '' and coalesce(e ->> 'amount', '') ~ '^\d+(\.\d+)?$') else '[]' end,
            nullif(p ->> 'float_end', '')::numeric, nullif(p ->> 'card_counted', '')::numeric,
            nullif(p ->> 'meal_counted', '')::numeric, nullif(p ->> 'cheque_counted', '')::numeric, nullif(p ->> 'tips', '')::numeric,
            left(btrim(coalesce(p ->> 'note', '')), 1000), me)
    on conflict (day) do update
      set z_number = excluded.z_number, z_total = excluded.z_total, z_covers = excluded.z_covers, z_tickets = excluded.z_tickets,
          z_cash = excluded.z_cash, z_card = excluded.z_card, z_meal = excluded.z_meal, z_cheque = excluded.z_cheque, z_other = excluded.z_other,
          float_start = excluded.float_start, cash_counts = excluded.cash_counts, expenses = excluded.expenses, float_end = excluded.float_end,
          card_counted = excluded.card_counted, meal_counted = excluded.meal_counted, cheque_counted = excluded.cheque_counted,
          tips = excluded.tips, note = excluded.note, updated_by = excluded.updated_by
    returning * into c;

  if coalesce(p_close, false) then
    if c.z_total is null or c.z_cash is null or c.z_card is null then
      raise exception 'Recopie le ticket Z : CA TTC, espèces et carte bancaire.' using errcode = 'P0001';
    end if;
    if c.cash_counted is null or c.float_start is null or c.float_end is null then
      raise exception 'Compte les espèces et indique le fond de caisse de départ et celui laissé pour demain.' using errcode = 'P0001';
    end if;
    if c.card_counted is null then
      raise exception 'Indique le total du ticket de fin de journée du terminal CB.' using errcode = 'P0001';
    end if;
    if c.float_end > c.cash_counted then
      raise exception 'Le fond laissé pour demain est plus grand que les espèces comptées.' using errcode = 'P0001';
    end if;
    n := greatest(abs(coalesce(c.cash_gap, 0)), abs(coalesce(c.card_gap, 0)), abs(coalesce(c.meal_gap, 0)), abs(coalesce(c.cheque_gap, 0)));
    if n > 2 and c.note = '' then
      raise exception 'Il y a un écart de plus de 2 € : explique-le dans la note avant de clôturer.' using errcode = 'P0001';
    end if;
    update public.cash_closings set status = 'closed', closed_by = coalesce(closed_by, me), closed_at = coalesce(closed_at, now())
      where id = c.id returning * into c;

    -- E-mail au gérant : jamais bloquant.
    begin
      select * into m from public.email_settings;
      if m.enabled and m.notify_closing and m.notify_email <> '' then
        v_body := 'Caisse fermée par ' || coalesce((select first_name from public.profiles where id = c.closed_by), 'l''équipe') || '.'
          || E'\n\nCA TTC : ' || public._eur(c.z_total)
          || coalesce(' · ' || c.z_covers || ' couverts', '')
          || case when coalesce(c.z_covers, 0) > 0 then ' · ticket moyen ' || public._eur(c.z_total / c.z_covers) else '' end
          || E'\nEspèces ' || public._eur(c.z_cash) || ' · CB ' || public._eur(c.z_card)
          || coalesce(' · titres-restaurant ' || public._eur(c.z_meal), '') || coalesce(' · chèques ' || public._eur(c.z_cheque), '')
          || E'\n\nÉcart espèces : ' || public._eur(coalesce(c.cash_gap, 0), true)
          || ' · écart CB : ' || public._eur(coalesce(c.card_gap, 0), true)
          || E'\nRemise en banque : ' || public._eur(coalesce(c.bank_deposit, 0))
          || ' · fond laissé : ' || public._eur(c.float_end)
          || case when c.note <> '' then E'\n\nNote : ' || c.note else '' end
          || E'\n\n[[Voir la fermeture|' || m.app_url || '#/caisse?j=' || c.day || ']]';
        perform public._email_queue('fermeture_caisse', m.notify_email,
          case when n > 2 then 'Écart de caisse, ' else 'Caisse du ' end || public._fr_day(c.day) || ' : ' || public._eur(c.z_total) || ' TTC', v_body);
      end if;
    exception when others then
      null;
    end;
  end if;
  return public.cash_closing_get(d);
end $$;

-- ---------- Photo du Z -----------------------------------------------------------------------
-- Déposer (ou remplacer) la photo du Z d'un jour : comme pour la fermeture, le jour même pour l'équipe.
create function public.set_closing_photo(p_day date, p_mime text, p_data text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  d  date := coalesce(p_day, public.service_day());
  v_id uuid;
  st text;
begin
  perform public._member();
  if d <> public.service_day() and not public.can('caisse') then
    raise exception 'Seuls le gérant et les responsables de la caisse corrigent un autre jour.' using errcode = '42501';
  end if;
  select c.id, c.status into v_id, st from public.cash_closings c where c.day = d;
  if v_id is null then
    insert into public.cash_closings (day, updated_by) values (d, public.my_profile_id()) returning cash_closings.id into v_id;
  elsif st = 'closed' and not public.can('caisse') then
    raise exception 'La caisse de ce jour est déjà clôturée.' using errcode = '42501';
  end if;
  if coalesce(p_data, '') = '' then
    delete from public.cash_closing_photos where closing_id = v_id;
    update public.cash_closings set has_photo = false where cash_closings.id = v_id;
    return;
  end if;
  if p_mime not in ('image/jpeg', 'image/png', 'image/webp') or length(p_data) > 820000 or p_data !~ '^[A-Za-z0-9+/=]+$' then
    raise exception 'Photo refusée : JPEG, PNG ou WebP de 600 ko au plus.' using errcode = 'P0001';
  end if;
  insert into public.cash_closing_photos (closing_id, mime, data) values (v_id, p_mime, p_data)
    on conflict (closing_id) do update set mime = excluded.mime, data = excluded.data, created_at = now();
  update public.cash_closings set has_photo = true where cash_closings.id = v_id;
end $$;

-- La photo du Z : l'équipe pour le jour même ; le gérant, l'accès « Caisse » et la comptable pour tous les jours.
create function public.closing_photo(p_day date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r record;
begin
  if not (public.can('caisse') or public.is_accountant() or (public.my_profile_id() is not null and p_day = public.service_day())) then
    raise exception 'Accès refusé.' using errcode = '42501';
  end if;
  select ph.mime, ph.data into r from public.cash_closing_photos ph join public.cash_closings c on c.id = ph.closing_id where c.day = p_day;
  if not found then return null; end if;
  return jsonb_build_object('mime', r.mime, 'data', r.data);
end $$;

-- ---------- Chiffres par semaine, pour l'onglet « Saisie hebdo » du tableau de bord ----------
-- Appelé par le script Google avec la clé des mercuriales : les semaines terminées (lundi au dimanche)
-- qui ont au moins une fermeture clôturée. CB : le total du terminal compté, sinon celui du Z.
create function public.closings_weekly(p_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.merc_sync;
begin
  select * into s from public.merc_sync;
  if s.key_hash is null or coalesce(p_key, '') = '' or sha256(convert_to(p_key, 'UTF8')) <> s.key_hash then
    return jsonb_build_object('ok', false, 'error', 'key');
  end if;
  return jsonb_build_object('ok', true, 'weeks', coalesce((
    select jsonb_agg(jsonb_build_object('week', w.week, 'ca_ttc', w.ca, 'card', w.card, 'covers', w.covers, 'days', w.days) order by w.week)
    from (
      select date_trunc('week', day)::date as week, sum(z_total) as ca, sum(coalesce(card_counted, z_card)) as card,
             sum(z_covers) as covers, count(*) as days
      from public.cash_closings
      where status = 'closed' and day >= (now() at time zone 'Europe/Paris')::date - 400
      group by 1
      having date_trunc('week', max(day))::date + 6 < public.service_day()
    ) w), '[]'::jsonb));
end $$;

-- ---------- Droits ------------------------------------------------------------------------
revoke all on function public._eur(numeric, boolean), public._cash_total(jsonb), public._closing_calc(), public.cash_closing_get(date),
  public.save_cash_closing(date, jsonb, boolean), public.set_closing_photo(date, text, text), public.closing_photo(date),
  public.closings_weekly(text)
  from public, anon, authenticated;
-- La fermeture du jour se fait aussi sur l'iPad avec le code PIN (rôle anon).
grant execute on function public.cash_closing_get(date), public.save_cash_closing(date, jsonb, boolean),
  public.set_closing_photo(date, text, text), public.closing_photo(date) to anon, authenticated;
-- Le script Google appelle avec la clé publique de l'appli, puis la clé de synchronisation.
grant execute on function public.closings_weekly(text) to anon, authenticated;

commit;
