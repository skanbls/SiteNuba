import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Field, Spinner } from '../components/ui';
import { appUrl, supabase } from '../lib/supabase';
import { addDays, dayKey, fromDayKey } from '../lib/time';
import type { BookingInfo } from '../lib/types';

/* Pages publiques, pour les clients : on les vouvoie, contrairement au reste de l'appli. */

const longDay = (k: string) => fromDayKey(k).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
const isoWeekday = (k: string) => ((fromDayKey(k).getDay() + 6) % 7) + 1;
const people = (n: number) => `${n} personne${n > 1 ? 's' : ''}`;
const unreachable = 'Connexion impossible pour le moment. Réessayez dans un instant, ou appelez-nous.';

const BOOK_ERROR: Record<string, string> = {
  slot: "Ce créneau vient d'être pris ou n'est plus disponible. Choisissez-en un autre.",
  contact: 'Indiquez votre nom et un numéro de téléphone valide.',
  party: 'Pour un groupe de cette taille, appelez-nous.',
  too_many: 'Trop de demandes en même temps. Réessayez dans quelques minutes, ou appelez-nous.',
  too_many_phone: 'Vous avez déjà plusieurs réservations à venir avec ce numéro. Appelez-nous pour en ajouter une.',
  disabled: "La réservation en ligne est fermée pour l'instant. Appelez-nous.",
};

function Phone({ phone }: { phone: string }) {
  return phone ? <a className="link" href={`tel:${phone.replace(/\s/g, '')}`}>{phone}</a> : <span>par téléphone</span>;
}

