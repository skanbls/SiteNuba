import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildAppsScript, folderId, sheetId } from './appsScript';

/* Un faux Google : feuilles en mémoire, envois notés, déclencheurs comptés. */
type Plain = string | number | Date;
/** Une case : sa valeur, ou sa valeur et le texte affiché par la feuille. */
type Cell = Plain | { d: string; v: Plain };
const isShown = (c: Cell): c is { d: string; v: Plain } => typeof c === 'object' && !(c instanceof Date);
/** Un faux Drive : des dossiers et des fichiers en mémoire. */
interface FakeFile { id: string; name: string; mime: string; size: number; modified: Date; data: string }
interface FakeFolder { id: string; name: string; files: FakeFile[]; folders: FakeFolder[] }
const iter = <T,>(xs: T[]) => { let i = 0; return { hasNext: () => i < xs.length, next: () => xs[i++] }; };
function driveApp(root: FakeFolder) {
  const all = new Map<string, FakeFile>();
  const wrapFolder = (f: FakeFolder): unknown => ({
    getId: () => f.id, getName: () => f.name,
    getFiles: () => iter(f.files.map(wrapFile)), getFolders: () => iter(f.folders.map(wrapFolder)),
  });
  const wrapFile = (x: FakeFile) => {
    all.set(x.id, x);
    return {
      getId: () => x.id, getName: () => x.name, getMimeType: () => x.mime, getSize: () => x.size, getLastUpdated: () => x.modified,
      getBlob: () => ({ getBytes: () => [...Buffer.from(x.data)] }),
      getAs: (m: string) => ({ getBytes: () => [...Buffer.from(`${m}:${x.data}`)] }),
    };
  };
  return {
    getFolderById: (id: string) => { if (id !== root.id) throw new Error('dossier introuvable'); return wrapFolder(root); },
    getFileById: (id: string) => { const x = all.get(id); if (!x) throw new Error('fichier introuvable'); return wrapFile(x); },
  };
}

type Sent = { url: string; method: string; body: { p_key: string; p_payload: Record<string, unknown>; p_done?: unknown }; bytes?: string; contentType?: string; headers: Record<string, string> };
function fakeGoogle(files: Record<string, { name: string; tabs: Record<string, Cell[][]> }>, answer: string | ((url: string, method: string) => string) = '{"ok":true,"counts":{}}', drive?: FakeFolder) {
  const notes = new Map<string, string>();
  const sent: Sent[] = [];
  const props = new Map<string, string>();
  const triggers: { fn: string }[] = [{ fn: 'envoyerSiChangement' }, { fn: 'autreChose' }];
  const g = {
    SpreadsheetApp: {
      openById: (id: string) => {
        const f = files[id];
        if (!f) throw new Error('fichier introuvable ' + id);
        return {
          getName: () => f.name,
          getSheetByName: (n: string) => (f.tabs[n] ? {
            getDataRange: () => ({
              getValues: () => f.tabs[n].map((r) => r.map((c) => (isShown(c) ? c.v : c))),
              getDisplayValues: () => f.tabs[n].map((r) => r.map((c) => (isShown(c) ? c.d : String(c)))),
            }),
            getRange: (r: number, c: number) => ({
              getNote: () => notes.get(`${n}!${r},${c}`) ?? '',
              setNote: (x: string) => notes.set(`${n}!${r},${c}`, x),
              setValue: (v: Plain) => { f.tabs[n][r - 1][c - 1] = v; },
            }),
          } : null),
        };
      },
    },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: (k: string) => props.get(k) ?? null, setProperty: (k: string, v: string) => props.set(k, v) }),
    },
    UrlFetchApp: {
      fetch: (url: string, o: { method?: string; contentType?: string; payload?: string | number[]; headers: Record<string, string> }) => {
        const method = o.method ?? 'get';
        const json = !o.contentType || o.contentType === 'application/json';
        sent.push({
          url, method, headers: o.headers, contentType: o.contentType,
          body: json && typeof o.payload === 'string' ? JSON.parse(o.payload) : null,
          bytes: Array.isArray(o.payload) ? Buffer.from(o.payload).toString() : undefined,
        });
        return { getResponseCode: () => 200, getContentText: () => (typeof answer === 'function' ? answer(url, method) : answer) };
      },
    },
    ...(drive ? { DriveApp: driveApp(drive) } : {}),
    Utilities: {
      formatDate: (d: Date) => d.toISOString().slice(0, 10),
      computeDigest: (_a: string, s: string) => [...createHash('sha256').update(s).digest()],
      base64Encode: (b: number[]) => Buffer.from(b).toString('base64'),
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
    },
    ScriptApp: {
      getProjectTriggers: () => triggers.map((t) => ({ getHandlerFunction: () => t.fn, t })),
      deleteTrigger: (x: { t: { fn: string } }) => triggers.splice(triggers.indexOf(x.t), 1),
      newTrigger: (fn: string) => ({ timeBased: () => ({ everyMinutes: (m: number) => ({ create: () => triggers.push({ fn: `${fn}/${m}` }) }) }) }),
    },
    console: { log: () => {} },
  };
  return { g, sent, props, triggers, notes };
}

function run(script: string, g: Record<string, unknown>) {
  const f = new Function(...Object.keys(g), `${script}\nreturn { installer, envoyerMaintenant, envoyerSiChangement };`);
  return f(...Object.values(g)) as Record<'installer' | 'envoyerMaintenant' | 'envoyerSiChangement', () => void>;
}

