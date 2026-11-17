import { AREAS, type Area } from '../lib/rights';

/** Cases à cocher : ce qu'un responsable peut modifier. */
export function RightsPicker({ value, onChange, disabled }: { value: Area[]; onChange: (v: Area[]) => void; disabled?: boolean }) {
  return (
    <div className="list" role="group" aria-label="Ce que cette personne peut modifier">
      {AREAS.map(([a, label, hint]) => (
        <label className="row" key={a} style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            data-area={a}
            checked={value.includes(a)}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked ? [...value, a] : value.filter((x) => x !== a))}
            style={{ width: 22, height: 22, flex: 'none' }}
          />
          <div className="grow">
            <span className="t">{label}</span>
            <span className="sub">{hint}</span>
          </div>
        </label>
      ))}
    </div>
  );
}
