/**
 * Script Google (Apps Script) qui envoie les mercuriales vers l'appli.
 * L'appli le génère avec la clé de synchronisation et l'identifiant des deux feuilles ;
 * le gérant le colle une fois dans script.google.com et lance « installer ».
 *
 * Il lit, dans Saveurs Nomades et Comptoir : RECETTES, COMPOSITION CALCUL, PRESTATIONS,
 * GRAMMAGES SUR MESURE (s'il existe) et, dans Saveurs Nomades, PRIX INGREDIENTS.
 * Les colonnes sont retrouvées par leur titre : l'ordre des colonnes peut changer.
 *
 * Dans la mercuriale Nuba (la carte du restaurant) : FICHES PLATS, FICHES BOISSONS et
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
  /** Date affichée en tête du script. */
  date: string;
}

export function buildAppsScript(o: ScriptOptions): string {
  const conf = {
    adresse: `${o.url.replace(/\/$/, '')}/rest/v1/rpc/sync_mercuriale`,
    adresseCarte: `${o.url.replace(/\/$/, '')}/rest/v1/rpc/sync_carte`,
    adresseTableau: `${o.url.replace(/\/$/, '')}/rest/v1/rpc/sync_dashboard`,
    adresseSite: `${o.url.replace(/\/$/, '')}/rest/v1/rpc/sync_site`,
    clePublique: o.publicKey,
    cleSynchro: o.syncKey,
    mercuriales: { saveurs_nomades: o.saveursNomades, comptoir: o.comptoir, nuba: o.nuba ?? '', tableau: o.tableau ?? '', site: o.site ?? '' },
  };
  return `/**
 * Nuba Gestion : envoie les mercuriales Saveurs Nomades, Comptoir Méditerranéen et Nuba,
 * le tableau de bord financier et le contenu du site (programmation, exposition) vers l'appli.
 * Généré par l'appli (Administration, Mercuriales) le ${o.date}.
 *
 * Mise en route, une seule fois :
 *   1. Enregistre ce projet (icône disquette).
 *   2. En haut, choisis la fonction « installer », puis clique sur Exécuter.
 *   3. Google demande d'autoriser l'accès à tes feuilles et aux services externes : accepte.
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
  var props = PropertiesService.getScriptProperties();
  var erreurs = [];
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
  if (erreurs.length) throw new Error('Envoi vers Nuba incomplet. ' + erreurs.join(' | '));
}

function nubaRaison_(res, code, corps, marque) {
  if (res && res.error === 'key') return "clé refusée. Génère un nouveau script dans l'appli (Administration, Mercuriales).";
  if (res && res.error === 'too_many') return 'trop d\\'envois en peu de temps, nouvel essai dans 10 minutes.';
  if (res && res.error === 'payload') return 'contenu illisible (onglet renommé ou vidé ?).';
  if (res && res.error === 'db') return 'refusé par la base : ' + res.message;
  if (code === 404) return "l'appli attend la mise à jour " + ({ nuba: '0017', tableau: '0019', site: '0024' }[marque] || '0011') + ' de sa base.';
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
`;
}