const SN: Record<string, Cell[][]> = {
  RECETTES: [
    ['Recette', 'Catégorie', 'Portions produites par la fiche', "Poids d'une portion (g)", 'Coût matière / portion (€)', 'Coût / portion avec pertes (€)', 'Prix de vente spécifique HT (€)', 'Prix de vente HT (€)', 'Coût matière %', 'État de la fiche', 'Portions pour la liste de courses', 'Ingrédients (étiquette, par poids décroissant)', 'Allergènes', 'Ingrédients dont les allergènes sont à vérifier'],
    ['Purée de patate douce', 'BASE', 1, 250.5, 0.6, 0.7, '', '', '', 'OK', 0, 'Patate douce, Beurre, Sel', 'Lait', ''],
    ['', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ],
  'COMPOSITION CALCUL': [
    ['Recette', 'Ingrédient', 'Quantité', 'Unité', 'Prix unitaire (€)', 'Coût (€)', 'Fournisseur', 'Quantité pour la liste de courses', "Nom sur l'étiquette", 'Allergènes', 'Allergènes à vérifier', 'Poids (g)', 'Coefficient de pertes', 'Coût avec pertes (€)', 'Quantité brute pour la fiche'],
    ['Purée de patate douce', 'Patate douce', 200, 'g', 0.002, 0.4, 'Primeur', 1000, 'Patate douce', '', '', 200, 0.25, 0.5, 250],
    ['', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ],
  PRESTATIONS: [
    ['Date de livraison', 'Type de formule', 'Plat', 'Portions', 'Prix de vente HT / portion (€)', 'Coût matière / portion avec pertes (€)', 'Contrôle des fiches', 'Facteur base', 'Facteur protéine', 'Facteur légume', 'Facteur sauce'],
    [new Date(Date.UTC(2026, 10, 18)), 'Sur mesure', 'Purée de patate douce + Poulet Moutarde Miel (Mariné)', 100, 5, 1.5, 'OK', 0.833333333, 0.75, 0, 0],
    ['', '', '', '', '', '', '', '', '', '', ''],
  ],
  'GRAMMAGES SUR MESURE': [
    ['Grammages du plat sur mesure'],
    ['Le plat sur mesure pèse toujours…'],
    [],
    ['Recette', 'Rôle', 'Type'],
    ['Purée de patate douce', 'BASE', 'Purée / crémeux'],
  ],
  'PRIX INGREDIENTS': [
    ['Catégorie', 'Ingrédient', 'Fournisseur retenu (le moins cher, automatique)', "Prix d'achat HT retenu (€, automatique)", "Unité d'achat", "Poids d'une pièce (g)", 'Prix unitaire recette (€)', 'Unité en recette', 'Date de la facture retenue', 'Source du prix retenu', "Prix de l'ancienne mercuriale (€)", 'Écart', 'Allergènes', "Nom sur l'étiquette", 'Allergènes à vérifier', "Poids moyen d'une pièce (g) – pour l'étiquette", "Fournisseur de l'ancienne mercuriale"],
    ['FRUITS / LEGUMES', 'Patate douce', 'Primeur', 2, 'kg', '', 0.002, 'g', '', '', 2, 0, '', '', '', 30, 'Grossiste'],
  ],
};
// Le Comptoir n'a ni GRAMMAGES ni PRIX INGREDIENTS lisible, et ses titres diffèrent un peu.
const CM: Record<string, Cell[][]> = {
  RECETTES: [['Recette', 'Catégorie', 'Portions produites par la fiche'], ['Brownie', 'Dessert', 10]],
  'COMPOSITION CALCUL': [['Recette', 'Ingrédient', 'Quantité pour la fiche', 'Unité', 'Prix unitaire (€)', 'Coût (€)', 'Fournisseur', 'Quantité pour la liste de courses'], ['Brownie', 'Oeufs', 5, 'pièce', 0.3, 1.5, 'Grossiste', 40]],
  PRESTATIONS: [['Date de livraison', 'Catégorie', 'Plat', 'Portions'], [new Date(Date.UTC(2026, 10, 25)), 'Dessert', 'Brownie', 60]],
};

// La mercuriale Nuba : des blocs, une fiche par bloc (données inventées).
const NB: Record<string, Cell[][]> = {
  'FICHES PLATS': [
    ['Fiches techniques cuisine'],
    ['À remplir par la cheffe…'],
    [],
    ['Plat', 'Velouté test', '', '', 'État de la fiche', '', 'OK'],
    ['Catégorie', 'Entrée', '', '', 'Coût matière / portion (€)', '', 1.25, 'Allergènes', 'Lait'],
    ['Portions produites par la fiche', 2, '', '', 'Prix de vente HT (€)', '', 6.363636, 'Marge brute / portion (€)', 5.11],
    ['Prix de vente TTC carte (€)', 7, '', '', 'Coût matière %', '', 0.1964, 'Coefficient (prix TTC / coût)', 5.6],
    ['Taux de TVA (selon la catégorie)', 0.1, '', '', 'Objectif coût matière %', '', 0.25, 'Prix TTC conseillé (€)', ''],
    ['Ingrédient', 'Quantité nette pour la fiche', 'Unité', 'Pertes', 'Quantité brute à sortir', 'Prix unitaire (€)', 'Coût avec pertes (€)', 'Fournisseur', 'Allergènes'],
    ['Légume test', 300, 'g', 0.2, 360, 0.002, 0.72, 'Primeur', ''],
    ['Crème test', '', 'ml', 0.05, '', 0.004, '', 'Grossiste', 'Lait'],
    ['Sauce test (maison)', 40, 'g', 0, 40, '', '', 'Maison', ''],
    [], [],
    ['Plat', '', '', '', 'État de la fiche', '', ''],
    ['Catégorie', '', '', '', 'Coût matière / portion (€)', '', '', 'Allergènes', ''],
    ['Ingrédient', 'Quantité nette pour la fiche', 'Unité'],
  ],
  'FICHES BOISSONS': [
    ['Boisson', 'Cocktail test', '', '', 'État de la fiche', '', 'Doses à saisir'],
    ['Catégorie', 'Cocktail', '', '', 'Coût matière / portion (€)', '', '', 'Allergènes', 'Aucun déclaré'],
    ['Ingrédient', 'Dose (cl, g ou pièce)', 'Unité', 'Pertes', 'Quantité brute', 'Prix unitaire (€)', 'Coût avec pertes (€)', 'Fournisseur', 'Allergènes'],
    ['Rhum test', '', 'cl', 0.02, '', 0.3, '', 'Cave', ''],
  ],
  'PREPARATIONS MAISON': [
    ['Préparation', 'Sauce test (maison)', '', '', 'État de la fiche', '', 'OK'],
    ['Rendement : quantité finale obtenue', 1.2, '', '', 'Coût matière total (€)', '', 3, 'Allergènes', 'Aucun déclaré'],
    ['Unité du rendement (kg, L ou pièce)', 'kg', '', '', 'Coût par kg, L ou pièce (€)', '', 2.5, 'Utilisée dans', 'Velouté test'],
    ['Unité dans les fiches', 'g', '', '', 'Coût par unité dans les fiches (€)', '', 0.0025],
    ['Rendement : poids (kg), volume (L) ou nombre de portions (pièce) obtenu en fin de recette, pesé ou compté.'],
    ['Ingrédient', 'Quantité nette pour la fiche', 'Unité', 'Pertes', 'Quantité brute à sortir', 'Prix unitaire (€)', 'Coût avec pertes (€)', 'Fournisseur', 'Allergènes'],
    ['Yaourt test', 1000, 'g', 0.05, 1050, 0.0028, 2.94, 'Grossiste', ''],
  ],
  CALCUL: [
    ['Ingrédient (base de prix)', 'Unité cuisine', 'Prix / unité cuisine (€)', 'Unité bar', 'Prix / unité bar (€)', 'Pertes', 'Fournisseur', 'Allergènes', 'Allergènes à vérifier', '', 'Préparation maison', 'Unité cuisine', 'Prix / unité cuisine (€)', 'Unité bar', 'Prix / unité bar (€)', 'Pertes', 'Fournisseur', 'Allergènes', 'Allergènes à vérifier'],
    ['Légume test', 'g', 0.002, 'g', 0.002, 0.2, 'Primeur', '', '', '', 'Sauce test (maison)', 'g', 0.0025, 'g', 0.0025, 0, 'Maison', '', 'Ne pas lire'],
    ['Yaourt test', 'g', 0.0028, 'g', 0.0028, 0.05, 'Grossiste', 'Lait', 'Lait : vérifier l\'étiquette'],
  ],
};

const opts = { url: 'https://projet.supabase.co/', publicKey: 'sb_publishable_x', syncKey: 'nuba_cle', saveursNomades: 'ID_SN', comptoir: 'ID_CM', date: '17/11/2026' };

describe('script Google des mercuriales', () => {
  it("retrouve l'identifiant d'une feuille dans son lien", () => {
    expect(sheetId('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789-ab/edit?usp=drivesdk')).toBe('1AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789-ab');
    const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789-ab';
    expect(sheetId(`https://docs.google.com/spreadsheets/u/1/d/${id}/edit#gid=0`)).toBe(id);   // plusieurs comptes Google ouverts
    expect(sheetId(`  https://docs.google.com/spreadsheets/d/${id}/edit?usp=sharing  `)).toBe(id);
    expect(sheetId(`https://drive.google.com/file/d/${id}/view?usp=drivesdk`)).toBe(id);
    expect(sheetId(`https://drive.google.com/open?id=${id}`)).toBe(id);
    expect(sheetId(id)).toBe(id);
    expect(sheetId('https://docs.google.com/spreadsheets/d/e/2PACX-1vQabcdefghijklmnopqrstuvwxyz/pubhtml')).toBe('');
    expect(sheetId('https://exemple.fr/d/abc')).toBe('');
  });

  it('installe un seul déclencheur et envoie les deux mercuriales, colonnes retrouvées par leur titre', () => {
    const { g, sent, triggers } = fakeGoogle({ ID_SN: { name: 'MERCURIALE SAVEURS NOMADES', tabs: SN }, ID_CM: { name: 'MERCURIALE COMPTOIR', tabs: CM } });
    run(buildAppsScript(opts), g).installer();
    expect(triggers.map((t) => t.fn)).toEqual(['autreChose', 'envoyerSiChangement/10']);
    expect(sent).toHaveLength(2);
    expect(sent[0].url).toBe('https://projet.supabase.co/rest/v1/rpc/sync_mercuriale');
    expect(sent[0].headers).toEqual({ apikey: 'sb_publishable_x' });
    expect(sent[0].body.p_key).toBe('nuba_cle');
    const sn = sent[0].body.p_payload;
    expect(sn.brand).toBe('saveurs_nomades');
    expect(sn.file).toBe('MERCURIALE SAVEURS NOMADES');
    expect(sn.recipes).toEqual([{ name: 'Purée de patate douce', category: 'BASE', portions: 1, portion_weight: 250.5, cost_portion: 0.6, cost_portion_losses: 0.7, status: 'OK', label: 'Patate douce, Beurre, Sel', allergens: 'Lait' }]);
    expect(sn.lines).toEqual([{ recipe: 'Purée de patate douce', ingredient: 'Patate douce', quantity: 200, unit: 'g', supplier: 'Primeur', loss: 0.25 }]);
    expect(sn.orders).toEqual([{ day: '2026-11-18', formula: 'Sur mesure', dish: 'Purée de patate douce + Poulet Moutarde Miel (Mariné)', portions: 100, check: 'OK', factor_base: 0.833333, factor_protein: 0.75, factor_vegetable: 0, factor_sauce: 0 }]);
    expect(sn.roles).toEqual([{ recipe: 'Purée de patate douce', role: 'BASE' }]);
    expect(sn.ingredients).toEqual([{ name: 'Patate douce', category: 'FRUITS / LEGUMES', supplier: 'Primeur', purchase_price: 2, purchase_unit: 'kg', recipe_unit_price: 0.002, recipe_unit: 'g' }]);
    const cm = sent[1].body.p_payload;
    expect(cm.brand).toBe('comptoir');
    expect(cm.ingredients).toBeUndefined();
    expect(cm.roles).toEqual([]);
    expect(cm.lines).toEqual([{ recipe: 'Brownie', ingredient: 'Oeufs', quantity: 5, unit: 'pièce', supplier: 'Grossiste' }]);
    expect(cm.orders).toEqual([{ day: '2026-11-25', formula: 'Dessert', dish: 'Brownie', portions: 60 }]);
  });

  it("n'envoie que ce qui a changé", () => {
    const files = { ID_SN: { name: 'SN', tabs: structuredClone(SN) }, ID_CM: { name: 'CM', tabs: structuredClone(CM) } };
    const { g, sent } = fakeGoogle(files);
    const s = run(buildAppsScript(opts), g);
    s.envoyerSiChangement();
    expect(sent).toHaveLength(2);
    s.envoyerSiChangement();
    expect(sent).toHaveLength(2);
    files.ID_CM.tabs.PRESTATIONS[1][3] = 80;
    s.envoyerSiChangement();
    expect(sent).toHaveLength(3);
    expect(sent[2].body.p_payload.brand).toBe('comptoir');
    s.envoyerMaintenant();
    expect(sent).toHaveLength(5);
  });

  it('lit la carte Nuba, bloc par bloc, et l\'envoie à part', () => {
    const { g, sent } = fakeGoogle({ ID_NB: { name: 'MERCURIALE NUBA', tabs: NB } });
    run(buildAppsScript({ ...opts, saveursNomades: '', comptoir: '', nuba: 'ID_NB' }), g).envoyerMaintenant();
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://projet.supabase.co/rest/v1/rpc/sync_carte');
    const nb = sent[0].body.p_payload as { brand: string; file: string; items: Record<string, unknown>[]; lines: Record<string, unknown>[] };
    expect(nb.brand).toBe('nuba');
    expect(nb.file).toBe('MERCURIALE NUBA');
    expect(nb.items).toEqual([
      { kind: 'plat', block: 1, name: 'Velouté test', status: 'OK', category: 'Entrée', cost_portion: 1.25, allergens: 'Lait', portions: 2, sale_price_ht: 6.363636, margin: 5.11, sale_price: 7, cost_pct: 0.1964, coefficient: 5.6, vat: 0.1, target_pct: 0.25 },
      { kind: 'boisson', block: 2, name: 'Cocktail test', status: 'Doses à saisir', category: 'Cocktail', allergens: 'Aucun déclaré' },
      { kind: 'preparation', block: 3, name: 'Sauce test (maison)', status: 'OK', yield_qty: 1.2, cost_total: 3, allergens: 'Aucun déclaré', yield_unit: 'kg', cost_unit: 2.5, used_in: 'Velouté test', recipe_unit: 'g', cost_recipe_unit: 0.0025 },
    ]);
    expect(nb.lines).toEqual([
      { kind: 'plat', block: 1, recipe: 'Velouté test', ingredient: 'Légume test', quantity: 300, unit: 'g', loss: 0.2, gross: 360, unit_price: 0.002, cost: 0.72, supplier: 'Primeur' },
      { kind: 'plat', block: 1, recipe: 'Velouté test', ingredient: 'Crème test', unit: 'ml', loss: 0.05, unit_price: 0.004, supplier: 'Grossiste', allergens: 'Lait' },
      { kind: 'plat', block: 1, recipe: 'Velouté test', ingredient: 'Sauce test (maison)', quantity: 40, unit: 'g', loss: 0, gross: 40, supplier: 'Maison' },
      { kind: 'boisson', block: 2, recipe: 'Cocktail test', ingredient: 'Rhum test', unit: 'cl', loss: 0.02, unit_price: 0.3, supplier: 'Cave' },
      { kind: 'preparation', block: 3, recipe: 'Sauce test (maison)', ingredient: 'Yaourt test', quantity: 1000, unit: 'g', loss: 0.05, gross: 1050, unit_price: 0.0028, cost: 2.94, supplier: 'Grossiste', check: "Lait : vérifier l'étiquette" },
    ]);
  });

  it('les trois mercuriales partent ensemble, la carte vers sa propre adresse', () => {
    const { g, sent } = fakeGoogle({ ID_SN: { name: 'SN', tabs: SN }, ID_CM: { name: 'CM', tabs: CM }, ID_NB: { name: 'NB', tabs: NB } }, '{"ok":false,"error":"db","message":"valeur trop longue"}');
    expect(() => run(buildAppsScript({ ...opts, nuba: 'ID_NB' }), g).envoyerMaintenant()).toThrow(/nuba : refusé par la base : valeur trop longue/);
    expect(sent.map((x) => x.url.split('/').pop())).toEqual(['sync_mercuriale', 'sync_mercuriale', 'sync_carte']);
  });

  it('envoie le tableau de bord tel qu\'il s\'affiche, sans lignes ni colonnes vides', () => {
    const histo: Cell[][] = [['Date', 'Solde retenu'], ...Array.from({ length: 320 }, (_, i) => [`S${i}`, i] as Cell[])];
    const TB: Record<string, Cell[][]> = {
      'Tableau de bord': [
        ['Tableau test', '', '', '', ''],
        [],
        ['Trésorerie', '', '', '', ''],
        ['Solde retenu', { d: '10 000 €', v: 10000.4 }, { d: '01/12/2026', v: new Date(Date.UTC(2026, 11, 1)) }, '', ''],
        ['', '', '', '', ''],
      ],
      'Tréso 13 semaines': [['Solde fin de semaine', '', { d: '9 000 €', v: 9000 }]],
      'Historique KPI': histo,
      'Autre onglet': [['Pas envoyé']],
    };
    const { g, sent } = fakeGoogle({ ID_TB: { name: 'TABLEAU', tabs: TB } });
    run(buildAppsScript({ ...opts, saveursNomades: '', comptoir: '', tableau: 'ID_TB' }), g).envoyerMaintenant();
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://projet.supabase.co/rest/v1/rpc/sync_dashboard');
    const tb = sent[0].body.p_payload as { brand: string; tabs: Record<string, { d: string[][]; v: unknown[][] }> };
    expect(tb.brand).toBe('tableau');
    expect(Object.keys(tb.tabs)).toEqual(['Tableau de bord', 'Tréso 13 semaines', 'Historique KPI']);
    expect(tb.tabs['Tableau de bord'].d).toEqual([['Tableau test', '', ''], [], ['Trésorerie', '', ''], ['Solde retenu', '10 000 €', '01/12/2026']]);
    expect(tb.tabs['Tableau de bord'].v[3]).toEqual(['Solde retenu', 10000.4, '2026-12-01']);
    expect(tb.tabs['Tréso 13 semaines'].v).toEqual([['Solde fin de semaine', '', 9000]]);
    const h = tb.tabs['Historique KPI'].d;
    expect(h).toHaveLength(301);
    expect(h[0]).toEqual(['Date', 'Solde retenu']);
    expect(h[300]).toEqual(['S319', '319']);
  });

  it('envoie le contenu du site : programmation, rendez-vous, exposition et œuvres, tels qu\'ils s\'affichent', () => {
    const SITE: Record<string, Cell[][]> = {
      "Mode d'emploi": [['Ne pas lire']],
      Programmation: [
        ['Date', 'Type', 'Titre', 'Description', 'Horaire', 'Entrée', 'Visible', 'Titre EN', 'Réf. Titre', 'Affiche'],
        [{ d: '19/11/2026', v: new Date(Date.UTC(2026, 10, 19)) }, 'Quiz', 'Quiz test', 'Par équipes.', '20h30 → 23h', { d: '5,00 €', v: 5 }, '', 'Test quiz', 'Quiz test', 'https://drive.google.com/file/d/AfficheTest/view'],
        ['', '', '', '', '', '', '', '', '', ''],
        ['21/11/2026', 'DJ set', 'Soirée test', '', '22h → 2h', 'Entrée libre', 'NON', '', '', ''],
      ],
      'Chaque semaine': [['Jour', 'Rendez-vous', 'Horaire', 'Visible', 'Rendez-vous EN'], ['Jeudi', 'Quiz', 'dès 20h30', 'OUI', 'Quiz']],
      Exposition: [
        ['Champ', 'Français', 'English'],
        ['Afficher l’exposition', 'OUI', ''],
        ['Titre', 'Expo test', 'Test show'],
        ['Début', { d: '01/11/2026', v: new Date(Date.UTC(2026, 10, 1)) }, ''],
      ],
      'Œuvres': [['Titre', 'Technique', 'Dimensions', 'Image', 'Visible', 'Technique EN'], ['Toile test', 'Acrylique', '80 × 60 cm', '', '', 'Acrylic']],
    };
    const { g, sent } = fakeGoogle({ ID_SITE: { name: 'Contenu du site', tabs: SITE } });
    run(buildAppsScript({ ...opts, saveursNomades: '', comptoir: '', site: 'ID_SITE' }), g).envoyerMaintenant();
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://projet.supabase.co/rest/v1/rpc/sync_site');
    expect(sent[0].body.p_payload).toEqual({
      brand: 'site', file: 'Contenu du site',
      programme: [
        { Date: '2026-11-19', Type: 'Quiz', Titre: 'Quiz test', Description: 'Par équipes.', Horaire: '20h30 → 23h', 'Entrée': '5,00 €', Affiche: 'https://drive.google.com/file/d/AfficheTest/view' },
        { Date: '21/11/2026', Type: 'DJ set', Titre: 'Soirée test', Horaire: '22h → 2h', 'Entrée': 'Entrée libre', Visible: 'NON' },
      ],
      weekly: [{ Jour: 'Jeudi', 'Rendez-vous': 'Quiz', Horaire: 'dès 20h30', Visible: 'OUI' }],
      expo: { "Afficher l'exposition": 'OUI', Titre: 'Expo test', 'Début': '2026-11-01' },
      works: [{ Titre: 'Toile test', Technique: 'Acrylique', Dimensions: '80 × 60 cm' }],
    });
  });

  it('lit les semaines types et le calendrier de « Planning équipe », et envoie six semaines de services', () => {
    const day = (iso: string, n: number) => { const x = new Date(`${iso}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
    const fr = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
    const today = new Date().toISOString().slice(0, 10);
    const w1 = day(today, 7 - ((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7));   // lundi prochain
    const w2 = day(w1, 7), w3 = day(w1, 14), w4 = day(w1, 21);
    const jours = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
    const PLAN: Record<string, Cell[][]> = {
      'Planning équipe': [
        ['Planning test'], [],
        ["Horaires d'ouverture au public"],
        ['', '', ...jours],
        ['Lieu test', '', 'Fermé – prod', '12h00 – 00h00', '12h00 – 00h00', '12h00 – 00h00', '12h00 – 02h00', '12h00 – 02h00', '12h00 – 16h00'],
        [],
        [`Semaine type A – Test (${fr(w1)} → ${fr(day(w2, 6))})`],
        ['Personne', 'Poste', ...jours, 'Heures/sem'],
        ['Léa TEST', 'Cheffe de cuisine', 'Repos', '10:00–14:00 / 18:30–22:30', 'Repos', 'Repos', 'Repos', 'Repos', 'Repos', '8'],
        ['Sam ESSAI (apprenti)', 'Barmaid – serveuse', '09:30–13:30 · prod Mijote', '17:00–fermeture (pause 30 min)', 'Repos', 'Repos', 'Repos', 'Repos', 'Repos', '11'],
        ['Inconnu (prestataire)', 'Programmation & bar', '—', 'Soirs d\'événement uniquement', '', '', '', '', ''],
        ['Heures travaillées par jour'],
        [`Semaine type B – Test (à partir du ${fr(w3)})`],
        ['Personne', 'Poste', ...jours],
        ['Léa TEST', 'Cheffe de cuisine', 'Repos', '09:00–17:00 (pause 30 min)', 'Repos', 'Repos', 'Repos', 'Repos', 'Repos'],
        [],
        ['Calendrier hebdomadaire'],
        ['Semaine du', 'Au', 'Phase', 'Sam', 'Prod Mijote (lundi)', '', 'Jours fériés', '', '', 'Remarques'],
        [fr(w1), fr(day(w1, 6)), 'A – Test', 'Nuba', 'Sam + gérant'],
        [fr(w2), fr(day(w2, 6)), 'A – Test', 'X (école)', 'Gérant'],
        [fr(w3), fr(day(w3, 6)), 'B – Croisière', 'Nuba', 'Sam + gérant'],
      ],
    };
    const { g, sent } = fakeGoogle({ ID_TB: { name: 'TABLEAU', tabs: PLAN } });
    run(buildAppsScript({ ...opts, saveursNomades: '', comptoir: '', tableau: 'ID_TB' }), g).envoyerMaintenant();
    const out = sent.find((x) => x.url.endsWith('/sync_planning'))!;
    const p = out.body.p_payload as { brand: string; from: string; to: string; shifts: { name: string; day: string; start: string; end: string; area: string; note: string }[] };
    expect(p.brand).toBe('planning');
    expect(p.from).toBe(today);
    expect(p.to).toBe(day(today, 41));
    const at = (name: string, d: string) => p.shifts.filter((x) => x.name === name && x.day === d).map((x) => `${x.start}-${x.end}|${x.area}|${x.note}`);
    expect(at('Léa TEST', day(w1, 1))).toEqual(['10:00-14:00|Cuisine|', '18:30-22:30|Cuisine|']);
    expect(at('Sam ESSAI (apprenti)', w1)).toEqual(['09:30-13:30|Bar|prod Mijote']);
    expect(at('Sam ESSAI (apprenti)', day(w1, 1))).toEqual(['17:00-00:00|Bar|pause 30 min']);
    expect(p.shifts.filter((x) => x.name.startsWith('Sam') && x.day >= w2 && x.day < w3)).toEqual([]);   // à l'école
    expect(at('Léa TEST', day(w3, 1))).toEqual(['09:00-17:00|Cuisine|pause 30 min']);
    expect(at('Léa TEST', day(w4, 1))).toEqual(['09:00-17:00|Cuisine|pause 30 min']);   // la semaine B continue sans calendrier
    expect(p.shifts.filter((x) => x.day < w1)).toEqual([]);
    expect(p.shifts.some((x) => x.name.startsWith('Inconnu'))).toBe(false);
  });

  it('remplit « Saisie hebdo » avec les fermetures de caisse, sans écraser une saisie à la main', () => {
    const SAISIE: Record<string, Cell[][]> = {
      'Saisie hebdo': [
        ['Saisie du lundi'], ['Explications'], [],
        ['Semaine du (lundi)', 'CA TTC Nuba', 'dont CB', 'Couverts', 'Bière vendue (litres)'],
        ['16/11/2026', '', '', '', ''],
        ['23/11/2026', '5000', '', '', ''],
        ['30/11/2026', '', '', '', ''],
      ],
    };
    const weeks = '{"ok":true,"weeks":[{"week":"2026-11-16","ca_ttc":1200.5,"card":900,"covers":80,"days":3},{"week":"2026-11-23","ca_ttc":7000,"card":5000,"covers":300,"days":6}]}';
    const { g, sent, notes } = fakeGoogle({ ID_TB: { name: 'TABLEAU', tabs: SAISIE } }, (url) => (url.endsWith('/closings_weekly') ? weeks : '{"ok":true,"counts":{}}'));
    run(buildAppsScript({ ...opts, saveursNomades: '', comptoir: '', tableau: 'ID_TB' }), g).envoyerMaintenant();
    expect(sent[0].url).toBe('https://projet.supabase.co/rest/v1/rpc/closings_weekly');
    expect(sent[0].body).toEqual({ p_key: 'nuba_cle' });
    const t = SAISIE['Saisie hebdo'];
    expect(t[4].slice(1, 4)).toEqual([1200.5, 900, 80]);
    expect(t[5].slice(1, 4)).toEqual(['5000', 5000, 300]);   // le CA tapé à la main reste
    expect(t[6].slice(1, 4)).toEqual(['', '', '']);
    expect(notes.get('Saisie hebdo!5,2')).toMatch(/^Nuba Gestion : total des fermetures de caisse \(3 jours\)/);
    // Le tableau de bord part ensuite, avec les chiffres à jour.
    expect(sent[1].url).toBe('https://projet.supabase.co/rest/v1/rpc/sync_dashboard');
  });

  it('copie le dossier des salariés : même arborescence, fichiers nouveaux ou modifiés, Google Docs en PDF', () => {
    const at = new Date(Date.UTC(2026, 10, 20, 9));
    const ROOT: FakeFolder = { id: 'RacineTest0001', name: 'DOSSIER TEST', files: [], folders: [
      { id: 'DossierLea0001', name: 'LÉA TEST', files: [], folders: [
        { id: 'DossierDpae001', name: 'DPAE', folders: [], files: [{ id: 'FichierDpae001', name: 'DPAE Léa.pdf', mime: 'application/pdf', size: 12, modified: at, data: 'pdf-dpae' }] },
        { id: 'DossierContr01', name: 'CONTRATS DE TRAVAIL (SIGNES)', folders: [], files: [{ id: 'FichierDoc0001', name: 'Avenant', mime: 'application/vnd.google-apps.document', size: 0, modified: at, data: 'doc' }] },
      ] },
      { id: 'DossierFiche01', name: 'FICHES DE POSTE', folders: [], files: [
        { id: 'FichierForm001', name: 'Questionnaire', mime: 'application/vnd.google-apps.form', size: 0, modified: at, data: '' },
        { id: 'FichierVideo01', name: 'Vidéo.mp4', mime: 'video/mp4', size: 60 * 1024 * 1024, modified: at, data: '' },
      ] },
    ] };
    const answer = (url: string, method: string) => {
      if (url.endsWith('/drive_plan')) return JSON.stringify({ ok: true, counts: {}, remove: ['drive/FichierVieux01/1'],
        upload: [{ id: 'FichierDpae001', path: 'drive/FichierDpae001/111', mime: 'application/pdf' }, { id: 'FichierDoc0001', path: 'drive/FichierDoc0001/222', mime: 'application/pdf' }] });
      if (url.endsWith('/drive_done')) return '{"ok":true,"copied":2,"remove":["drive/FichierDpae001/100"]}';
      if (url.includes('/storage/')) return method === 'delete' ? '{"message":"Successfully deleted"}' : '{"Key":"staff-docs/x"}';
      return '{"ok":true,"counts":{}}';
    };
    const { g, sent } = fakeGoogle({}, answer, ROOT);
    const gs = run(buildAppsScript({ ...opts, saveursNomades: '', comptoir: '', documents: 'RacineTest0001' }), g);
    gs.envoyerMaintenant();
    const plan = sent[0];
    expect(plan.url).toBe('https://projet.supabase.co/rest/v1/rpc/drive_plan');
    expect(plan.body.p_payload).toEqual({
      brand: 'documents', root: 'DOSSIER TEST',
      tops: [{ id: 'DossierLea0001', name: 'LÉA TEST' }, { id: 'DossierFiche01', name: 'FICHES DE POSTE' }],
      files: [
        { id: 'FichierDoc0001', folder: ['LÉA TEST', 'CONTRATS DE TRAVAIL (SIGNES)'], name: 'Avenant.pdf', mime: 'application/pdf', size: null, modified: '2026-11-20T09:00:00.000Z' },
        { id: 'FichierDpae001', folder: ['LÉA TEST', 'DPAE'], name: 'DPAE Léa.pdf', mime: 'application/pdf', size: 12, modified: '2026-11-20T09:00:00.000Z' },
      ],
      problems: ['Trop lourd pour l\'appli (plus de 45 Mo) : FICHES DE POSTE / Vidéo.mp4'],
    });
    const storage = sent.filter((x) => x.url.includes('/storage/v1/'));
    expect(storage.map((x) => `${x.method} ${x.url.replace('https://projet.supabase.co/storage/v1/object/staff-docs/', '')}`)).toEqual([
      'delete drive/FichierVieux01/1', 'post drive/FichierDpae001/111', 'post drive/FichierDoc0001/222', 'delete drive/FichierDpae001/100',
    ]);
    expect(storage[1]).toMatchObject({ contentType: 'application/pdf', bytes: 'pdf-dpae', headers: { apikey: 'sb_publishable_x' } });
    expect(storage[2].bytes).toBe('application/pdf:doc');   // le Google Doc, exporté en PDF
    expect(sent.find((x) => x.url.endsWith('/drive_done'))!.body.p_done).toEqual([
      { id: 'FichierDpae001', path: 'drive/FichierDpae001/111' }, { id: 'FichierDoc0001', path: 'drive/FichierDoc0001/222' }]);
    // Rien n'a changé dans le Drive : la liste ne repart pas.
    sent.length = 0;
    gs.envoyerSiChangement();
    expect(sent).toHaveLength(0);
  });

  it('envoie les produits de PRIX INGREDIENTS, colonnes retrouvées par leur titre', () => {
    const PRIX: Record<string, Cell[][]> = {
      'PRIX INGREDIENTS': [
        ['Catégorie', 'Ingrédient', 'Fournisseur retenu (le moins cher, automatique)', "Prix d'achat HT retenu (€, automatique)", "Unité d'achat", "Poids d'une pièce (g)",
          'Prix unitaire recette (€)', 'Unité en recette', 'Date de la facture retenue', 'Source du prix retenu', 'Allergènes', "Nom sur l'étiquette", 'Allergènes à vérifier',
          "Poids moyen d'une pièce (g) – pour l'étiquette"],
        ['LEGUMES', 'Carotte test', 'Primeur test', { d: '1,50 €', v: 1.5 }, 'kg', '', { d: '0,0015 €', v: 0.0015 }, 'g', '20/11/2026', 'Facture test', '', '', '', '120'],
        ['', '', '', '', '', '', '', '', '', '', '', '', '', ''],
        ['CREMERIE', 'Crème test', 'Grossiste test', { d: '3,60 €', v: 3.6 }, 'L', { d: '50', v: 50 }, '', 'ml', '', '', 'Lait', 'Crème', '', ''],
      ],
    };
    const { g, sent, props } = fakeGoogle({ ID_NB: { name: 'MERCURIALE NUBA TEST', tabs: PRIX } });
    run(buildAppsScript({ ...opts, saveursNomades: '', comptoir: '', nuba: 'ID_NB' }), g).envoyerMaintenant();
    const out = sent.find((x) => x.url.endsWith('/sync_merc_products'))!;
    expect(out.body.p_payload).toEqual({
      brand: 'produits', file: 'MERCURIALE NUBA TEST', products: [
        { name: 'Carotte test', category: 'LEGUMES', supplier: 'Primeur test', unit: 'kg', invoice_date: '20/11/2026', source: 'Facture test', allergens: '', label: '', price: 1.5, piece_g: '' },
        { name: 'Crème test', category: 'CREMERIE', supplier: 'Grossiste test', unit: 'L', invoice_date: '', source: '', allergens: 'Lait', label: 'Crème', price: 3.6, piece_g: 50 },
      ],
    });
    expect(props.get('nuba_empreinte_produits')).toBeTruthy();
  });

  it("retrouve l'identifiant d'un dossier Drive dans son lien", () => {
    expect(folderId('https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz_012345?usp=sharing')).toBe('1AbCdEfGhIjKlMnOpQrStUvWxYz_012345');
    expect(folderId('https://drive.google.com/drive/u/0/folders/1AbCdEfGhIjKlMnOp')).toBe('1AbCdEfGhIjKlMnOp');
    expect(folderId('https://drive.google.com/open?id=1AbCdEfGhIjKlMnOp')).toBe('1AbCdEfGhIjKlMnOp');
    expect(folderId('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit')).toBe('');
  });

  it('une feuille non renseignée est ignorée', () => {
    const { g, sent } = fakeGoogle({ ID_SN: { name: 'SN', tabs: SN } });
    run(buildAppsScript({ ...opts, comptoir: '' }), g).envoyerMaintenant();
    expect(sent.map((x) => x.body.p_payload.brand)).toEqual(['saveurs_nomades']);
  });

  it('dit pourquoi un envoi est refusé, sans retenir la version refusée', () => {
    const { g, sent, props } = fakeGoogle({ ID_SN: { name: 'SN', tabs: SN }, ID_CM: { name: 'CM', tabs: CM } }, '{"ok":false,"error":"key"}');
    expect(() => run(buildAppsScript(opts), g).envoyerSiChangement()).toThrow(/clé refusée/);
    expect(sent).toHaveLength(2);
    expect(props.size).toBe(0);
  });
});
