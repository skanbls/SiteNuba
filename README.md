# Nuba Gestion

L'appli de gestion de la Nuba : une appli web installable sur iPhone, Android, iPad et ordinateur.

En ligne : https://skanbls.github.io/SiteNuba/ (mise à jour automatique à chaque changement de la branche `main`).

## Où en est-on

| Étape | Contenu | État |
| --- | --- | --- |
| 1. Socle et équipe | Comptes et rôles, pointeuse par QR code, export des heures | **En ligne** (migrations 0001 et 0003) |
| | Planning, congés et échanges de service | **En ligne**, une fois la migration 0002 exécutée |
| | iPad partagé : identification par code PIN | **En ligne**, une fois la migration 0004 exécutée |
| | Checklists | **En ligne**, une fois la migration 0005 exécutée |
| 2. Marchandise et hygiène | Hygiène : températures, nettoyage, dates limites, huile de friture | **En ligne**, une fois la migration 0005 exécutée |
| | Stocks, fournisseurs et commandes | À faire |
| 3. Clients et événements | Réservations, privatisations, concerts, expositions, prestations extérieures | À faire |
| 4. Pilotage | Fiches techniques, ventes Zelty, RH, maintenance, formation | À faire |

## Comment ça marche

- **L'appli** (dossier `src/`) est écrite en React et TypeScript, construite avec Vite. Elle s'installe sur l'écran d'accueil du téléphone.
- **Les données** vivent dans un projet [Supabase](https://supabase.com) (base PostgreSQL, comptes, règles de sécurité). Les fichiers de `supabase/migrations/` décrivent toute la base.
- **La sécurité** est dans la base, pas dans l'appli : chaque table a des règles (RLS) qui disent qui peut lire ou écrire quoi.

### Rôles

| Rôle | Peut |
| --- | --- |
| Gérant | Tout : équipe, réglages, corrections de pointage, export |
| Responsable | Voir les pointages de l'équipe, afficher le QR code de pointage |
| Équipier | Pointer, voir ses propres heures |

Le tout premier compte confirmé devient le gérant. Les autres personnes sont ajoutées par le gérant (écran Équipe), puis créent leur compte avec l'adresse e-mail enregistrée : le compte se rattache tout seul à leur fiche.

### Planning

Toute l'équipe voit le planning de la semaine ; seul le gérant l'écrit (un service = une personne, un jour, des heures, un poste). Chacun peut demander un congé ou proposer de céder un service à un collègue ; le gérant accepte ou refuse, et un échange accepté met le planning à jour. L'accueil du gérant compare le planning du jour aux pointages : prévu, en retard, en service, parti.

### Pointeuse

Une borne (un iPad fixe) affiche un QR code et un code à 6 chiffres qui changent toutes les 30 secondes. Pour pointer son arrivée ou son départ, il faut scanner ce QR code ou saisir ce code : une photo du code ne sert donc à rien plus tard. En prestation extérieure, un responsable affiche le même code sur son téléphone.

Pour transformer un appareil en borne : le gérant ouvre Réglages, « Ajouter une borne » (ou « Relier un appareil »), et tape le code à 6 chiffres obtenu sur l'appareil, depuis l'écran de connexion (« Cet appareil est une borne de pointage »). L'appareil s'ouvre ensuite toujours sur la borne. Relier un nouvel appareil remplace l'ancien.

### Checklists et hygiène

Une checklist se coche pour une période : le jour de service (de 5 h à 5 h le lendemain, pour que la fermeture appartienne à la soirée), la semaine ou le mois. Chaque case garde qui l'a cochée et quand. Le gérant compose les listes ; des modèles sont fournis.

Hygiène regroupe les relevés de température (hors de la cible, l'action corrective est demandée), le plan de nettoyage (des checklists), les dates limites des préparations et produits entamés, et le suivi de l'huile de friture. Le gérant exporte le tout en un fichier pour un contrôle. L'accueil rappelle à chacun ce qu'il reste à faire.

### iPad partagé

Sur un appareil relié à une borne, « Utiliser l'appli sur cet appareil » ouvre l'appli au nom de la personne : elle touche son prénom et tape son code PIN à 4 chiffres. Cette session a les droits d'un équipier (jamais ceux du gérant), permet de pointer directement sur la borne, et se referme avec « Terminer » ou seule après deux minutes sans activité. Chacun choisit son code dans Mon compte ; le gérant peut en donner un, y compris à un extra sans adresse e-mail, qui n'utilise alors que l'iPad.

### Mises à jour

L'appli se met à jour toute seule : elle cherche une nouvelle version à chaque retour à l'écran et toutes les cinq minutes, puis se recharge. La version en cours (date de construction) s'affiche sur l'écran de connexion, sur la borne et dans Mon compte.

## Relier l'appli à Supabase

1. Créer un projet sur supabase.com, région Europe.
2. Dans **SQL Editor**, coller et exécuter les fichiers de `supabase/migrations/`, dans l'ordre de leur numéro.
3. Dans **Authentication**, laisser la confirmation des adresses e-mail activée, et indiquer l'adresse de l'appli comme adresse de redirection.
4. Copier `.env.example` vers `.env` et y mettre l'adresse du projet et sa clé publique (« publishable » ou « anon »). Ne jamais y mettre la clé « secret » ou « service_role ».

## Commandes

```bash
npm install
```

```bash
npm run dev
```

```bash
npm run build
```

```bash
npm test
```

`npm test` vérifie les calculs d'heures et la lecture des QR codes.

`npm run test:db` rejoue les migrations sur un PostgreSQL local et vérifie les règles de sécurité et la pointeuse (voir `scripts/local-db.sh`).

`npm run test:update` vérifie qu'une appli restée ouverte passe seule à une nouvelle version.

`npm run test:e2e` joue le parcours complet dans un vrai navigateur contre cette base locale : inscription du gérant, équipe, borne, pointage d'un équipier, corrections, export (voir `e2e/`). Il demande Playwright.
