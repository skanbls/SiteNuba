# Nuba Gestion

L'appli de gestion de la Nuba : une appli web installable sur iPhone, Android, iPad et ordinateur.

## Où en est-on

| Étape | Contenu | État |
| --- | --- | --- |
| 1. Socle et équipe | Comptes et rôles, pointeuse par QR code, export des heures | **En cours** : socle et pointeuse écrits |
| | Planning et congés, checklists | À faire |
| 2. Marchandise et hygiène | Stocks, fournisseurs et commandes, relevés et traçabilité | À faire |
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

### Pointeuse

Une borne (un iPad fixe) affiche un QR code et un code à 6 chiffres qui changent toutes les 30 secondes. Pour pointer son arrivée ou son départ, il faut scanner ce QR code ou saisir ce code : une photo du code ne sert donc à rien plus tard. En prestation extérieure, un responsable affiche le même code sur son téléphone.

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

`npm test` vérifie les calculs d'heures et la lecture des QR codes. `npm run test:db` rejoue les migrations sur un PostgreSQL local et vérifie les règles de sécurité et la pointeuse (voir `scripts/local-db.sh`).
