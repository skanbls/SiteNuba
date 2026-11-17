# Nuba Gestion — repères pour les prochaines sessions

Appli de gestion de la Nuba (Toulouse) : restaurant, bar, soirées et concerts, expositions d'artistes, privatisations et traiteur hors les murs. Moins de 10 personnes, un lieu plus des prestations extérieures. Le gérant n'est pas développeur : on construit module par module et il teste au fur et à mesure.

## Décisions prises avec le gérant

- Appli web installable (PWA), pas d'appli sur les stores. Utilisée sur un iPad fixe à la Nuba, les téléphones personnels de l'équipe et l'ordinateur du gérant. Le réseau passe partout : pas de mode hors connexion.
- Caisse : Zelty. L'appli ne remplace pas la caisse ; elle pourra en lire les ventes (accès API à demander à Zelty).
- Pointage par QR code tournant (pas de biométrie, pas de géolocalisation).
- iPad partagé : chacun s'y identifie par un code PIN à 4 chiffres et peut aussi y pointer. L'équipe doit pouvoir tout faire sur l'iPad comme sur le téléphone ; seuls les écrans du gérant demandent sa connexion par e-mail.
- Le gérant confie à chaque responsable des parties de l'appli (checklists, stocks, procédures, planning…) dans Administration. L'équipe, les accès, les bornes, les lieux et les e-mails restent au gérant, comme les documents personnels de l'équipe.
- Réservations de tables : en ligne par les clients et saisie par l'équipe. Ouverture : mardi à jeudi 12 h – 0 h, vendredi 12 h – 2 h, samedi 12 h – 3 h, dimanche 12 h – 16 h, lundi fermé. En ligne jusqu'à 9 personnes, au-delà le client appelle. Confirmation à l'écran pour commencer (pas d'e-mail). Le site web de la Nuba doit envoyer ses réservations dans l'appli : par le lien ou le code d'intégration de la page publique.
- Événements : privatisations, soirées et concerts, expositions, traiteur hors les murs.
- Modules retenus en plus : fiches techniques, RH et documents, maintenance et échéances, formation et procédures, fichier clients. Écartés pour l'instant : communication interne, clôture de caisse, pertes et casse, main courante.
- Pas de documents existants à reprendre : proposer des modèles que le gérant ajuste.
- Les documents de l'équipe restent dans le Drive du gérant : l'appli ne stocke que le lien du dossier de chaque personne.
- Cuisine : 12 h – 14 h 30 et 19 h – 22 h 30 du mardi au jeudi, 23 h vendredi et samedi ; dimanche 12 h – 16 h. Dernière réservation 30 minutes avant la fermeture de la cuisine, une heure le dimanche.
- Le site web de la Nuba (fichier remis au gérant, hors du dépôt car il contient ses coordonnées) réserve par `booking_info`, `booking_slots` et `book_table`. Ne pas changer ces fonctions sans garder leur forme.
- La maquette cliquable validée par le gérant : https://claude.ai/artifact/LDuEx2SWoyRd5tWm4YJUe5

L'ordre de construction et l'état d'avancement sont dans README.md. Le mettre à jour à chaque module livré.

## Conventions

- Tout ce que voit l'équipe est en français, au tutoiement, avec des phrases simples. Les pages publiques destinées aux clients (réservation) sont au vouvoiement. Noms de tables et de colonnes en anglais.
- La sécurité vit dans la base : chaque table a ses règles RLS et ses droits explicites ; les écritures sensibles passent par des fonctions `security definer`. Ne jamais compter sur l'appli pour interdire quelque chose.
- Une écriture qu'un responsable peut recevoir se protège par `can('zone')`, jamais par `is_gerant()` seul ; une nouvelle zone s'ajoute à la contrainte de `profile_rights` et à `AREAS` dans `src/lib/rights.ts`. `can()` est toujours faux dans une session à code PIN.
- Les e-mails partent de la base par `_email_queue` (pg_net vers Brevo, clé `brevo_api_key` dans le coffre Vault de Supabase). Un envoi ne doit jamais lever d'erreur ni bloquer l'action qui le déclenche.
- Une session par code PIN passe par le rôle `anon` avec l'en-tête `x-nuba-ticket` ; `my_profile_id()` la reconnaît et `is_gerant()` / `is_manager()` y sont toujours faux. Chaque nouvelle table que l'équipe utilise doit donc donner ses droits et ses règles RLS à `anon, authenticated`, et tester les deux (voir `supabase/tests/tests_pin.sql`). Utiliser `my_profile_id()`, jamais `auth.uid()` directement.
- Une migration par module dans `supabase/migrations/`, que le gérant colle dans l'éditeur SQL de Supabase. Ne jamais modifier une migration déjà exécutée : en ajouter une nouvelle.
- Le système visuel est dans `src/styles/app.css` (jetons de couleur, thème clair et sombre). Réutiliser ses classes avant d'en créer.
- Ne jamais demander au gérant de coller une clé secrète dans la conversation. Seules l'adresse du projet Supabase et sa clé publique vont dans le dépôt.

- Les appareils de la Nuba sont des iPhone et un iPad : l'appli installée sur l'écran d'accueil ne partage pas sa mémoire avec Safari, reste ouverte en arrière-plan pendant des jours, et la borne ne se ferme jamais. Toute nouveauté doit marcher dans ces conditions. La mise à jour automatique est dans `src/lib/update.ts` ; ne pas la casser (`npm run test:update`).
- Quand le gérant signale qu'une nouveauté n'apparaît pas, lui demander d'abord la version affichée dans Mon compte.

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

```bash
npm run test:update
```

`test:db` et `test:e2e` demandent un PostgreSQL 16 local (`pg_ctlcluster 16 main start`, mot de passe `postgres` pour l'utilisateur `postgres`). `test:e2e` lance un banc d'essai local (PostgREST téléchargé depuis GitHub et un faux service de comptes, `e2e/gateway.mjs`) puis joue le parcours complet dans un navigateur : demander l'accord du gérant avant de le lancer dans une nouvelle session. Chaque nouveau module ajoute ses tests de base dans `supabase/tests/tests.sql` et son parcours dans `e2e/flow.cjs`.