/** Réserver une table : page publique, ouverte par un lien ou intégrée dans le site web. */
export default function Booking() {
  const [info, setInfo] = useState<BookingInfo | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [party, setParty] = useState(2);
  const [big, setBig] = useState(false);
  const [day, setDay] = useState('');
  const [slots, setSlots] = useState<string[] | null>(null);
  const [slot, setSlot] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [trap, setTrap] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ id: string; code: string; emailed: boolean } | null>(null);

  useEffect(() => {
    document.title = 'Réserver une table · La Nuba';
    void supabase.rpc('booking_info').then(({ data, error }) => {
      if (error || !data) return setLoadErr(unreachable);
      setInfo(data as BookingInfo);
    });
  }, []);

  // Les quatorze prochains jours ; les jours de fermeture sont affichés mais inactifs.
  const days = useMemo(() => (info ? Array.from({ length: 14 }, (_, i) => dayKey(addDays(fromDayKey(info.today), i))) : []), [info]);
  const isOpen = (k: string) => !!info && info.open_weekdays.includes(isoWeekday(k));

  useEffect(() => {
    if (!day || big) return;
    let alive = true;
    setSlots(null);
    setSlot('');
    void supabase.rpc('booking_slots', { p_day: day, p_party: party }).then(({ data, error }) => {
      if (!alive) return;
      if (error) setErr(unreachable);
      else setSlots((data as string[] | null) ?? []);
    });
    return () => {
      alive = false;
    };
  }, [day, party, big]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!day || !slot) return setErr("Choisissez un jour et une heure.");
    setBusy(true);
    setErr('');
    const { data, error } = await supabase.rpc('book_table', { p_day: day, p_slot: slot, p_party: party, p_name: name, p_phone: phone, p_email: email, p_note: note, p_trap: trap });
    setBusy(false);
    if (error) return setErr(unreachable);
    const r = data as { ok: boolean; id?: string; code?: string; emailed?: boolean; error?: string };
    if (r.ok && r.id && r.code) return setDone({ id: r.id, code: r.code, emailed: !!r.emailed });
    setErr(BOOK_ERROR[r.error ?? ''] ?? 'La réservation n\'a pas pu être enregistrée.');
    if (r.error === 'slot') {
      setSlot('');
      const again = await supabase.rpc('booking_slots', { p_day: day, p_party: party });
      setSlots((again.data as string[] | null) ?? []);
    }
  }

  if (loadErr) return <div className="full"><div className="card wide"><h1>La Nuba</h1><p className="err" role="alert">{loadErr}</p></div></div>;
  if (!info) return <div className="full"><Spinner /></div>;

  if (done) {
    const link = `${appUrl()}#/reservation?r=${done.id}&c=${done.code}`;
    return (
      <div className="full">
        <div className="card wide">
          <div>
            <h1>C'est réservé</h1>
            <p className="sub">La Nuba vous attend.</p>
          </div>
          <div className="list">
            <div className="row"><div className="grow"><span className="sub">Quand</span><span className="t">{longDay(day)} à {slot.replace(':', ' h ')}</span></div></div>
            <div className="row"><div className="grow"><span className="sub">Pour</span><span className="t">{people(party)}, au nom de {name.trim()}</span></div></div>
          </div>
          <p>Un empêchement ? Annulez en un geste avec ce lien, à garder précieusement :</p>
          <a className="btn" href={link}>Voir ou annuler ma réservation</a>
          <p className="note">{done.emailed ? 'Une confirmation part à votre adresse e-mail, avec ce lien.' : 'Faites une capture d\'écran de cette page ou enregistrez le lien.'} Pour toute question, joignez-nous <Phone phone={info.phone} />.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="full">
      <form className="card wide" onSubmit={submit}>
        <div>
          <h1>Réserver une table</h1>
          <p className="sub">La Nuba, Toulouse{info.notice ? ` · ${info.notice}` : ''}</p>
        </div>

        {!info.online_enabled ? (
          <p>La réservation en ligne est fermée pour l'instant. Pour réserver, joignez-nous <Phone phone={info.phone} />.</p>
        ) : (
          <>
            <section className="sec">
              <span className="t">Combien serez-vous ?</span>
              <div className="chips" role="group" aria-label="Nombre de personnes" style={{ flexWrap: 'wrap', overflow: 'visible' }}>
                {Array.from({ length: info.max_party_online }, (_, i) => i + 1).map((n) => (
                  <button type="button" key={n} className="chip" aria-pressed={!big && party === n} onClick={() => { setBig(false); setParty(n); }} aria-label={people(n)}>{n}</button>
                ))}
                <button type="button" className="chip" aria-pressed={big} onClick={() => setBig(true)}>{info.max_party_online + 1} ou plus</button>
              </div>
            </section>

            {big ? (
              <p>À partir de {info.max_party_online + 1} personnes, nous préparons votre venue avec vous : joignez-nous <Phone phone={info.phone} />.</p>
            ) : (
              <>
                <section className="sec">
                  <span className="t">Quel jour ?</span>
                  <div className="chips" role="group" aria-label="Jour">
                    {days.map((k) => (
                      <button type="button" key={k} className="chip" aria-pressed={day === k} disabled={!isOpen(k)} onClick={() => setDay(k)} aria-label={longDay(k) + (isOpen(k) ? '' : ', fermé')}>
                        {fromDayKey(k).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' })}
                      </button>
                    ))}
                  </div>
                  <Field label="Ou une autre date">
                    <input className="in" id="book-day" type="date" value={day} min={info.today} max={dayKey(addDays(fromDayKey(info.today), info.max_days_ahead))} onChange={(e) => setDay(e.target.value)} />
                  </Field>
                </section>

                {day && (
                  <section className="sec">
                    <span className="t">À quelle heure ?</span>
                    {!slots ? <Spinner /> : slots.length === 0 ? (
                      <p className="note">{isOpen(day) ? "Plus de créneau disponible ce jour-là. Essayez un autre jour, ou appelez-nous." : 'Nous sommes fermés ce jour-là.'}</p>
                    ) : (
                      <div className="slots" role="group" aria-label="Heure">
                        {slots.map((t) => (<button type="button" key={t} className="chip" aria-pressed={slot === t} onClick={() => setSlot(t)}>{t}</button>))}
                      </div>
                    )}
                  </section>
                )}

                {slot && (
                  <section className="form">
                    <span className="t">Vos coordonnées</span>
                    <Field label="Nom">
                      <input className="in" id="book-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required maxLength={80} />
                    </Field>
                    <Field label="Téléphone" hint="Pour vous prévenir en cas d'imprévu.">
                      <input className="in" id="book-phone" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" required maxLength={30} />
                    </Field>
                    <Field label="Adresse e-mail" hint="Facultative.">
                      <input className="in" id="book-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" maxLength={120} />
                    </Field>
                    <Field label="Un mot pour l'équipe" hint="Facultatif : allergie, anniversaire, poussette…">
                      <input className="in" id="book-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
                    </Field>
                    {/* Champ piège, invisible : seuls les robots le remplissent. */}
                    <div aria-hidden="true" style={{ position: 'absolute', left: -9999, width: 1, height: 1, overflow: 'hidden' }}>
                      <label>Site web<input tabIndex={-1} autoComplete="off" value={trap} onChange={(e) => setTrap(e.target.value)} /></label>
                    </div>
                    <button className="btn pri block" disabled={busy}>{busy ? <Spinner /> : `Réserver pour ${people(party)}, ${fromDayKey(day).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })} à ${slot}`}</button>
                    <p className="note">Vos coordonnées servent uniquement à gérer cette réservation. Seule l'équipe de la Nuba y a accès.</p>
                  </section>
                )}
              </>
            )}
          </>
        )}
        {err && <p className="err" role="alert">{err}</p>}
      </form>
    </div>
  );
}

/** Voir ou annuler sa réservation, avec le lien reçu à la confirmation. */
export function BookingManage() {
  const [params] = useSearchParams();
  const id = params.get('r') ?? '';
  const code = params.get('c') ?? '';
  const [b, setB] = useState<{ day: string; slot: string; party: number; name: string; status: string; phone: string } | null | undefined>(undefined);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    document.title = 'Ma réservation · La Nuba';
    void supabase.rpc('my_booking', { p_id: id, p_code: code }).then(({ data, error }) => setB(error ? null : ((data as typeof b) ?? null)));
  }, [id, code]);

  async function cancel() {
    setBusy(true);
    const { data, error } = await supabase.rpc('cancel_booking', { p_id: id, p_code: code });
    setBusy(false);
    if (error || !data) return setErr("L'annulation n'a pas pu être enregistrée. Appelez-nous.");
    setB((x) => (x ? { ...x, status: 'cancelled' } : x));
  }

  if (b === undefined) return <div className="full"><Spinner /></div>;
  return (
    <div className="full">
      <div className="card wide">
        {!b ? (
          <>
            <h1>Réservation introuvable</h1>
            <p>Ce lien ne correspond à aucune réservation. Vérifiez que vous l'avez copié en entier.</p>
          </>
        ) : (
          <>
            <div>
              <h1>{b.status === 'cancelled' ? 'Réservation annulée' : 'Votre réservation'}</h1>
              <p className="sub">La Nuba, Toulouse</p>
            </div>
            <div className="list">
              <div className="row"><div className="grow"><span className="sub">Quand</span><span className="t">{longDay(b.day)} à {b.slot.replace(':', ' h ')}</span></div></div>
              <div className="row"><div className="grow"><span className="sub">Pour</span><span className="t">{people(b.party)}, au nom de {b.name}</span></div></div>
            </div>
            {b.status === 'cancelled' && <p>Votre réservation est bien annulée. À une prochaine fois.</p>}
            {b.status === 'confirmed' && (confirm ? (
              <div className="acts">
                <button type="button" className="btn" onClick={() => setConfirm(false)}>Je la garde</button>
                <button type="button" className="btn no" disabled={busy} onClick={() => void cancel()}>{busy ? <Spinner /> : 'Oui, annuler'}</button>
              </div>
            ) : <button type="button" className="btn no" onClick={() => setConfirm(true)}>Annuler ma réservation</button>)}
            {err && <p className="err" role="alert">{err}</p>}
            <p className="note">Pour modifier l'heure ou le nombre de personnes, joignez-nous <Phone phone={b.phone} />.</p>
            <a className="link" href={`${appUrl()}#/reserver`}>Faire une nouvelle réservation</a>
          </>
        )}
      </div>
    </div>
  );
}

