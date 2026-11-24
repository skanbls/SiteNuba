import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildAppsScript, sheetId } from './appsScript';

/* Un faux Google : feuilles en mémoire, envois notés, déclencheurs comptés. */
type Plain = string | number | Date;
/** Une case : sa valeur, ou sa valeur et le texte affiché par la feuille. */
type Cell = Plain | { d: string; v: Plain };
const isShown = (c: Cell): c is { d: string; v: Plain } => typeof c === 'object' && !(c instanceof Date);
function fakeGoogle(files: Record<string, { name: string; tabs: Record<string, Cell[][]> }>, answer = '{"ok":true,"counts":{}}') {
  const sent: { url: string; body: { p_key: string; p_payload: Record<string, unknown> }; headers: Record<string, string> }[] = [];
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
          } : null),
        };
      },
    },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: (k: string) => props.get(k) ?? null, setProperty: (k: string, v: string) => props.set(k, v) }),
    },
    UrlFetchApp: {
      fetch: (url: string, o: { payload: string; headers: Record<string, string> }) => {
        sent.push({ url, body: JSON.parse(o.payload), headers: o.headers });
        return { getResponseCode: () => 200, getContentText: () => answer };
      },
    },
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
  return { g, sent, props, triggers };
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
