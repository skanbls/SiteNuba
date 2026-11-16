# Nuba Gestion — repères pour les prochaines sessions

Appli de gestion de la Nuba (Toulouse) : restaurant, bar, soirées et concerts, expositions d'artistes, privatisations et traiteur hors les murs. Moins de 10 personnes, un lieu plus des prestations extérieures. Le gérant n'est pas développeur : on construit module par module et il teste au fur et à mesure.

## Décisions prises avec le gérant

- Appli web installable (PWA), pas d'appli sur les stores. Utilisée sur un iPad fixe à la Nuba, les téléphones personnels de l'équipe et l'ordinateur du gérant. Le réseau passe partout : pas de mode hors connexion.
- Caisse : Zelty. L'appli ne remplace pas la caisse ; elle pourra en lire les ventes (accès API à demander à Zelty).
- Pointage par QR code tournant (pas de biométrie, pas de géolocalisation).
- Réservations de tables : en ligne par les clients et saisie par l'équipe.
- Événements : privatisations, soirées et concerts, expositions, traiteur hors les murs.
- Modules retenus en plus : fiches techniques, RH et documents, maintenance et échéances, formation et procédures, fichier clients. Écartés pour l'instant : communication interne, clôture de caisse, pertes et casse, main courante.
- Pas de documents existants à reprendre : proposer des modèles que le gérant ajuste.
- La maquette cliquable validée par le gérant : https://claude.ai/artifact/LDuEx2SWoyRd5tWm4YJUe5

L'ordre de construction et l'état d'avancement sont dans README.md. Le mettre à jour à chaque module livré.

## Conventions

- Tout ce que voit l'utilisateur est en français, au tutoiement, avec des phrases simples. Noms de tables et de colonnes en anglais.
- La sécurité vit dans la base : chaque table a ses règles RLS et ses droits explicites ; les écritures sensibles passent par des fonctions `security definer`. Ne jamais compter sur l'appli pour interdire quelque chose.
- Une migration par module dans `supabase/migrations/`, que le gérant colle dans l'éditeur SQL de Supabase. Ne jamais modifier une migration déjà exécutée : en ajouter une nouvelle.
- Le système visuel est dans `src/styles/app.css` (jetons de couleur, thème clair et sombre). Réutiliser ses classes avant d'en créer.
- Ne jamais demander au gérant de coller une clé secrète dans la conversation. Seules l'adresse du projet Supabase et sa clé publique vont dans le dépôt.

## Vérifier avant de livrer

```bash
npx tsc --noEmit && npm test && npm run build
```

```bash
npm run test:db
```

```bash
npm run test:e2e
```

`test:db` et `test:e2e` demandent un PostgreSQL 16 local (`pg_ctlcluster 16 main start`, mot de passe `postgres` pour l'utilisateur `postgres`). `test:e2e` lance un banc d'essai local (PostgREST téléchargé depuis GitHub et un faux service de comptes, `e2e/gateway.mjs`) puis joue le parcours complet dans un navigateur : demander l'accord du gérant avant de le lancer dans une nouvelle session. Chaque nouveau module ajoute ses tests de base dans `supabase/tests/tests.sql` et son parcours dans `e2e/flow.cjs`.
