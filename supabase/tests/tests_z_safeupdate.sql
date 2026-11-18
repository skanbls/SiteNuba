-- Supabase charge pg_safeupdate pour les demandes de l'appli : un UPDATE ou un DELETE sans WHERE
-- y est refusé, même dans une fonction. Ce banc ne le charge pas : on vérifie donc le texte des fonctions.
-- Pour tout modifier ou tout supprimer, écrire « where true » (ou la clé de la ligne unique).
\set ON_ERROR_STOP on
reset role;
do $$
declare bad text;
begin
  select string_agg(p.proname || ' : ' || left(btrim(regexp_replace(s, '\s+', ' ', 'g')), 120), E'\n') into bad
  from pg_proc p
  cross join lateral regexp_split_to_table(p.prosrc, ';') s
  where p.pronamespace = 'public'::regnamespace
    and s ~* '(^|\s)(update\s+public\.\w+(\s+\w+)?\s+set\s|delete\s+from\s+public\.\w+)'
    and s !~* '\mwhere\M';
  if bad is not null then
    raise exception 'Supabase refuse UPDATE et DELETE sans WHERE (pg_safeupdate) :%', E'\n' || bad;
  end if;
end $$;
