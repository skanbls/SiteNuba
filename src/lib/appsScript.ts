/**
 * Script Google (Apps Script) qui envoie les mercuriales vers l'appli.
 * L'appli le génère avec la clé de synchronisation et l'identifiant des deux feuilles ;
 * le gérant le colle une fois dans script.google.com et lance « installer ».
 *
 * Il lit, dans chaque mercuriale : RECETTES, COMPOSITION CALCUL, PRESTATIONS,
 * GRAMMAGES SUR MESURE (s'il existe) et, dans Saveurs Nomades, PRIX INGREDIENTS.
 * Les colonnes sont retrouvées par leur titre : l'ordre des colonnes peut changer.
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
  /** Date affichée en tête du script. */
  date: string;
}

export function buildAppsScript(o: ScriptOptions): string {
  const conf = {
    adresse: `${o.url.replace(/\/$/, '')}/rest/v1/rpc/sync_mercuriale`,
    clePublique: o.publicKey,
    cleSynchro: o.syncKey,
    mercuriales: { saveurs_nomades: o.saveursNomades, comptoir: o.comptoir },
  };
  return `/**
 * Nuba Gestion : envoie les mercuriales Saveurs Nomades et Comptoir Méditerranéen vers l'appli.
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
  ['saveurs_nomades', 'comptoir'].forEach(function (marque) {
    var id = NUBA.mercuriales[marque];
    if (!id) return;
    try {
      var ss = SpreadsheetApp.openById(id);
      var contenu = {
        brand: marque,
        file: ss.getName(),
        recipes: nubaRecettes_(ss),
        lines: nubaLignes_(ss),
        orders: nubaCommandes_(ss),
        roles: nubaRoles_(ss)
      };
      if (marque === 'saveurs_nomades') contenu.ingredients = nubaIngredients_(ss);
      var texte = JSON.stringify(contenu);
      var empreinte = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, texte, Utilities.Charset.UTF_8));
      var dernier = Number(props.getProperty('nuba_envoi_' + marque) || 0);
      // Rien n'a changé : on n'envoie qu'une fois toutes les six heures, pour dire que tout va bien.
      if (!force && props.getProperty('nuba_empreinte_' + marque) === empreinte && Date.now() - dernier < 6 * 3600 * 1000) return;
      var rep = UrlFetchApp.fetch(NUBA.adresse, {
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
        erreurs.push(marque + ' : ' + nubaRaison_(res, rep.getResponseCode(), corps));
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

function nubaRaison_(res, code, corps) {
  if (res && res.error === 'key') return "clé refusée. Génère un nouveau script dans l'appli (Administration, Mercuriales).";
  if (res && res.error === 'too_many') return 'trop d\\'envois en peu de temps, nouvel essai dans 10 minutes.';
  if (res && res.error === 'payload') return 'contenu illisible (onglet renommé ou vidé ?).';
  if (code === 404) return "l'appli attend la mise à jour 0011 de sa base.";
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
`;
}