const REQUEST_ERROR: Record<string, string> = {
  contact: 'Indiquez votre nom et un numéro de téléphone valide.',
  kind: "Choisissez le type d'événement.",
  day: 'Indiquez une date à venir.',
  guests: 'Indiquez le nombre de personnes.',
  too_many: 'Trop de demandes en même temps. Réessayez dans quelques minutes, ou appelez-nous.',
};

/** Demander une privatisation ou une prestation extérieure : page publique. */
export function EventRequest() {
  const [kind, setKind] = useState('privatisation');
  const [day, setDay] = useState('');
  const [guests, setGuests] = useState('');
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [trap, setTrap] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    document.title = 'Privatiser · La Nuba';
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    const { data, error } = await supabase.rpc('request_private_event', {
      p_kind: kind, p_day: day, p_guests: Number(guests), p_name: name, p_company: company, p_phone: phone, p_email: email, p_message: message, p_trap: trap,
    });
    setBusy(false);
    if (error) return setErr(unreachable);
    const r = data as { ok: boolean; error?: string };
    if (r.ok) return setDone(true);
    setErr(REQUEST_ERROR[r.error ?? ''] ?? "La demande n'a pas pu être envoyée.");
  }

  if (done)
    return (
      <div className="full">
        <div className="card wide">
          <div>
            <h1>Demande envoyée</h1>
            <p className="sub">La Nuba, Toulouse</p>
          </div>
          <p>Merci {name.trim()}. Nous avons bien reçu votre demande pour le {longDay(day)} et nous vous rappelons au {phone.trim()} pour en parler.</p>
          <p className="note">Votre date n'est pas encore réservée : elle le sera une fois le devis accepté.</p>
        </div>
      </div>
    );

  return (
    <div className="full">
      <form className="card wide" onSubmit={submit}>
        <div>
          <h1>Votre événement à la Nuba</h1>
          <p className="sub">Dites-nous ce que vous imaginez : nous vous rappelons avec une proposition.</p>
        </div>
        <Field label="Votre projet">
          <select className="in" id="pe-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="privatisation">Privatiser la Nuba (anniversaire, soirée, repas de groupe…)</option>
            <option value="exterieur">Une prestation chez vous (cocktail, traiteur, bar)</option>
          </select>
        </Field>
        <div className="two">
          <Field label="Date souhaitée"><input className="in" id="pe-day" type="date" value={day} min={dayKey(new Date())} onChange={(e) => setDay(e.target.value)} required /></Field>
          <Field label="Nombre de personnes"><input className="in" id="pe-guests" type="number" inputMode="numeric" min={1} max={2000} value={guests} onChange={(e) => setGuests(e.target.value)} required /></Field>
        </div>
        <Field label="Nom"><input className="in" id="pe-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required maxLength={80} /></Field>
        <Field label="Société ou association" hint="Facultatif."><input className="in" id="pe-company" value={company} onChange={(e) => setCompany(e.target.value)} autoComplete="organization" maxLength={100} /></Field>
        <div className="two">
          <Field label="Téléphone"><input className="in" id="pe-phone" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" required maxLength={30} /></Field>
          <Field label="Adresse e-mail" hint="Facultative."><input className="in" id="pe-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" maxLength={120} /></Field>
        </div>
        <Field label="Votre message" hint="Occasion, horaires, budget, envies…"><textarea className="in" id="pe-message" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1000} /></Field>
        <div aria-hidden="true" style={{ position: 'absolute', left: -9999, width: 1, height: 1, overflow: 'hidden' }}>
          <label>Site web<input tabIndex={-1} autoComplete="off" value={trap} onChange={(e) => setTrap(e.target.value)} /></label>
        </div>
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn pri block" disabled={busy}>{busy ? <Spinner /> : 'Envoyer ma demande'}</button>
        <p className="note">Vos coordonnées servent uniquement à répondre à cette demande. Seule l'équipe de la Nuba y a accès.</p>
      </form>
    </div>
  );
}
