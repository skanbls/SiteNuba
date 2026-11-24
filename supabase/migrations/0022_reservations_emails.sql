-- =====================================================================
-- Nuba Gestion · migration 0022 · réservations : demandes à valider, confirmations, rappels,
-- e-mails au logo de la Nuba
--
-- À exécuter une seule fois dans Supabase, après la 0021 :
--   SQL Editor > New query > coller tout ce fichier > Run.
-- Supabase doit répondre « Success. No rows returned ».
-- Tout passe ou rien ne passe : en cas d'erreur, la base reste comme avant.
--
-- 1. Demande à valider : au-delà d'un nombre de personnes choisi par l'équipe, une réservation
--    en ligne devient une demande. Le client reçoit « demande reçue », puis « confirmée »
--    (ou un refus poli) quand l'équipe répond. Une demande garde sa place dans le créneau.
-- 2. Réservation prise par l'équipe (téléphone, sur place…) : e-mail de confirmation au client
--    quand on note son adresse, et e-mail quand elle change de jour, d'heure ou de nombre.
-- 3. Rappel la veille par e-mail, entre 10 h et 20 h, par une tâche planifiée de Supabase (pg_cron).
-- 4. Tous les e-mails partent en version mise en page, avec le logo de la Nuba
--    (image email-logo.png de l'appli), et toujours en texte simple pour les messageries qui l'exigent.
-- Les fonctions utilisées par le site web (booking_info, booking_slots, book_table) gardent leur forme ;
-- book_table rend en plus « status » : confirmed ou pending.
-- =====================================================================
begin;

do $$ begin
  if to_regprocedure('public._email_queue(text, text, text, text)') is null or to_regclass('public.reservations') is null then
    raise exception 'Il manque une mise à jour plus ancienne. Exécute d''abord : 0007 (réservations) et 0010 (administration), puis relance celle-ci (0022).';
  end if;
end $$;

-- ---------- Statuts, réglages ---------------------------------------------------------
alter table public.reservations drop constraint reservations_status_check;
alter table public.reservations add constraint reservations_status_check
  check (status in ('pending', 'confirmed', 'seated', 'no_show', 'cancelled', 'declined'));
-- Liens envoyés par e-mail (rappel, confirmation…) : leur empreinte, en plus du code de la réservation en ligne.
alter table public.reservations add column link_hashes bytea[] not null default '{}';
alter table public.reservations add column reminded_at timestamptz;
-- À partir de combien de personnes une réservation en ligne doit être validée par l'équipe (vide : jamais).
alter table public.booking_settings add column review_from smallint check (review_from is null or review_from between 1 and 50);
alter table public.email_settings add column remind_booking boolean not null default true;

-- ---------- E-mails mis en page, avec le logo ------------------------------------------
-- Le texte d'un e-mail peut contenir un bouton : une ligne « [[Libellé|https://…]] ».
-- Version texte : le bouton devient « Libellé : lien ».
create function public._email_text(p_body text) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(coalesce(p_body, ''), '\[\[([^|\]]+)\|(https?://[^\]\s]+)\]\]', '\1 : \2', 'g')
$$;

create function public._email_html(p_title text, p_body text, p_app text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  esc  text := replace(replace(replace(replace(coalesce(p_body, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;');
  app  text := replace(replace(replace(coalesce(p_app, ''), '"', ''), '<', ''), '>', '');
  para text;
  html text := '';
begin
  -- Boutons, puis liens simples (ceux qui ne sont pas déjà dans un bouton).
  esc := regexp_replace(esc, '\[\[([^|\]]+)\|(https?://[^\]\s]+)\]\]',
    '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 20px"><tr><td style="background:#113F24;border-radius:10px">'
    || '<a href="\2" style="display:inline-block;padding:13px 22px;font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:bold;color:#F7EDE1;text-decoration:none">\1</a>'
    || '</td></tr></table>', 'g');
  esc := regexp_replace(esc, '(^|[\s(])(https?://[^\s<"]+)', '\1<a href="\2" style="color:#113F24">\2</a>', 'g');
  foreach para in array regexp_split_to_array(esc, '\n[ \t]*\n') loop
    if btrim(para, E' \n\t') <> '' then
      html := html || case when btrim(para, E' \n\t') like '<table%' then btrim(para, E' \n\t')
                           else '<p style="margin:0 0 16px">' || replace(btrim(para, E' \n\t'), E'\n', '<br>') || '</p>' end;
    end if;
  end loop;
  return '<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    || '<title>' || replace(replace(coalesce(p_title, ''), '<', '&lt;'), '>', '&gt;') || '</title></head>'
    || '<body style="margin:0;padding:0;background:#F7EDE1">'
    || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7EDE1"><tr><td align="center" style="padding:20px 12px">'
    || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e4d5c1;border-radius:16px">'
    || '<tr><td align="center" style="padding:20px 24px 8px;background:#F7EDE1;border-radius:16px 16px 0 0">'
    || '<img src="' || app || 'email-logo.png" width="240" alt="La Nuba, resto, bar, culturel" style="display:block;width:240px;max-width:80%;height:auto;border:0"></td></tr>'
    || '<tr><td style="padding:28px 28px 12px;font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:1.55;color:#0e2416">' || html || '</td></tr>'
    || '<tr><td style="padding:14px 28px 22px;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:#5e6553;border-top:1px solid #efe1ce">'
    || 'La Nuba · Resto, bar, culturel · Toulouse</td></tr>'
    || '</table></td></tr></table></body></html>';
end $$;

-- Même rôle que dans la 0010 ; en plus, la version mise en page avec le logo.
create or replace function public._email_queue(p_kind text, p_to text, p_subject text, p_body text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  s     public.email_settings;
  v_id  bigint;
  v_key text;
  v_req bigint;
  v_err text := '';
  v_sub text := left(regexp_replace(coalesce(p_subject, ''), '[\r\n]+', ' ', 'g'), 200);
  v_txt text := public._email_text(p_body);
begin
  select * into s from public.email_settings;
  if not s.enabled or s.sender_email = '' then return false; end if;
  if coalesce(p_to, '') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then return false; end if;

  delete from public.email_outbox where created_at < now() - interval '60 days';
  insert into public.email_outbox (kind, to_email, subject, body)
    values (p_kind, lower(p_to), v_sub, v_txt)
    returning id into v_id;

  if (select count(*) from public.email_outbox where created_at > now() - interval '24 hours') > 250 then
    v_err := 'Plafond de 250 e-mails par jour atteint.';
  elsif to_regprocedure('net.http_post(text, jsonb, jsonb, jsonb, integer)') is null then
    v_err := 'L''extension pg_net n''est pas activée dans Supabase.';
  elsif to_regclass('vault.decrypted_secrets') is null then
    v_err := 'Le coffre (Vault) n''est pas activé dans Supabase.';
  else
    begin
      execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1' into v_key using 'brevo_api_key';
      if coalesce(btrim(v_key), '') = '' then
        v_err := 'La clé de Brevo n''est pas dans le coffre de Supabase (nom attendu : brevo_api_key).';
      else
        execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 10000)' into v_req
          using 'https://api.brevo.com/v3/smtp/email',
                jsonb_build_object(
                  'sender', jsonb_build_object('name', s.sender_name, 'email', s.sender_email),
                  'to', jsonb_build_array(jsonb_build_object('email', lower(p_to))),
                  'subject', v_sub,
                  'textContent', v_txt,
                  'htmlContent', public._email_html(v_sub, p_body, s.app_url)),
                jsonb_build_object('api-key', btrim(v_key), 'Content-Type', 'application/json', 'Accept', 'application/json');
      end if;
    exception when others then
      v_err := left(sqlerrm, 300);
    end;
  end if;

  update public.email_outbox
    set status = case when v_err = '' then 'sent' else 'failed' end, request_id = v_req, error = v_err
    where id = v_id;
  return v_err = '';
exception when others then
  return false;
end $$;

-- ---------- Liens et e-mails aux clients ----------------------------------------------
-- Nouveau lien « voir ou annuler » pour une réservation : seule son empreinte est gardée.
create function public._booking_link(p_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_code text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 20);
  m      public.email_settings;
begin
  select * into m from public.email_settings;
  update public.reservations set link_hashes = array_append(link_hashes, sha256(convert_to(v_code, 'UTF8'))) where id = p_id;
  return m.app_url || '#/reservation?r=' || p_id || '&c=' || v_code;
end $$;

-- L'e-mail d'une réservation au client. p_kind : confirmation, demande, acceptee, refusee, modification, rappel.
create function public._client_mail(p_kind text, p_id uuid, p_link text, p_message text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  r     public.reservations;
  m     public.email_settings;
  bs    public.booking_settings;
  v_when text;
  v_sub  text;
  v_body text;
  v_btn  text;
  v_tail text;
  v_msg  text := btrim(coalesce(p_message, ''));
begin
  select * into r from public.reservations where id = p_id;
  if not found or r.email = '' then return false; end if;
  select * into m from public.email_settings;
  select * into bs from public.booking_settings;
  v_when := public._fr_day(r.day) || ' à ' || public._fr_time(r.slot) || ', pour ' || r.party
            || case when r.party > 1 then ' personnes' else ' personne' end;
  v_btn := case when coalesce(p_link, '') = '' then ''
                else E'\n\n[[' || case when p_kind = 'demande' then 'Voir ou annuler ma demande' else 'Voir ou annuler ma réservation' end || '|' || p_link || ']]' end;
  v_tail := case when bs.phone <> '' then E'\n\nUne question ? Appelez-nous au ' || bs.phone || '.' else '' end
            || E'\n\nÀ bientôt,\n' || m.signature;
  case p_kind
    when 'confirmation' then
      v_sub := 'Votre réservation à la Nuba, ' || public._fr_day(r.day) || ' à ' || public._fr_time(r.slot);
      v_body := 'Bonjour ' || left(r.name, 80) || E',\n\nVotre table est réservée à la Nuba :\n' || v_when || '.' || v_btn || v_tail;
    when 'demande' then
      v_sub := 'Votre demande de réservation à la Nuba';
      v_body := 'Bonjour ' || left(r.name, 80) || E',\n\nNous avons bien reçu votre demande de réservation :\n' || v_when || '.'
        || E'\n\nElle n''est pas encore confirmée : l''équipe vous répond très vite par e-mail.' || v_btn || v_tail;
    when 'acceptee' then
      v_sub := 'Votre réservation est confirmée : ' || public._fr_day(r.day) || ' à ' || public._fr_time(r.slot);
      v_body := 'Bonjour ' || left(r.name, 80) || E',\n\nBonne nouvelle : votre réservation est confirmée.\n' || v_when || '.'
        || case when v_msg <> '' then E'\n\n' || v_msg else '' end || v_btn || v_tail;
    when 'refusee' then
      v_sub := 'Votre demande de réservation à la Nuba';
      v_body := 'Bonjour ' || left(r.name, 80) || E',\n\nNous sommes désolés : nous ne pouvons pas vous accueillir '
        || public._fr_day(r.day) || ' à ' || public._fr_time(r.slot) || ' pour ' || r.party || case when r.party > 1 then ' personnes.' else ' personne.' end
        || case when v_msg <> '' then E'\n\n' || v_msg else '' end
        || case when bs.phone <> '' then E'\n\nAppelez-nous au ' || bs.phone || ' : nous trouverons peut-être une autre solution ensemble.' else '' end
        || E'\n\nÀ bientôt,\n' || m.signature;
    when 'modification' then
      v_sub := 'Votre réservation à la Nuba a changé : ' || public._fr_day(r.day) || ' à ' || public._fr_time(r.slot);
      v_body := 'Bonjour ' || left(r.name, 80) || E',\n\nVotre réservation a été modifiée. La voici :\n' || v_when || '.' || v_btn || v_tail;
    when 'rappel' then
      v_sub := 'À demain à la Nuba !';
      v_body := 'Bonjour ' || left(r.name, 80) || E',\n\nNous vous attendons demain, ' || v_when || '.'
        || E'\n\nUn empêchement ? Prévenez-nous : la table fera plaisir à d''autres.' || v_btn || v_tail;
    else
      return false;
  end case;
  -- « reservation » : le nom déjà utilisé par la confirmation en ligne dans le journal des e-mails.
  return public._email_queue(case when p_kind = 'confirmation' then 'reservation' else 'client_' || p_kind end, r.email, v_sub, v_body);
exception when others then
  return false;
end $$;

-- ---------- Créneaux : une demande garde sa place ---------------------------------------
create or replace function public._booking_slots(p_day date, p_party int) returns setof time
language sql stable security definer set search_path = '' as $$
  select t::time
  from public.booking_settings s
  join public.opening_hours h on h.weekday = extract(isodow from p_day)::int and h.open
  cross join lateral generate_series(p_day + h.first_slot, p_day + h.last_slot, make_interval(mins => s.slot_minutes)) t
  where s.online_enabled
    and p_party between 1 and s.max_party_online
    and p_day <= (now() at time zone 'Europe/Paris')::date + s.max_days_ahead
    and t >= (now() at time zone 'Europe/Paris') + make_interval(mins => s.min_lead_minutes)
    and (h.break_from is null or t::time < h.break_from or t::time >= h.break_to)
    and (s.capacity_per_slot is null or p_party + coalesce((
          select sum(r.party) from public.reservations r
          where r.day = p_day and r.slot = t::time and r.status in ('pending', 'confirmed', 'seated')), 0) <= s.capacity_per_slot)
  order by t
$$;

-- Ce que la page publique a besoin de savoir ; en plus : à partir de combien de personnes on valide.
create or replace function public.booking_info() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'online_enabled', s.online_enabled, 'max_party_online', s.max_party_online, 'max_days_ahead', s.max_days_ahead,
    'phone', s.phone, 'notice', s.notice,
    'today', (now() at time zone 'Europe/Paris')::date,
    'open_weekdays', (select coalesce(jsonb_agg(weekday order by weekday), '[]'::jsonb) from public.opening_hours where open),
    'review_from', s.review_from)
  from public.booking_settings s
$$;

-- ---------- Réserver en ligne -----------------------------------------------------------
-- Comme avant ; au-delà du seuil, la réservation est une demande (status « pending »).
-- Renvoie {ok:true, id, code, emailed, status} ou {ok:false, error}.
create or replace function public.book_table(p_day date, p_slot time, p_party int, p_name text, p_phone text, p_email text, p_note text, p_trap text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s      public.booking_settings;
  m      public.email_settings;
  v_id   uuid;
  v_code text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 20);
  tel    text := regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g');
  mail   text := lower(btrim(coalesce(p_email, '')));
  v_st   text;
  v_sent boolean := false;
begin
  select * into s from public.booking_settings;
  if not s.online_enabled then return jsonb_build_object('ok', false, 'error', 'disabled'); end if;
  if length(coalesce(p_trap, '')) > 0 then return jsonb_build_object('ok', false, 'error', 'contact'); end if;
  if length(btrim(coalesce(p_name, ''))) < 2 or length(tel) < 8 then return jsonb_build_object('ok', false, 'error', 'contact'); end if;
  if p_party is null or p_party < 1 or p_party > s.max_party_online then return jsonb_build_object('ok', false, 'error', 'party'); end if;

  -- Garde-fous contre les envois en rafale.
  if (select count(*) from public.reservations where source = 'en_ligne' and created_at > now() - interval '10 minutes') >= 20 then
    return jsonb_build_object('ok', false, 'error', 'too_many');
  end if;
  if (select count(*) from public.reservations
      where source = 'en_ligne' and phone = tel and status in ('pending', 'confirmed') and day >= (now() at time zone 'Europe/Paris')::date) >= 3 then
    return jsonb_build_object('ok', false, 'error', 'too_many_phone');
  end if;

  perform pg_advisory_xact_lock(7461002, (p_day - date '2020-01-01'));
  if not exists (select 1 from public._booking_slots(p_day, p_party) t where t = p_slot) then
    return jsonb_build_object('ok', false, 'error', 'slot');
  end if;

  v_st := case when s.review_from is not null and p_party >= s.review_from then 'pending' else 'confirmed' end;
  insert into public.reservations (day, slot, party, name, phone, email, note, source, code_hash, status)
    values (p_day, p_slot, p_party, btrim(p_name), tel, mail, left(btrim(coalesce(p_note, '')), 300),
            'en_ligne', sha256(convert_to(v_code, 'UTF8')), v_st)
    returning id into v_id;

  select * into m from public.email_settings;
  if m.confirm_booking and mail <> '' then
    v_sent := public._client_mail(case when v_st = 'pending' then 'demande' else 'confirmation' end, v_id,
                                  m.app_url || '#/reservation?r=' || v_id || '&c=' || v_code, '');
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'code', v_code, 'emailed', v_sent, 'status', v_st);
end $$;

-- La réservation d'un client, retrouvée par l'un de ses liens.
create or replace function public.my_booking(p_id uuid, p_code text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('day', r.day, 'slot', to_char(r.slot, 'HH24:MI'), 'party', r.party, 'name', r.name, 'status', r.status,
                            'phone', (select phone from public.booking_settings))
  from public.reservations r
  where r.id = p_id and (r.code_hash = sha256(convert_to(coalesce(p_code, ''), 'UTF8'))
                         or sha256(convert_to(coalesce(p_code, ''), 'UTF8')) = any (r.link_hashes))
$$;

-- Le client annule sa réservation ou sa demande avec l'un de ses liens.
create or replace function public.cancel_booking(p_id uuid, p_code text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update public.reservations set status = 'cancelled', updated_at = now()
    where id = p_id
      and (code_hash = sha256(convert_to(coalesce(p_code, ''), 'UTF8')) or sha256(convert_to(coalesce(p_code, ''), 'UTF8')) = any (link_hashes))
      and status in ('pending', 'confirmed') and day >= (now() at time zone 'Europe/Paris')::date;
  return found;
end $$;

-- ---------- Alerte à la Nuba : une demande à valider ------------------------------------
create or replace function public._reservation_mail() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  m     public.email_settings;
  v_who text;
begin
  select * into m from public.email_settings;
  if not m.enabled then return null; end if;
  v_who := left(new.name, 80) || ', ' || public._fr_day(new.day) || ' à ' || public._fr_time(new.slot) || ', '
           || new.party || case when new.party > 1 then ' personnes' else ' personne' end;

  if tg_op = 'INSERT' then
    if new.source = 'en_ligne' and m.notify_booking then
      perform public._email_queue('alerte_reservation', m.notify_email,
        case when new.status = 'pending' then 'Demande à valider : ' else 'Réservation en ligne : ' end || v_who,
        case when new.status = 'pending' then 'Nouvelle demande de réservation en ligne, à accepter ou refuser.' else 'Nouvelle réservation en ligne.' end
        || E'\n\n' || v_who || E'\n'
        || 'Téléphone : ' || new.phone || E'\n'
        || case when new.email <> '' then 'E-mail : ' || new.email || E'\n' else '' end
        || case when new.note <> '' then 'Mot du client : ' || new.note || E'\n' else '' end
        || E'\n[[' || case when new.status = 'pending' then 'Répondre à la demande' else 'Voir les réservations' end || '|' || m.app_url || '#/reservations]]');
    end if;
  elsif new.status = 'cancelled' and old.status <> 'cancelled' and new.day >= (now() at time zone 'Europe/Paris')::date then
    if m.confirm_booking and new.email <> '' then
      perform public._email_queue('annulation', new.email, 'Votre réservation à la Nuba est annulée',
        'Bonjour ' || left(new.name, 80) || ',' || E'\n\n'
        || 'Votre ' || case when old.status = 'pending' then 'demande de réservation' else 'réservation' end
        || ' du ' || public._fr_day(new.day) || ' à ' || public._fr_time(new.slot) || ' est annulée.' || E'\n\n'
        || 'À bientôt,' || E'\n' || m.signature);
    end if;
    -- Sans personne de l'équipe derrière l'action, c'est le client qui a annulé avec son lien.
    if public.my_profile_id() is null and m.notify_booking then
      perform public._email_queue('alerte_annulation', m.notify_email, 'Annulation par le client : ' || v_who,
        'Le client a annulé sa ' || case when old.status = 'pending' then 'demande' else 'réservation' end || '.' || E'\n\n' || v_who || E'\n' || 'Téléphone : ' || new.phone);
    end if;
  end if;
  return null;
exception when others then
  return null;
end $$;

-- ---------- L'équipe accepte ou refuse une demande --------------------------------------
create function public.decide_booking(p_id uuid, p_accept boolean, p_message text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  m public.email_settings;
begin
  perform public._member();
  update public.reservations set status = case when p_accept then 'confirmed' else 'declined' end, updated_at = now()
    where id = p_id and status = 'pending';
  if not found then raise exception 'Cette demande a déjà reçu une réponse.' using errcode = 'P0001'; end if;
  select * into m from public.email_settings;
  if m.confirm_booking then
    perform public._client_mail(case when p_accept then 'acceptee' else 'refusee' end, p_id,
                                case when p_accept then public._booking_link(p_id) else '' end, left(coalesce(p_message, ''), 600));
  end if;
end $$;

-- ---------- L'équipe ajoute ou modifie une réservation, et prévient le client ------------
-- Comme save_reservation de la 0007, avec p_notify : e-mail de confirmation (ajout)
-- ou de modification (jour, heure ou nombre changés), si le client a une adresse.
create function public.save_reservation(
  p_id uuid, p_day date, p_slot time, p_party int, p_name text, p_phone text, p_email text, p_note text, p_source text, p_table text,
  p_notify boolean
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me_id uuid := public._member();
  v_id  uuid := p_id;
  old   public.reservations;
  m     public.email_settings;
  mail  text := lower(btrim(coalesce(p_email, '')));
begin
  if p_day is null or p_slot is null then raise exception 'Indique le jour et l''heure.' using errcode = 'P0001'; end if;
  if p_party is null or p_party < 1 then raise exception 'Indique le nombre de personnes.' using errcode = 'P0001'; end if;
  if length(btrim(coalesce(p_name, ''))) = 0 then raise exception 'Indique le nom du client.' using errcode = 'P0001'; end if;
  if v_id is null then
    insert into public.reservations (day, slot, party, name, phone, email, note, source, table_label, created_by)
      values (p_day, p_slot, p_party, btrim(p_name), btrim(coalesce(p_phone, '')), mail,
              btrim(coalesce(p_note, '')), coalesce(nullif(p_source, ''), 'telephone'), btrim(coalesce(p_table, '')), me_id)
      returning id into v_id;
  else
    select * into old from public.reservations where id = v_id;
    if not found then raise exception 'Réservation introuvable.' using errcode = 'P0001'; end if;
    update public.reservations
      set day = p_day, slot = p_slot, party = p_party, name = btrim(p_name), phone = btrim(coalesce(p_phone, '')),
          email = mail, note = btrim(coalesce(p_note, '')),
          table_label = btrim(coalesce(p_table, '')), updated_at = now()
      where id = v_id;
  end if;

  if coalesce(p_notify, false) and mail <> '' and p_day >= (now() at time zone 'Europe/Paris')::date then
    select * into m from public.email_settings;
    if m.confirm_booking then
      if p_id is null then
        perform public._client_mail('confirmation', v_id, public._booking_link(v_id), '');
      elsif old.status in ('confirmed', 'pending')
            and (old.day <> p_day or old.slot <> p_slot or old.party <> p_party or old.email <> mail) then
        perform public._client_mail(case when old.status = 'pending' then 'demande' else 'modification' end, v_id, public._booking_link(v_id), '');
      end if;
    end if;
  end if;
  return v_id;
end $$;

-- ---------- Rappel la veille --------------------------------------------------------------
-- Envoie le rappel des réservations du lendemain, entre 10 h et 20 h (heure de Paris), une seule fois.
-- Pas de rappel pour une réservation faite moins de 12 heures avant. Renvoie le nombre d'e-mails partis.
create function public.send_booking_reminders(p_now timestamptz default now()) returns int
language plpgsql security definer set search_path = '' as $$
declare
  m    public.email_settings;
  r    record;
  n    int := 0;
  here timestamp := p_now at time zone 'Europe/Paris';
begin
  select * into m from public.email_settings;
  if not m.enabled or not m.remind_booking or here::time < time '10:00' or here::time >= time '20:00' then return 0; end if;
  for r in
    select id from public.reservations
    where day = here::date + 1 and status = 'confirmed' and email <> '' and reminded_at is null
      and created_at < p_now - interval '12 hours'
    order by slot
    limit 200
  loop
    update public.reservations set reminded_at = p_now where id = r.id;
    if public._client_mail('rappel', r.id, public._booking_link(r.id), '') then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- Les rappels sont-ils planifiés ? Pour l'écran des e-mails du gérant.
create function public.reminders_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_job boolean := false;
begin
  if not public.is_gerant() then
    raise exception 'Réservé au gérant.' using errcode = '42501';
  end if;
  if to_regclass('cron.job') is not null then
    execute 'select exists (select 1 from cron.job where jobname = $1)' into v_job using 'nuba-rappels-reservations';
  end if;
  return jsonb_build_object('scheduled', v_job,
    'sent_today', (select count(*) from public.email_outbox where kind = 'client_rappel' and created_at > now() - interval '24 hours'));
end $$;

-- Tâche planifiée : toutes les heures, à la 5e minute. Si pg_cron n'est pas disponible, la mise à jour passe quand même :
-- l'écran des e-mails dit comment l'activer, puis le gérant touche « Planifier les rappels ».
create function public._schedule_booking_reminders() returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if to_regclass('cron.job') is null then
    begin
      create extension if not exists pg_cron with schema pg_catalog;
    exception when others then
      begin
        create extension if not exists pg_cron;
      exception when others then
        null;
      end;
    end;
  end if;
  if to_regclass('cron.job') is null then return false; end if;
  execute 'select cron.schedule($1, $2, $3)' using 'nuba-rappels-reservations', '5 * * * *', 'select public.send_booking_reminders()';
  return true;
exception when others then
  return false;
end $$;

create function public.schedule_booking_reminders() returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_gerant() then
    raise exception 'Réservé au gérant.' using errcode = '42501';
  end if;
  return public._schedule_booking_reminders();
end $$;

do $$ begin
  perform public._schedule_booking_reminders();
end $$;

-- ---------- Droits ------------------------------------------------------------------------
revoke all on function public._email_text(text), public._email_html(text, text, text), public._booking_link(uuid),
  public._client_mail(text, uuid, text, text), public.send_booking_reminders(timestamptz), public.reminders_status(),
  public._schedule_booking_reminders(), public.schedule_booking_reminders(),
  public.decide_booking(uuid, boolean, text),
  public.save_reservation(uuid, date, time, int, text, text, text, text, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.decide_booking(uuid, boolean, text),
  public.save_reservation(uuid, date, time, int, text, text, text, text, text, text, boolean) to anon, authenticated;
grant execute on function public.reminders_status(), public.schedule_booking_reminders() to authenticated;

commit;
