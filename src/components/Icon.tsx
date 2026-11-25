const PATHS = {
  home: <path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
  qr: (<><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3h-3zM21 14v7M14 21h3" /></>),
  team: (<><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c0-3.5 3-5.5 6.5-5.5s6.5 2 6.5 5.5" /><circle cx="17.5" cy="9" r="2.5" /><path d="M17 14.6c2.6.2 4.5 1.8 4.5 4.4" /></>),
  cog: (<><circle cx="12" cy="12" r="3" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" /></>),
  user: (<><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 4-6 8-6s8 2 8 6" /></>),
  cal: (<><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>),
  grid: (<><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>),
  check: (<><rect x="3" y="3" width="18" height="18" rx="4" /><path d="M8 12l3 3 5-6" /></>),
  thermo: (<><path d="M10 4a2 2 0 0 1 4 0v9.5a4 4 0 1 1-4 0z" /><path d="M12 10v7" /></>),
  book: (<><path d="M5 4h13a1 1 0 0 1 1 1v15H6a2 2 0 0 1-2-2V5a1 1 0 0 1 1-1z" /><path d="M8 9h7M8 13h5" /></>),
  star: <path d="M12 3l2.7 5.6 6.1.8-4.5 4.3 1.1 6.1L12 16.9 6.6 19.8l1.1-6.1L3.2 9.4l6.1-.8z" />,
  list: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
  tool: <path d="M14.5 6.5a4 4 0 0 0 5 5L11 20l-4-4 8.5-8.5zM14.5 6.5l3-3" />,
  doc: (<><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5M10 13h6M10 17h6" /></>),
  box: (<><path d="M3 8l9-5 9 5v8l-9 5-9-5z" /><path d="M3 8l9 5 9-5M12 13v8" /></>),
  truck: (<><path d="M2 6h11v10H2zM13 9h5l4 4v3h-9z" /><circle cx="6.5" cy="18" r="2" /><circle cx="17.5" cy="18" r="2" /></>),
  minus: <path d="M5 12h14" />,
  up: <path d="M6 15l6-6 6 6" />,
  dn: <path d="M6 9l6 6 6-6" />,
  chev: <path d="M9 6l6 6-6 6" />,
  back: <path d="M15 6l-6 6 6 6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  tick: <path d="M5 12l5 5 9-10" />,
  cam: (<><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></>),
  down: <path d="M12 4v11M7 11l5 5 5-5M5 20h14" />,
  copy: (<><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>),
  alert: (<><path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17v.5" /></>),
  phone: <path d="M5 3.5h3.2l1.6 4.4-2.1 1.3a11.5 11.5 0 0 0 7.1 7.1l1.3-2.1 4.4 1.6v3.2A2 2 0 0 1 18.5 21 15.5 15.5 0 0 1 3 5.5a2 2 0 0 1 2-2z" />,
  help: (<><circle cx="12" cy="12" r="9" /><path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17v.5" /></>),
  chart: <path d="M4 4v16h16M8 16l4-5 3 3 5-6" />,
  inbox: (<><path d="M3 13l2.5-8h13L21 13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" /><path d="M3 13h5l1.5 2.5h5L16 13h5M12 4v7M9 8.5l3 3 3-3" /></>),
  folder: <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" />,
  cash: (<><rect x="2.5" y="6" width="19" height="12" rx="2" /><circle cx="12" cy="12" r="2.6" /><path d="M6 9.5v5M18 9.5v5" /></>),
  pot: (<><path d="M4 10h16v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" /><path d="M2 10h20M9.5 3.5c-.8.9-.8 2.1 0 3M14.5 3.5c-.8.9-.8 2.1 0 3" /></>),
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}
