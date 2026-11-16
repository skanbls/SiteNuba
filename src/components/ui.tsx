import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useSession } from '../lib/session';
import type { Profile } from '../lib/types';
import { Icon, type IconName } from './Icon';

/* ---------- Message bref en bas d'écran ---------- */
type ToastFn = (msg: string, kind?: 'ok' | 'bad') => void;
const ToastCtx = createContext<ToastFn>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [t, setT] = useState<{ msg: string; kind: 'ok' | 'bad' } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const show = useCallback<ToastFn>((msg, kind = 'ok') => {
    setT({ msg, kind });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setT(null), kind === 'bad' ? 5200 : 3000);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div className={'toast' + (t?.kind === 'bad' ? ' bad' : '')} role="status" aria-live="polite" hidden={!t}>
        {t?.msg}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------- Coque : en-tête, rail de modules, onglets ---------- */
interface NavItem { to: string; label: string; icon: IconName; gerant?: boolean; tab?: boolean }
export const NAV: NavItem[] = [
  { to: '/', label: "Aujourd'hui", icon: 'home', tab: true },
  { to: '/pointeuse', label: 'Pointeuse', icon: 'qr', tab: true },
  { to: '/checklists', label: 'Checklists', icon: 'check', tab: true },
  { to: '/planning', label: 'Planning', icon: 'cal', tab: true },
  { to: '/hygiene', label: 'Hygiène', icon: 'thermo' },
  { to: '/stocks', label: 'Stocks', icon: 'box' },
  { to: '/commandes', label: 'Commandes', icon: 'truck' },
  { to: '/equipe', label: 'Équipe', icon: 'team', gerant: true },
  { to: '/reglages', label: 'Réglages', icon: 'cog', gerant: true },
  { to: '/compte', label: 'Mon compte', icon: 'user' },
];

/** Écrans accessibles à ce rôle. */
export const navFor = (role: string | undefined) => NAV.filter((n) => !n.gerant || role === 'gerant');

export function Layout({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  const { profile, pin, signOut } = useSession();
  const { pathname } = useLocation();
  const items = navFor(profile?.role);
  // Sur téléphone : les écrans principaux en onglets. Les autres vont sous « Plus », sauf s'il n'y en a qu'un.
  const rest = items.filter((n) => !n.tab);
  const tabs: NavItem[] = [...items.filter((n) => n.tab), rest.length === 1 ? rest[0] : { to: '/plus', label: 'Plus', icon: 'grid' }];
  useEffect(() => {
    document.title = `${title} · Nuba Gestion`;
  }, [title]);
  return (
    <>
      <nav className="side" aria-label="Modules">
        <div className="brand">
          Nuba<small>Gestion</small>
        </div>
        <div className="side-nav">
          {items.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'}>
              <Icon name={n.icon} />
              <span>{n.label}</span>
            </NavLink>
          ))}
        </div>
      </nav>
      <div className="content">
        <header className="top">
          <div className="top-in">
            <h1 className="grow">{title}</h1>
            {right}
            {pin && (
              <button type="button" className="btn sm pri" onClick={() => void signOut()} aria-label={`Terminer la session de ${profile?.first_name ?? ''}`}>
                Terminer ({profile?.first_name})
              </button>
            )}
          </div>
        </header>
        <main className="main">{children}</main>
      </div>
      <nav className="tabbar" aria-label="Navigation principale">
        {tabs.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => (isActive || (n.to === '/plus' && rest.some((r) => r.to === pathname)) ? 'active' : '')}>
            <Icon name={n.icon} size={22} />
            <span>{n.label === 'Mon compte' ? 'Compte' : n.label}</span>
          </NavLink>
        ))}
      </nav>
    </>
  );
}

/* ---------- Petites briques ---------- */
export function Section({ title, right, children }: { title?: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="sec">
      {title && (
        <div className="sec-h">
          <h2>{title}</h2>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export const Avatar = ({ p }: { p: Pick<Profile, 'first_name'> | null | undefined }) => (
  <span className="av" aria-hidden="true">{(p?.first_name || '?')[0]}</span>
);

export const Spinner = () => <div className="spin" role="status" aria-label="Chargement" />;

export function Loading() {
  return (
    <div className="list">
      <div className="row" style={{ justifyContent: 'center', padding: 22 }}>
        <Spinner />
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function Chips<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="chips" role="group" aria-label={label}>
      {options.map(([v, l]) => (
        <button key={v} type="button" className="chip" aria-pressed={v === value} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

/** Formulaire en surimpression. Se ferme avec Échap, la croix ou un appui sur le fond. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  return (
    <div className="sheet-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <div className="sheet-h">
          <h2>{title}</h2>
          <button type="button" className="btn sm" onClick={onClose} aria-label="Fermer">
            <Icon name="x" size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
