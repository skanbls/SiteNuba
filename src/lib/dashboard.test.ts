import { describe, expect, it } from 'vitest';
import { amountOf, dayOf, isStatus, parseBoard, parseHistory, parseSeries, tone, type Grid } from './dashboard';

/** Une grille inventée : le texte affiché, et les valeurs brutes quand elles diffèrent. */
const grid = (rows: (string | [string, unknown])[][]): Grid => ({
  d: rows.map((r) => r.map((c) => (Array.isArray(c) ? c[0] : c))),
  v: rows.map((r) => r.map((c) => (Array.isArray(c) ? c[1] : c))),
});

const BOARD = grid([
  ['Société test : tableau de bord'],
  ['Solde de référence du 01/12/2026.'],
  [],
  ['Trésorerie'],
  ['Solde bancaire retenu', ['20 000 €', 20000], '01/12/2026'],
  ['Statut sur 13 semaines', 'ORANGE'],
  ['Marge de manœuvre', ['-1 000 €', -1000], 'DÉPASSEMENT'],
  ['Seuil vert / seuil rouge', ['9 000 €', 9000], ['4 000 €', 4000]],
  ['Solde le plus bas prévu', ['8 000 €', 8000], 'semaine du 25/01'],
  ['Budget d\'ouverture'],
  ['Postes à corriger', '1', 'À CORRIGER'],
  ['Encore disponible', ['3 000 €', 3000], 'OK'],
  [],
  ['Alertes', '', '2 alerte(s) active(s)'],
  [],
  ['Trésorerie sous le seuil vert la semaine du 25/01.'],
  [],
  ['1 poste à corriger.'],
  [],
  ['Prochaines échéances (30 jours)'],
  ['Date', 'Libellé', 'Montant'],
  [['05/12/2026', '2026-12-05'], 'Assurance test', ['-300,00 €', -300]],
  [['02/12/2026', '2026-12-02'], 'Loyer test', ['-1 200,00 €', -1200]],
  [['46371', 46371], 'Eau test', ['-60', -60]],
]);

describe('tableau de bord financier', () => {
  it('lit les rubriques, les états, les alertes et les échéances', () => {
    const b = parseBoard(BOARD);
    expect(b.title).toBe('Société test : tableau de bord');
    expect(b.subtitle).toBe('Solde de référence du 01/12/2026.');
    expect(b.sections.map((s) => [s.title, s.rows.length])).toEqual([['Trésorerie', 5], ["Budget d'ouverture", 2]]);
    const [solde, statut, marge, seuils, bas] = b.sections[0].rows;
    expect(solde).toEqual({ label: 'Solde bancaire retenu', value: '20 000 €', note: '01/12/2026', status: '', tone: 'neutral' });
    expect([statut.status, statut.tone]).toEqual(['ORANGE', 'warn']);
    expect([marge.value, marge.status, marge.tone]).toEqual(['-1 000 €', 'DÉPASSEMENT', 'bad']);
    expect([seuils.value, seuils.note]).toEqual(['9 000 € / 4 000 €', '']);
    expect([bas.note, bas.status]).toEqual(['semaine du 25/01', '']);
    expect(b.sections[1].rows.map((k) => k.tone)).toEqual(['warn', 'ok']);
    expect(b.alerts).toEqual(['Trésorerie sous le seuil vert la semaine du 25/01.', '1 poste à corriger.']);
    expect(b.alertsNote).toBe('2 alerte(s) active(s)');
    expect(b.duesTitle).toBe('Prochaines échéances (30 jours)');
    expect(b.dues).toEqual([
      { day: '2026-12-02', label: 'Loyer test', amount: -1200 },
      { day: '2026-12-05', label: 'Assurance test', amount: -300 },
      { day: '2026-12-15', label: 'Eau test', amount: -60 },   // date restée en nombre dans la feuille
    ]);
    expect(parseBoard(undefined).sections).toEqual([]);
  });

  it('reconnaît les états, les montants et les dates', () => {
    expect(['OK', 'ORANGE', 'À CORRIGER', 'PAS COMMENCÉ'].map(isStatus)).toEqual([true, true, true, true]);
    expect(['12 €', 'semaine du 25/01', '30,3%', ''].map(isStatus)).toEqual([false, false, false, false]);
    expect(['VERT', 'ROUGE', 'NÉGATIF', 'AU-DESSUS DE LA CIBLE', 'PAS COMMENCÉ'].map(tone)).toEqual(['ok', 'bad', 'bad', 'warn', 'neutral']);
    expect(amountOf('', '-1 579,50 €')).toBe(-1579.5);
    expect(amountOf(undefined, '29 306 €')).toBe(29306);
    expect(amountOf('', '30,3%')).toBeCloseTo(0.303);
    expect(amountOf('', '-')).toBeNull();
    expect(dayOf('', '05/12/2026')).toBe('2026-12-05');
    expect(dayOf(46344, '')).toBe('2026-11-18');
    expect(dayOf('', 'bientôt')).toBeNull();
  });

  it('lit les séries de la trésorerie, ligne par libellé', () => {
    const t = parseSeries(grid([
      ['Trésorerie sur 13 semaines'],
      [],
      ['Début de semaine', '', '01/12', '08/12', '15/12'],
      ['Solde fin de semaine', '', ['9 500 €', 9500], ['8 000 €', 8000], ['-200 €', -200]],
      ['Seuil vert', '', ['9 000 €', 9000], ['9 000 €', 9000], ['9 000 €', 9000]],
      ['Statut', '', 'VERT', 'ORANGE', 'NÉGATIF'],
    ]), 'Début de semaine')!;
    expect(t.labels).toEqual(['01/12', '08/12', '15/12']);
    expect(t.numbers('Solde fin')).toEqual([9500, 8000, -200]);
    expect(t.numbers('seuil VERT')).toEqual([9000, 9000, 9000]);
    expect(t.texts('Statut')).toEqual(['VERT', 'ORANGE', 'NÉGATIF']);
    expect(t.numbers('Inconnue')).toBeNull();
    expect(parseSeries(grid([['Autre chose']]), 'Mois')).toBeNull();
  });

  it("garde l'historique, le plus récent d'abord", () => {
    const h = parseHistory(grid([
      ['Date', 'Solde retenu', 'Statut', '', 'Note du script'],
      ['09/11/2026', '30 000 €', 'VERT'],
      ['16/11/2026', '28 000 €', 'ORANGE'],
      ['', '', ''],
    ]));
    expect(h.head).toEqual(['Date', 'Solde retenu', 'Statut']);
    expect(h.rows).toEqual([['16/11/2026', '28 000 €', 'ORANGE'], ['09/11/2026', '30 000 €', 'VERT']]);
  });
});
