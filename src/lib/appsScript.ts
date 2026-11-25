/**
 * Script Google (Apps Script) qui envoie les mercuriales vers l'appli.
 * L'appli le génère avec la clé de synchronisation et l'identifiant des deux feuilles ;
 * le gérant le colle une fois dans script.google.com et lance « installer ».
 *
 * Il lit, dans Saveurs Nomades et Comptoir : RECETTES, COMPOSITION CALCUL, PRESTATIONS,
 * GRAMMAGES SUR MESURE (s'il existe) et, dans Saveurs Nomades, PRIX INGREDIENTS.
 * Les colonnes sont retrouvées par leur titre : l'ordre des colonnes peut changer.
 *
 * Dans la mercuriale Nuba (la carte du restaurant) : PRIX INGREDIENTS (le catalogue des stocks), FICHES PLATS, FICHES BOISSONS et
 * PREPARATIONS MAISON, faites de blocs (une fiche par bloc : « Plat », « Boisson » ou
 * « Préparation » en colonne A, puis ses réglages, puis ses ingrédients sous « Ingrédient »),
 * et la colonne « Allergènes à vérifier » de CALCUL. Chaque réglage est retrouvé par son titre.
 *
 * Dans le tableau de bord financier (gérants seulement) : les onglets Tableau de bord,
 * Tréso 13 semaines, Prévisionnel 12 mois et Historique KPI, tels qu'ils s'affichent
 * (texte affiché et valeurs brutes). L'appli les lit elle-même.
 *
 * Dans « Contenu du site » (le fichier qui alimente le site web) : Programmation, Chaque semaine,
 * Exposition et Œuvres, tels qu'ils s'affichent (les dates en AAAA-MM-JJ). La base en fait des événements.
 */

/**
 * Identifiant d'une feuille Google à partir de son lien, ou chaîne vide.
 * Accepte le lien de la barre d'adresse, celui de « Copier le lien » (Sheets ou Drive, ordinateur ou téléphone),
 * et l'identifiant seul. Refuse le lien de publication (/d/e/…), qui ne donne pas accès à la feuille.
 */
export function sheetId(url: string): string {
  const t = url.trim();
  if (/\/d\/e\//.test(t)) return '';
  const m = /\/(?:spreadsheets\/)?(?:file\/)?d\/([A-Za-z0-9_-]{15,})/.exec(t) ?? /[?&]id=([A-Za-z0-9_-]{15,})/.exec(t) ?? /^([A-Za-z0-9_-]{25,})$/.exec(t);
  return m?.[1] ?? '';
}

/**
 * Identifiant d'un dossier Google Drive à partir de son lien (« Copier le lien », barre d'adresse,
 * ordinateur ou téléphone), ou de l'identifiant seul ; chaîne vide sinon.
 */
export function folderId(url: string): string {
  const t = url.trim();
  const m = /\/folders\/([A-Za-z0-9_-]{10,})/.exec(t) ?? /[?&]id=([A-Za-z0-9_-]{10,})/.exec(t) ?? /^([A-Za-z0-9_-]{25,})$/.exec(t);
  return m?.[1] ?? '';
}

export interface ScriptOptions {
  /** Adresse du projet Supabase. */
  url: string;
  /** Clé publique du projet. */
  publicKey: string;
  /** Clé de synchronisation, montrée une seule fois. */
  syncKey: string;
  saveursNomades: string;
  comptoir: string;
  /** Mercuriale Nuba (la carte du restaurant), ou chaîne vide. */
  nuba?: string;
  /** Tableau de bord financier (gérants seulement), ou chaîne vide. */
  tableau?: string;
  /** Contenu du site (programmation, exposition), ou chaîne vide. */
  site?: string;
  /** Dossier Drive des salariés (identifiant du dossier), ou chaîne vide. */
  documents?: string;
  /** Date affichée en tête du script. */
  date: string;
}

export function buildAppsScript(o: ScriptOptions): string {
  const conf = {
    adresse: `${o.url.replace(/\/$/, '')}/rest/v1/rpc/sync_mercuriale`,
    adresseCarte: `${o.url.replace(/\/$/, '')}/rest/v1/rpc/sync_carte`,
    adresseTableau: `${o.url.replace(/\/$/, '')}/rest/v1/rpc/sync_dashboard`,
    adresseSite: `${o.url.replace(/\/$/, '')}/rest/v1/rpc/sync_site`,
    adressePlanning: `${o.url.replace(/\/$/, '')}/rest/v1/rpc/sync_planning`,
    adresseCaisse: `${o.url.replace(/\/$/, '')}/rest/v1/rpc/closings_weekly`,
    adresseProduits: `${o.url.replace(/\/$/, '')}/rest/v1/rpc/sync_merc_products`,
    adresseDocuments: `${o.url.replace(/\/$/, '')}/rest/v1/rpc/drive_plan`,
    adresseDocumentsFaits: `${o.url.replace(/\/$/, '')}/rest/v1/rpc/drive_done`,
    adresseStockage: `${o.url.replace(/\/$/, '')}/storage/v1/object/staff-docs/`,
    dossierSalaries: o.documents ?? '',
    clePublique: o.publicKey,
    cleSynchro: o.syncKey,
    mercuriales: { saveurs_nomades: o.saveursNomades, comptoir: o.comptoir, nuba: o.nuba ?? '', tableau: o.tableau ?? '', site: o.site ?? '' },
  };
  return `/**
 * Nuba Gestion : envoie les mercuriales Saveurs Nomades, Comptoir Méditerranéen et Nuba,
 * le tableau de bord financier, le contenu du site (programmation, exposition) et une copie
 * du dossier Drive des salariés vers l'appli.
 * Généré par l'appli (Administration, Mercuriales) le ${o.date}.
 *
 * Mise en route, une seule fois :
 *   1. Enregistre ce projet (icône disquette).
 *   2. En haut, choisis la fonction « installer », puis clique sur Exécuter.
 *   3. Google demande d'autoriser l'accès à tes feuilles, à ton Drive (lecture du dossier des salariés)
 *      et aux services externes : accepte.
 * Ensuite, toutes les 10 minutes, ce qui a changé dans les mercuriales part tout seul vers l'appli.
 * Pour forcer un envoi tout de suite : fonction « envoyerMaintenant ».
 *
 * La clé ci-dessous ne sert qu'à envoyer les mercuriales. Ne la partage pas.
 */
var NUBA = ${JSON.stringify(conf, null, 2)};

function installer() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'envoyerSiChangement'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('envoyerSiChangement').timeBased().everyMinutes(10).create();
  envoyerMaintenant();
}

function envoyerMaintenant() { nubaEnvoyer_(true); }

function envoyerSiChangement() { nubaEnvoyer_(false); }

function nubaEnvoyer_(force) {
  var debut = Date.now();
  var props = PropertiesService.getScriptProperties();
  var erreurs = [];
  // D'abord les chiffres de caisse dans « Saisie hebdo » : le tableau de bord part ensuite avec eux.
  if (NUBA.mercuriales.tableau) {
    try { nubaCaisseHebdo_(); } catch (e) { erreurs.push('caisse : ' + (e && e.message ? e.message : e)); }
  }
  ['saveurs_nomades', 'comptoir', 'nuba', 'tableau', 'site'].forEach(function (marque) {
    var id = NUBA.mercuriales[marque];
    if (!id) return;
    try {
      var ss = SpreadsheetApp.openById(id);
      var contenu;
      if (marque === 'nuba') {
        var carte = nubaCarte_(ss);
        contenu = { brand: marque, file: ss.getName(), items: carte.items, lines: carte.lines };
      } else if (marque === 'tableau') {
        contenu = { brand: marque, file: ss.getName(), tabs: nubaFinances_(ss) };
      } else if (marque === 'site') {
        contenu = nubaSite_(ss);
        contenu.brand = marque;
        contenu.file = ss.getName();
      } else {
        contenu = {
          brand: marque,
          file: ss.getName(),
          recipes: nubaRecettes_(ss),
          lines: nubaLignes_(ss),
          orders: nubaCommandes_(ss),
          roles: nubaRoles_(ss)
        };
      }
      if (marque === 'saveurs_nomades') contenu.ingredients = nubaIngredients_(ss);
      var texte = JSON.stringify(contenu);
      var empreinte = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, texte, Utilities.Charset.UTF_8));
      var dernier = Number(props.getProperty('nuba_envoi_' + marque) || 0);
      // Rien n'a changé : on n'envoie qu'une fois toutes les six heures, pour dire que tout va bien.
      if (!force && props.getProperty('nuba_empreinte_' + marque) === empreinte && Date.now() - dernier < 6 * 3600 * 1000) return;
      var adresse = marque === 'nuba' ? NUBA.adresseCarte : marque === 'tableau' ? NUBA.adresseTableau : marque === 'site' ? NUBA.adresseSite : NUBA.adresse;
      var rep = UrlFetchApp.fetch(adresse, {
        method: 'post',
        contentType: 'application/json',
        muteHttpExceptions: true,
        headers: { apikey: NUBA.clePublique },
        payload: JSON.stringify({ p_key: NUBA.cleSynchro, p_payload: contenu })
      });
      var corps = rep.getContentText();
      var res = null;
      try { res = JSON.parse(corps); } catch (e) { res = null; }
      if (rep.getResponseCode() !== 200 || !res || res.ok !== true) {
        erreurs.push(marque + ' : ' + nubaRaison_(res, rep.getResponseCode(), corps, marque));
        return;
      }
      props.setProperty('nuba_empreinte_' + marque, empreinte);
      props.setProperty('nuba_envoi_' + marque, String(Date.now()));
      console.log('Nuba, ' + marque + ' envoyé : ' + JSON.stringify(res.counts));
    } catch (e) {
      erreurs.push(marque + ' : ' + (e && e.message ? e.message : e));
    }
  });
  // Les produits de la mercuriale Nuba (onglet PRIX INGREDIENTS) : le catalogue des stocks.
  if (NUBA.mercuriales.nuba) {
    try { nubaProduitsEnvoyer_(props, force); } catch (e) { erreurs.push('produits : ' + (e && e.message ? e.message : e)); }
  }
  // Le planning de l'onglet « Planning équipe » du tableau de bord.
  if (NUBA.mercuriales.tableau) {
    try { nubaPlanningEnvoyer_(props, force); } catch (e) { erreurs.push('planning : ' + (e && e.message ? e.message : e)); }
  }
  // La copie du dossier des salariés, en dernier : elle s'arrête d'elle-même avant la limite de temps de Google.
  if (NUBA.dossierSalaries) {
    try { nubaDocumentsEnvoyer_(props, force, debut, erreurs); } catch (e) { erreurs.push('documents : ' + (e && e.message ? e.message : e)); }
  }
  if (erreurs.length) throw new Error('Envoi vers Nuba incomplet. ' + erreurs.join(' | '));
}

function nubaRaison_(res, code, corps, marque) {
  if (res && res.error === 'key') return "clé refusée. Génère un nouveau script dans l'appli (Administration, Mercuriales).";
  if (res && res.error === 'too_many') return 'trop d\\'envois en peu de temps, nouvel essai dans 10 minutes.';
  if (res && res.error === 'payload') return 'contenu illisible (onglet renommé ou vidé ?).';
  if (res && res.error === 'empty') return "le dossier des salariés paraît vide : rien n'a été retiré. Vérifie son lien dans l'appli.";
  if (res && res.error === 'db') return 'refusé par la base : ' + res.message;
  if (code === 404) return "l'appli attend la mise à jour " + ({ nuba: '0017', tableau: '0019', site: '0024', caisse: '0026', planning: '0027', documents: '0028', produits: '0029' }[marque] || '0011') + ' de sa base.';
  return 'réponse ' + code + ' : ' + String(corps).slice(0, 200);
}

// ---------- Lecture des onglets ----------

function nubaNorme_(t) {
  return String(t == null ? '' : t).replace(/\\s+/g, ' ').trim().toLowerCase();
}

/** Lignes d'un onglet sous la ligne de titres, trouvée parmi les 10 premières grâce au titre « cle ». */
function nubaTableau_(ss, onglet, cle) {
  var sh = ss.getSheetByName(onglet);
  if (!sh) return null;
  var v = sh.getDataRange().getValues();
  for (var i = 0; i < Math.min(v.length, 10); i++) {
    if (v[i].some(function (c) { return nubaNorme_(c) === nubaNorme_(cle); })) {
      return { entetes: v[i].map(nubaNorme_), lignes: v.slice(i + 1) };
    }
  }
  return null;
}

/** Colonne de chaque champ : titre exact d'abord, puis titre qui commence pareil. */
function nubaColonnes_(entetes, champs) {
  var c = {};
  Object.keys(champs).forEach(function (k) {
    var noms = champs[k].map(nubaNorme_);
    var i = entetes.findIndex(function (h) { return noms.indexOf(h) !== -1; });
    if (i === -1) i = entetes.findIndex(function (h) { return noms.some(function (n) { return h.indexOf(n) === 0; }); });
    c[k] = i;
  });
  return c;
}

function nubaValeur_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Europe/Paris', 'yyyy-MM-dd');
  if (typeof v === 'number') return Math.round(v * 1e6) / 1e6;
  if (typeof v === 'string') return v.trim();
  return v;
}

function nubaObjets_(t, champs, obligatoire) {
  if (!t) return [];
  var c = nubaColonnes_(t.entetes, champs);
  if (c[obligatoire] === -1) return [];
  var out = [];
  t.lignes.forEach(function (l) {
    var o = {};
    Object.keys(c).forEach(function (k) {
      if (c[k] === -1) return;
      var v = nubaValeur_(l[c[k]]);
      if (v !== '' && v !== null && v !== undefined) o[k] = v;
    });
    if (o[obligatoire] !== undefined) out.push(o);
  });
  return out;
}

function nubaRecettes_(ss) {
  return nubaObjets_(nubaTableau_(ss, 'RECETTES', 'Recette'), {
    name: ['Recette'],
    category: ['Catégorie'],
    portions: ['Portions produites par la fiche'],
    portion_weight: ["Poids d'une portion (g)"],
    cost_portion: ['Coût matière / portion (€)'],
    cost_portion_losses: ['Coût / portion avec pertes (€)'],
    sale_price: ['Prix de vente HT (€)'],
    cost_pct: ['Coût matière %'],
    status: ['État de la fiche'],
    label: ['Ingrédients (étiquette'],
    allergens: ['Allergènes']
  }, 'name');
}

function nubaLignes_(ss) {
  return nubaObjets_(nubaTableau_(ss, 'COMPOSITION CALCUL', 'Ingrédient'), {
    recipe: ['Recette'],
    ingredient: ['Ingrédient'],
    quantity: ['Quantité', 'Quantité pour la fiche'],
    unit: ['Unité'],
    supplier: ['Fournisseur'],
    allergens: ['Allergènes'],
    loss: ['Coefficient de pertes']
  }, 'ingredient');
}

function nubaCommandes_(ss) {
  return nubaObjets_(nubaTableau_(ss, 'PRESTATIONS', 'Plat'), {
    day: ['Date de livraison'],
    formula: ['Type de formule', 'Catégorie'],
    dish: ['Plat'],
    portions: ['Portions'],
    check: ['Contrôle des fiches'],
    factor_base: ['Facteur base'],
    factor_protein: ['Facteur protéine'],
    factor_vegetable: ['Facteur légume'],
    factor_sauce: ['Facteur sauce']
  }, 'dish');
}

function nubaRoles_(ss) {
  return nubaObjets_(nubaTableau_(ss, 'GRAMMAGES SUR MESURE', 'Rôle'), {
    recipe: ['Recette'],
    role: ['Rôle']
  }, 'role');
}

function nubaIngredients_(ss) {
  return nubaObjets_(nubaTableau_(ss, 'PRIX INGREDIENTS', 'Ingrédient'), {
    name: ['Ingrédient'],
    category: ['Catégorie'],
    supplier: ['Fournisseur retenu'],
    purchase_price: ["Prix d'achat HT retenu"],
    purchase_unit: ["Unité d'achat"],
    piece_weight: ["Poids d'une pièce (g)"],
    recipe_unit_price: ['Prix unitaire recette'],
    recipe_unit: ['Unité en recette'],
    allergens: ['Allergènes']
  }, 'name');
}

// ---------- Mercuriale Nuba : la carte, en blocs ----------

var NUBA_DEBUTS = { 'plat': 1, 'boisson': 1, 'préparation': 1 };

// Réglages d'une fiche : titre (début du texte de la case) et champ envoyé.
var NUBA_CHAMPS = [
  ['catégorie', 'category'], ['état de la fiche', 'status'], ['portions produites', 'portions'],
  ['prix de vente ttc', 'sale_price'], ['taux de tva', 'vat'], ['coût matière / portion', 'cost_portion'],
  ['prix de vente ht', 'sale_price_ht'], ['marge brute', 'margin'], ['coût matière %', 'cost_pct'],
  ['coefficient', 'coefficient'], ['objectif coût matière', 'target_pct'], ['prix ttc conseillé', 'suggested_price'],
  ['allergènes', 'allergens'], ['rendement : quantité', 'yield_qty'], ['unité du rendement', 'yield_unit'],
  ['unité dans les fiches', 'recipe_unit'], ['coût matière total', 'cost_total'], ['coût par kg', 'cost_unit'],
  ['coût par unité', 'cost_recipe_unit'], ['utilisée dans', 'used_in']
];

var NUBA_LIGNE = {
  ingredient: ['Ingrédient'],
  quantity: ['Quantité nette pour la fiche', 'Dose'],
  unit: ['Unité'],
  loss: ['Pertes'],
  gross: ['Quantité brute'],
  unit_price: ['Prix unitaire'],
  cost: ['Coût avec pertes'],
  supplier: ['Fournisseur'],
  allergens: ['Allergènes']
};

function nubaChamp_(t) {
  for (var i = 0; i < NUBA_CHAMPS.length; i++) if (t.indexOf(NUBA_CHAMPS[i][0]) === 0) return NUBA_CHAMPS[i][1];
  return null;
}

/** Les réglages d'une ligne du haut de la fiche : la valeur suit son titre, une ou deux cases à droite. */
function nubaReglages_(ligne, fiche) {
  for (var c = 0; c < ligne.length; c++) {
    var k = nubaChamp_(nubaNorme_(ligne[c]));
    if (!k) continue;
    var v = '';
    for (var d = 1; d <= 2 && c + d < ligne.length; d++) {
      var x = ligne[c + d];
      if (x === '' || x === null || x === undefined) continue;
      if (typeof x === 'string' && nubaChamp_(nubaNorme_(x))) break;
      v = x;
      break;
    }
    v = nubaValeur_(v);
    if (v !== '' && v !== null && v !== undefined && fiche[k] === undefined) fiche[k] = v;
  }
}

/** Allergènes à vérifier de chaque ingrédient de la base (onglet CALCUL). */
function nubaAVerifier_(ss) {
  var m = {};
  nubaObjets_(nubaTableau_(ss, 'CALCUL', 'Ingrédient (base de prix)'), {
    name: ['Ingrédient (base de prix)'],
    check: ['Allergènes à vérifier']
  }, 'name').forEach(function (o) {
    if (o.check !== undefined && String(o.check) !== '') m[nubaNorme_(o.name)] = String(o.check);
  });
  return m;
}

function nubaCarte_(ss) {
  var out = { items: [], lines: [] };
  var bloc = 0;
  var verif = nubaAVerifier_(ss);
  [['FICHES PLATS', 'plat'], ['FICHES BOISSONS', 'boisson'], ['PREPARATIONS MAISON', 'preparation']].forEach(function (o) {
    var sh = ss.getSheetByName(o[0]);
    if (!sh) return;
    var fiche = null;
    var cols = null;
    sh.getDataRange().getValues().forEach(function (ligne) {
      var a = nubaNorme_(ligne[0]);
      if (NUBA_DEBUTS[a]) {
        var nom = nubaValeur_(ligne[1]);
        cols = null;
        fiche = null;
        if (nom === '' || nom === null || nom === undefined) return;   // fiche vide, prête à remplir
        bloc++;
        fiche = { kind: o[1], block: bloc, name: String(nom) };
        nubaReglages_(ligne, fiche);
        out.items.push(fiche);
        return;
      }
      if (!fiche) return;
      if (a === 'ingrédient') {
        cols = nubaColonnes_(ligne.map(nubaNorme_), NUBA_LIGNE);
        return;
      }
      if (!cols) {
        nubaReglages_(ligne, fiche);
        return;
      }
      if (a === '') return;
      var l = { kind: fiche.kind, block: fiche.block, recipe: fiche.name };
      Object.keys(cols).forEach(function (k) {
        if (cols[k] === -1) return;
        var v = nubaValeur_(ligne[cols[k]]);
        if (v !== '' && v !== null && v !== undefined) l[k] = v;
      });
      var aVerifier = verif[nubaNorme_(l.ingredient)];
      if (aVerifier) l.check = aVerifier;
      out.lines.push(l);
    });
  });
  return out;
}

// ---------- Tableau de bord financier : les onglets tels qu'ils s'affichent ----------

var NUBA_FINANCES = ['Tableau de bord', 'Tréso 13 semaines', 'Prévisionnel 12 mois', 'Historique KPI'];

function nubaFinances_(ss) {
  var tabs = {};
  NUBA_FINANCES.forEach(function (nom) {
    var sh = ss.getSheetByName(nom);
    if (!sh) return;
    var r = sh.getDataRange();
    var d = r.getDisplayValues();
    var v = r.getValues();
    // Lignes et colonnes vides de la fin retirées ; 30 colonnes au plus.
    var hauteur = 0, largeur = 0;
    d.forEach(function (ligne, i) {
      ligne.forEach(function (c, j) {
        if (String(c).trim() !== '') { hauteur = Math.max(hauteur, i + 1); largeur = Math.max(largeur, j + 1); }
      });
    });
    largeur = Math.min(largeur, 30);
    var lignes = [];
    for (var i = 0; i < hauteur; i++) lignes.push(i);
    // Historique : la ligne de titres et les 300 dernières lignes.
    if (lignes.length > 301) lignes = [0].concat(lignes.slice(lignes.length - 300));
    if (lignes.length > 400) lignes = lignes.slice(0, 400);
    tabs[nom] = {
      d: lignes.map(function (i) { return d[i].slice(0, largeur).map(function (c) { return String(c).trim(); }); }),
      v: lignes.map(function (i) { return v[i].slice(0, largeur).map(function (c) { var x = nubaValeur_(c); return x === undefined ? '' : x; }); })
    };
  });
  return tabs;
}

// ---------- Contenu du site : programmation, rendez-vous, exposition ----------

/** Un onglet en lignes { titre de colonne : texte affiché } ; une date en AAAA-MM-JJ. Lignes vides retirées. */
function nubaSiteLignes_(ss, onglet, champs) {
  var sh = ss.getSheetByName(onglet);
  if (!sh) return [];
  var r = sh.getDataRange();
  var v = r.getValues();
  var d = r.getDisplayValues();
  var cle = nubaNorme_(champs[0]);
  var h = -1;
  for (var i = 0; i < Math.min(v.length, 5); i++) {
    if (v[i].some(function (c) { return nubaNorme_(c) === cle; })) { h = i; break; }
  }
  if (h === -1) return [];
  var entetes = v[h].map(nubaNorme_);
  var col = {};
  champs.forEach(function (nom) {
    var n = nubaNorme_(nom);
    var k = entetes.indexOf(n);
    if (k === -1) k = entetes.findIndex(function (e) { return e.indexOf(n) === 0 && e.indexOf('réf.') !== 0; });
    col[nom] = k;
  });
  var out = [];
  for (var j = h + 1; j < v.length && out.length < 500; j++) {
    var o = {};
    champs.forEach(function (nom) {
      var k = col[nom];
      if (k === -1) return;
      var x = v[j][k] instanceof Date ? Utilities.formatDate(v[j][k], 'Europe/Paris', 'yyyy-MM-dd') : String(d[j][k]).trim();
      if (x !== '') o[nom] = x.slice(0, 2000);
    });
    if (Object.keys(o).length) out.push(o);
  }
  return out;
}

function nubaSite_(ss) {
  var expo = {};
  nubaSiteLignes_(ss, 'Exposition', ['Champ', 'Français']).forEach(function (l) {
    if (l['Champ']) expo[String(l['Champ']).replace(/’/g, "'")] = l['Français'] || '';
  });
  return {
    programme: nubaSiteLignes_(ss, 'Programmation', ['Date', 'Type', 'Titre', 'Description', 'Horaire', 'Entrée', 'Visible', 'Affiche']),
    weekly: nubaSiteLignes_(ss, 'Chaque semaine', ['Jour', 'Rendez-vous', 'Horaire', 'Visible']),
    expo: expo,
    works: nubaSiteLignes_(ss, 'Œuvres', ['Titre', 'Technique', 'Dimensions', 'Image', 'Visible'])
  };
}

// ---------- Caisse : les semaines terminées dans « Saisie hebdo » (CA TTC, dont CB, couverts) ----------
// Une case remplie à la main reste telle quelle ; l'appli ne réécrit que les cases vides ou celles qu'elle a remplies.
var NUBA_NOTE_CAISSE = 'Nuba Gestion : total des fermetures de caisse';

function nubaCaisseHebdo_() {
  var ss = SpreadsheetApp.openById(NUBA.mercuriales.tableau);
  var sh = ss.getSheetByName('Saisie hebdo');
  if (!sh) return;
  var rep = UrlFetchApp.fetch(NUBA.adresseCaisse, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { apikey: NUBA.clePublique }, payload: JSON.stringify({ p_key: NUBA.cleSynchro })
  });
  if (rep.getResponseCode() === 404) return;   // base pas encore à jour : rien à écrire
  var corps = rep.getContentText();
  var res = null;
  try { res = JSON.parse(corps); } catch (e) { res = null; }
  if (rep.getResponseCode() !== 200 || !res || res.ok !== true) throw new Error(nubaRaison_(res, rep.getResponseCode(), corps, 'caisse'));
  var semaines = {};
  (res.weeks || []).forEach(function (w) { semaines[w.week] = w; });
  var d = sh.getDataRange().getDisplayValues();
  var h = -1, col = {};
  for (var i = 0; i < Math.min(d.length, 10) && h === -1; i++) {
    d[i].forEach(function (c, j) {
      var t = nubaNorme_(c);
      if (t.indexOf('semaine du') === 0) { h = i; col.semaine = j; }
      else if (t.indexOf('ca ttc') === 0 && col.ca === undefined) col.ca = j;
      else if (t.indexOf('dont cb') === 0) col.cb = j;
      else if (t === 'couverts') col.couverts = j;
    });
  }
  if (h === -1) return;
  for (var r = h + 1; r < d.length; r++) {
    var lundi = nubaDateIso_(d[r][col.semaine]);
    var w = semaines[lundi];
    if (!w) continue;
    [['ca', w.ca_ttc], ['cb', w.card], ['couverts', w.covers]].forEach(function (x) {
      var c = col[x[0]];
      if (c === undefined || x[1] === null || x[1] === undefined) return;
      var cell = sh.getRange(r + 1, c + 1);
      if (String(d[r][c]).trim() !== '' && String(cell.getNote() || '').indexOf(NUBA_NOTE_CAISSE) !== 0) return;
      cell.setValue(Number(x[1]));
      cell.setNote(NUBA_NOTE_CAISSE + ' (' + w.days + ' jour' + (w.days > 1 ? 's' : '') + ').');
    });
  }
}

// ---------- Planning : semaines types et calendrier de l'onglet « Planning équipe » ----------
var NUBA_JOURS = ['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'];
var NUBA_HORIZON = 42;   // jours

function nubaSansAccent_(t) {
  return nubaNorme_(t).normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function nubaPad_(n) { n = String(n); return n.length < 2 ? '0' + n : n; }
/** « 18/12/2026 » → « 2026-12-18 », ou ''. */
function nubaDateIso_(t) {
  var m = /(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})/.exec(String(t || ''));
  return m ? m[3] + '-' + nubaPad_(m[2]) + '-' + nubaPad_(m[1]) : '';
}
function nubaJourPlus_(iso, n) {
  var x = new Date(iso + 'T12:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
/** 0 pour lundi … 6 pour dimanche. */
function nubaJourIdx_(iso) { return (new Date(iso + 'T12:00:00Z').getUTCDay() + 6) % 7; }

/** Colonnes des jours d'une ligne de titres (« Lun », « Mar »…), ou null. */
function nubaColonnesJours_(ligne) {
  var col = {}, n = 0;
  ligne.forEach(function (c, j) {
    var k = NUBA_JOURS.indexOf(nubaSansAccent_(c).slice(0, 3));
    if (k !== -1 && nubaSansAccent_(c).length <= 9 && col[k] === undefined) { col[k] = j; n++; }
  });
  return n >= 5 ? col : null;
}

/** Les créneaux d'une case : « 10:00–14:00 / 18:30–22:30 », « 18:00–fermeture », « 09:30–13:30 · prod Mijote »… */
function nubaCreneaux_(cell, fermeture) {
  var t = String(cell || '').trim();
  if (!/\\d/.test(t)) return [];
  var note = '';
  var m = /·\\s*(.+)$/.exec(t);
  if (m) { note = m[1].trim(); t = t.slice(0, m.index).trim(); }
  var out = [];
  t.split('/').forEach(function (seg) {
    var r = /(\\d{1,2})\\s*[:hH]\\s*(\\d{2})?\\s*[–—-]\\s*(?:(\\d{1,2})\\s*[:hH]\\s*(\\d{2})?|(fermeture))/i.exec(seg);
    if (!r) return;
    var fin = r[5] ? fermeture : nubaPad_(r[3]) + ':' + (r[4] || '00');
    if (!fin) return;
    var p = /pause\\s*(\\d+)\\s*min/i.exec(seg);
    out.push({ start: nubaPad_(r[1]) + ':' + (r[2] || '00'), end: fin, note: [p ? 'pause ' + p[1] + ' min' : '', note].filter(Boolean).join(' · ') });
  });
  return out;
}

/** Le poste de l'appli d'après l'intitulé : Cuisine, Bar ou Salle. */
function nubaZone_(poste) {
  var p = nubaSansAccent_(poste);
  if (/cuisin|chef|commis|apprenti|plong/.test(p)) return 'Cuisine';
  var s = p.search(/salle|serveu|polyvalent/), b = p.search(/\\bbar/);
  if (b !== -1 && (s === -1 || b < s)) return 'Bar';
  return s !== -1 ? 'Salle' : '';
}

function nubaPlanning_(ss, aujourdhui) {
  var sh = ss.getSheetByName('Planning équipe');
  if (!sh) return null;
  var d = sh.getDataRange().getDisplayValues();
  var fermeture = {}, types = [], calendrier = {};
  for (var i = 0; i < d.length; i++) {
    var a = String(d[i][0] || '').trim();
    // Horaires d'ouverture : la première ligne après les titres des jours donne l'heure de fermeture.
    if (/^horaires d.ouverture/i.test(a)) {
      for (var j = i + 1; j < Math.min(i + 4, d.length); j++) {
        var cj = nubaColonnesJours_(d[j]);
        if (cj && d[j + 1]) {
          Object.keys(cj).forEach(function (k) {
            var hs = String(d[j + 1][cj[k]] || '').match(/(\\d{1,2})\\s*h\\s*(\\d{2})?/gi);
            if (hs && hs.length >= 2) {
              var x = /(\\d{1,2})\\s*h\\s*(\\d{2})?/i.exec(hs[1]);
              fermeture[k] = nubaPad_(x[1]) + ':' + (x[2] || '00');
            }
          });
          break;
        }
      }
      continue;
    }
    // Une semaine type : « Semaine type A – … (18/12/2026 → 17/01/2027) » ou « (à partir du 18/01/2027) ».
    var st = /^semaine type\\s+([A-Za-z0-9]+)/i.exec(a);
    if (st) {
      var dates = a.match(/\\d{1,2}\\/\\d{1,2}\\/\\d{4}/g) || [];
      var bloc = { lettre: st[1].toUpperCase(), debut: nubaDateIso_(dates[0]), fin: /→/.test(a) ? nubaDateIso_(dates[1]) : '', lignes: [] };
      var tete = d[i + 1] || [];
      var cols = nubaColonnesJours_(tete);
      var cPoste = tete.findIndex(function (c) { return nubaSansAccent_(c) === 'poste'; });
      if (cols) {
        for (var r = i + 2; r < d.length; r++) {
          var nom = String(d[r][0] || '').trim();
          if (!nom || /^(heures|personne|semaine|calendrier|total|horaires)/i.test(nom)) break;
          bloc.lignes.push({ nom: nom, poste: cPoste === -1 ? '' : String(d[r][cPoste] || ''), cases: NUBA_JOURS.map(function (_, k) { return cols[k] === undefined ? '' : String(d[r][cols[k]] || ''); }) });
        }
        types.push(bloc);
      }
      continue;
    }
    // Le calendrier : une ligne par semaine (lundi), la phase (lettre de la semaine type) et les absences (« X »).
    if (nubaSansAccent_(a) === 'semaine du') {
      var tc = d[i];
      var cPhase = tc.findIndex(function (c) { return nubaSansAccent_(c) === 'phase'; });
      var personnes = [];
      tc.forEach(function (c, k) {
        var n = nubaSansAccent_(c);
        if (k > Math.max(cPhase, 1) && n && !/^(au|phase|prod|jours|remarque|ferie)/.test(n) && n.split(' ').length <= 2) personnes.push({ col: k, cle: n.split(' ')[0] });
      });
      for (var w = i + 1; w < d.length; w++) {
        var lundi = nubaDateIso_(d[w][0]);
        if (!lundi) break;
        var phase = cPhase === -1 ? '' : String(d[w][cPhase] || '');
        var lp = /(?:^|→\\s*)([A-Z])(?=\\s*(?:[–—-]|\\(|$))/.exec(phase.trim());
        calendrier[lundi] = { lettre: lp ? lp[1] : '', absents: personnes.filter(function (p) { return /^x\\b/i.test(String(d[w][p.col] || '').trim()); }).map(function (p) { return p.cle; }) };
      }
    }
  }
  if (!types.length) return null;
  var shifts = [];
  for (var n = 0; n < NUBA_HORIZON; n++) {
    var jour = nubaJourPlus_(aujourdhui, n);
    var k = nubaJourIdx_(jour);
    var cal = calendrier[nubaJourPlus_(jour, -k)];
    var bloc = null;
    types.forEach(function (t) {
      var dans = (!t.debut || jour >= t.debut) && (!t.fin || jour <= t.fin);
      if (cal ? (cal.lettre === t.lettre && dans) : (dans && t.debut)) bloc = t;
    });
    if (!bloc) continue;
    bloc.lignes.forEach(function (l) {
      if (cal && cal.absents.indexOf(nubaSansAccent_(l.nom).split(' ')[0]) !== -1) return;
      nubaCreneaux_(l.cases[k], fermeture[k]).forEach(function (c) {
        shifts.push({ name: l.nom, day: jour, start: c.start, end: c.end, area: nubaZone_(l.poste), note: c.note });
      });
    });
  }
  return { brand: 'planning', file: ss.getName(), from: aujourdhui, to: nubaJourPlus_(aujourdhui, NUBA_HORIZON - 1), shifts: shifts };
}

function nubaPlanningEnvoyer_(props, force) {
  var ss = SpreadsheetApp.openById(NUBA.mercuriales.tableau);
  var plan = nubaPlanning_(ss, Utilities.formatDate(new Date(), 'Europe/Paris', 'yyyy-MM-dd'));
  if (!plan) return;
  var texte = JSON.stringify(plan);
  var empreinte = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, texte, Utilities.Charset.UTF_8));
  var dernier = Number(props.getProperty('nuba_envoi_planning') || 0);
  if (!force && props.getProperty('nuba_empreinte_planning') === empreinte && Date.now() - dernier < 6 * 3600 * 1000) return;
  var rep = UrlFetchApp.fetch(NUBA.adressePlanning, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { apikey: NUBA.clePublique }, payload: JSON.stringify({ p_key: NUBA.cleSynchro, p_payload: plan })
  });
  var corps = rep.getContentText();
  var res = null;
  try { res = JSON.parse(corps); } catch (e) { res = null; }
  if (rep.getResponseCode() !== 200 || !res || res.ok !== true) throw new Error(nubaRaison_(res, rep.getResponseCode(), corps, 'planning'));
  props.setProperty('nuba_empreinte_planning', empreinte);
  props.setProperty('nuba_envoi_planning', String(Date.now()));
  console.log('Nuba, planning envoyé : ' + JSON.stringify(res.counts));
}

// ---------- Produits de la mercuriale Nuba : l'onglet PRIX INGREDIENTS, référence des stocks ----------
function nubaProduits_(ss) {
  var sh = ss.getSheetByName('PRIX INGREDIENTS');
  if (!sh) return null;
  var r = sh.getDataRange();
  var v = r.getValues(), d = r.getDisplayValues();
  var h = -1, col = {};
  for (var i = 0; i < Math.min(d.length, 6) && h === -1; i++) {
    d[i].forEach(function (c, j) { if (nubaSansAccent_(c) === 'ingredient') h = i; });
  }
  if (h === -1) return null;
  d[h].forEach(function (c, j) {
    var t = nubaSansAccent_(c).replace(/[’']/g, ' ');
    if (t === 'categorie' && col.category === undefined) col.category = j;
    else if (t === 'ingredient') col.name = j;
    else if (t.indexOf('fournisseur') === 0 && col.supplier === undefined) col.supplier = j;
    else if (t.indexOf('prix d achat') === 0) col.price = j;
    else if (t.indexOf('unite d achat') === 0) col.unit = j;
    else if (t.indexOf('poids d une piece') === 0) col.piece_g = j;
    else if (t.indexOf('date de la facture') === 0) col.invoice_date = j;
    else if (t.indexOf('source du prix') === 0) col.source = j;
    else if (t === 'allergenes') col.allergens = j;
    else if (t.indexOf('nom sur l etiquette') === 0) col.label = j;
  });
  var products = [];
  for (var k = h + 1; k < d.length; k++) {
    var nom = String(d[k][col.name] || '').trim();
    if (!nom) continue;
    var p = { name: nom };
    ['category', 'supplier', 'unit', 'invoice_date', 'source', 'allergens', 'label'].forEach(function (x) {
      if (col[x] !== undefined) p[x] = String(d[k][col[x]] || '').trim();
    });
    ['price', 'piece_g'].forEach(function (x) {
      if (col[x] === undefined) return;
      var n = v[k][col[x]];
      p[x] = typeof n === 'number' ? n : String(d[k][col[x]] || '').trim();
    });
    products.push(p);
  }
  return { brand: 'produits', file: ss.getName(), products: products };
}

function nubaProduitsEnvoyer_(props, force) {
  var ss = SpreadsheetApp.openById(NUBA.mercuriales.nuba);
  var liste = nubaProduits_(ss);
  if (!liste) return;
  var texte = JSON.stringify(liste);
  var empreinte = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, texte, Utilities.Charset.UTF_8));
  var dernier = Number(props.getProperty('nuba_envoi_produits') || 0);
  if (!force && props.getProperty('nuba_empreinte_produits') === empreinte && Date.now() - dernier < 6 * 3600 * 1000) return;
  var res = nubaAppel_(NUBA.adresseProduits, { p_key: NUBA.cleSynchro, p_payload: liste }, 'produits');
  props.setProperty('nuba_empreinte_produits', empreinte);
  props.setProperty('nuba_envoi_produits', String(Date.now()));
  console.log('Nuba, produits de la mercuriale envoyés : ' + JSON.stringify(res.counts));
}

// ---------- Dossier des salariés : copie des fichiers du Drive dans l'appli ----------
// Même arborescence : un dossier par personne, ses sous-dossiers, les dossiers communs.
// Seuls les fichiers nouveaux ou modifiés partent ; ceux retirés du Drive sont retirés de l'appli.
var NUBA_MAX_OCTETS = 45 * 1024 * 1024;
var NUBA_DUREE_MAX = 4 * 60 * 1000;   // Google arrête un script au bout de 6 minutes : la suite part au passage suivant.
// Documents Google (Docs, Sheets, Slides, dessins) : copiés en PDF.
var NUBA_EN_PDF = {
  'application/vnd.google-apps.document': true,
  'application/vnd.google-apps.spreadsheet': true,
  'application/vnd.google-apps.presentation': true,
  'application/vnd.google-apps.drawing': true
};

function nubaDocumentsListe_(racine) {
  var tops = [], files = [], problems = [];
  function parcourir(dossier, chemin, profondeur) {
    var fi = dossier.getFiles();
    while (fi.hasNext()) {
      var f = fi.next();
      var mime = String(f.getMimeType() || '');
      var nom = String(f.getName() || '');
      if (mime.indexOf('application/vnd.google-apps.') === 0) {
        if (!NUBA_EN_PDF[mime]) continue;   // formulaires, raccourcis… : rien à copier
        nom = nom + '.pdf';
        mime = 'application/pdf';
      } else if (f.getSize() > NUBA_MAX_OCTETS) {
        problems.push('Trop lourd pour l\\'appli (plus de 45 Mo) : ' + chemin.concat(nom).join(' / '));
        continue;
      }
      files.push({ id: f.getId(), folder: chemin, name: nom, mime: mime, size: f.getSize() || null, modified: f.getLastUpdated().toISOString() });
    }
    if (profondeur >= 6) return;
    var di = dossier.getFolders();
    while (di.hasNext()) {
      var d = di.next();
      if (profondeur === 0) tops.push({ id: d.getId(), name: d.getName() });
      parcourir(d, chemin.concat(d.getName()), profondeur + 1);
    }
  }
  parcourir(racine, [], 0);
  files.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
  return { brand: 'documents', root: racine.getName(), tops: tops, files: files, problems: problems };
}

function nubaAppel_(adresse, corps, marque) {
  var rep = UrlFetchApp.fetch(adresse, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { apikey: NUBA.clePublique }, payload: JSON.stringify(corps)
  });
  var texte = rep.getContentText();
  var res = null;
  try { res = JSON.parse(texte); } catch (e) { res = null; }
  if (rep.getResponseCode() !== 200 || !res || res.ok !== true) throw new Error(nubaRaison_(res, rep.getResponseCode(), texte, marque));
  return res;
}

/** En-têtes du stockage de fichiers : la clé publique (et, pour une ancienne clé « anon », la même en Authorization). */
function nubaEnTetesStockage_() {
  var h = { apikey: NUBA.clePublique };
  if (NUBA.clePublique.split('.').length === 3) h.Authorization = 'Bearer ' + NUBA.clePublique;
  return h;
}

/** Retire de l'appli les copies que la base a désignées (anciennes versions, fichiers retirés du Drive). */
function nubaRetirer_(noms, erreurs) {
  (noms || []).forEach(function (nom) {
    var rep = UrlFetchApp.fetch(NUBA.adresseStockage + nom, { method: 'delete', muteHttpExceptions: true, headers: nubaEnTetesStockage_() });
    var code = rep.getResponseCode();
    if (code !== 200 && code !== 404 && !/not.?found/i.test(rep.getContentText())) erreurs.push('documents : retrait refusé (' + code + ') pour ' + nom);
  });
}

function nubaDocumentsEnvoyer_(props, force, debut, erreurs) {
  var racine = DriveApp.getFolderById(NUBA.dossierSalaries);
  var liste = nubaDocumentsListe_(racine);
  var texte = JSON.stringify(liste);
  var empreinte = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, texte, Utilities.Charset.UTF_8));
  var dernier = Number(props.getProperty('nuba_envoi_documents') || 0);
  if (!force && props.getProperty('nuba_empreinte_documents') === empreinte && Date.now() - dernier < 6 * 3600 * 1000) return;
  var plan = nubaAppel_(NUBA.adresseDocuments, { p_key: NUBA.cleSynchro, p_payload: liste }, 'documents');
  nubaRetirer_(plan.remove, erreurs);
  var faits = [], restants = 0, rates = 0;
  (plan.upload || []).forEach(function (u) {
    if (Date.now() - debut > NUBA_DUREE_MAX) { restants++; return; }
    try {
      var f = DriveApp.getFileById(u.id);
      var blob = NUBA_EN_PDF[f.getMimeType()] ? f.getAs('application/pdf') : f.getBlob();
      var rep = UrlFetchApp.fetch(NUBA.adresseStockage + u.path, {
        method: 'post', contentType: u.mime, muteHttpExceptions: true, headers: nubaEnTetesStockage_(), payload: blob.getBytes()
      });
      var code = rep.getResponseCode();
      // Déjà déposé (un passage précédent coupé avant l'accusé de réception) : c'est bon aussi.
      if (code === 200 || code === 201 || /already exists|duplicate/i.test(rep.getContentText())) faits.push({ id: u.id, path: u.path });
      else { rates++; erreurs.push('documents : dépôt refusé (' + code + ') : ' + String(rep.getContentText()).slice(0, 150)); }
    } catch (e) {
      rates++;
      erreurs.push('documents : ' + (e && e.message ? e.message : e));
    }
  });
  for (var i = 0; i < faits.length; i += 200) {
    var fin = nubaAppel_(NUBA.adresseDocumentsFaits, { p_key: NUBA.cleSynchro, p_done: faits.slice(i, i + 200) }, 'documents');
    nubaRetirer_(fin.remove, erreurs);
  }
  console.log('Nuba, dossier des salariés : ' + faits.length + ' fichier(s) copié(s), ' + restants + ' au prochain passage.');
  // Tout est copié : la liste ne repart que si le Drive change (ou toutes les six heures).
  if (!restants && !rates) {
    props.setProperty('nuba_empreinte_documents', empreinte);
    props.setProperty('nuba_envoi_documents', String(Date.now()));
  }
}
`;
}
