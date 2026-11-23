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
- Documents de l'équipe : depuis la 0020, envoyés dans l'appli (arrêt de travail, pièce d'identité, carte Vitale, RIB, DPAE, contrat…) et rangés dans l'espace de stockage privé Supabase « staff-docs », sous `<id de la personne>/` ; fiche dans `staff_documents`, enregistrée par `add_staff_document` (un arrêt avec dates devient une absence « maladie » acceptée ; e-mail sans pièce jointe à la comptable). Chacun voit les siens, le gérant et la comptable tout (`is_accountant()`), jamais les responsables ni les collègues. Envoi seulement avec un compte, pas avec le code PIN de l'iPad (documents personnels sur un appareil partagé). Le lien du dossier Drive de chacun reste aussi, visible du gérant et de la comptable.
- Bulletins de paie (0021) : catégorie `paie` de `staff_documents`, rangée au mois (`start_date` = 1er du mois), fichier nommé `<id>/paie-AAAA-MM-…`. Déposés par la comptable (seulement des bulletins : `accountant_id`) ou le gérant ; chaque salarié voit les siens et reçoit un e-mail (`notify_payslips`). La comptable retire ses propres dépôts par `delete_payslip`, puis le fichier (règle : seulement un fichier qui n'est plus enregistré).
- Absences : `leave_requests.reason` (motifs façon Skello) et `part` (demi-journée). Le motif ne regarde que la personne, les responsables, le gérant et la comptable : les collègues passent par `team_absences` (qui est absent, sans motif ni note).
- Cuisine : 12 h – 14 h 30 et 19 h – 22 h 30 du mardi au jeudi, 23 h vendredi et samedi ; dimanche 12 h – 16 h. Dernière réservation 30 minutes avant la fermeture de la cuisine, une heure le dimanche.
- Le site web de la Nuba (fichier remis au gérant, hors du dépôt car il contient ses coordonnées) réserve par `booking_info`, `booking_slots` et `book_table`. Ne pas changer ces fonctions sans garder leur forme.
- Production pour le client Mijote : les mercuriales Saveurs Nomades et Comptoir Méditerranéen (Google Sheets du gérant) restent la référence. L'appli les reçoit par un script Google qu'elle génère (`src/lib/appsScript.ts`, testé avec un faux Google) et ne les modifie jamais. Ne pas mettre dans le dépôt les identifiants des feuilles ni leurs données (prix, recettes) : tests avec des données inventées.
- Tableau de bord financier de la société (Google Sheet du gérant) : gérants seulement, jamais les responsables, l'équipe, l'iPad ni la comptable. Le même script Google envoie ses onglets (texte affiché et valeurs) à `sync_dashboard` ; tout est dans `dashboard_source` (RLS `is_gerant()`, aucun droit pour `anon`), lien du fichier compris, jamais dans `merc_sources` que l'équipe lit. L'appli relit les onglets dans `src/lib/dashboard.ts` (rubriques, alertes, échéances, séries) ; page `#/tableau-de-bord`. Ne mettre aucun chiffre réel dans le dépôt.
- Bons de livraison Mijote (Saveurs Nomades et Comptoir) : fabriqués dans l'appli à partir de `merc_orders`, comme l'onglet « BL À IMPRIMER » de la mercuriale (page `#/bl/:jour`, calculs dans `src/lib/delivery.ts`). L'en-tête (société, client, SIRET, adresses) vit dans `delivery_settings`, jamais dans le code : lu par l'équipe, modifié par le gérant. Rien n'est enregistré à l'impression : le bon signé fait foi.
- Mercuriale Nuba (Google Sheet du gérant) : la carte du restaurant, référence comme les deux autres. Onglets FICHES PLATS, FICHES BOISSONS et PREPARATIONS MAISON en blocs (une fiche par bloc), lus par le même script Google et envoyés à `sync_carte` (tables `menu_*`). Toute l'équipe lit fiches, quantités, allergènes et prix TTC ; coûts, marges et prix d'achat (`menu_costs`, `menu_line_costs`) avec `can('fiches')` seulement. Page Fiches techniques (`src/pages/Carte.tsx`, calculs dans `src/lib/carte.ts`) ; les fiches écrites dans l'appli restent dans l'onglet « Fiches de l'appli ».
- Numéros utiles (`contacts`) : lus par toute l'équipe, y compris par code PIN ; modifiés par le gérant et tous les responsables avec leur compte (`is_manager()`, choix du gérant, sans accès à confier).
- Comptable : pas de fiche dans `profiles` (aucune règle de l'équipe ne s'applique à elle). Le gérant enregistre son adresse dans `accountants` (son adresse n'est jamais dans le dépôt) ; elle crée son compte. Son espace : `hours_report` (heures, pauses, contrats, absences acceptées par motif ; ni notes ni coordonnées), `team_documents` et les fichiers de « staff-docs » en lecture, le lien Zelty de `accounting_settings`. Les Z de caisse et encaissements viendront de l'API Zelty (clé dans le coffre Vault, jamais dans le dépôt). Ne jamais l'ajouter à l'équipe.
- Liste de courses de Production : classée par famille (catégorie de PRIX INGREDIENTS) ou par fournisseur ; cases cochées partagées dans `shopping_checks` (par jour de livraison, `check_shopping`, code PIN compris).
- La maquette cliquable validée par le gérant : https://claude.ai/artifact/LDuEx2SWoyRd5tWm4YJUe5

L'ordre de construction et l'état d'avancement sont dans README.md. Le mettre à jour à chaque module livré.

## Conventions

- Tout ce que voit l'équipe est en français, au tutoiement, avec des phrases simples. Les pages publiques destinées aux clients (réservation) sont au vouvoiement. Noms de tables et de colonnes en anglais.
- La sécurité vit dans la base : chaque table a ses règles RLS et ses droits explicites ; les écritures sensibles passent par des fonctions `security definer`. Ne jamais compter sur l'appli pour interdire quelque chose.
- Une écriture qu'un responsable peut recevoir se protège par `can('zone')`, jamais par `is_gerant()` seul ; une nouvelle zone s'ajoute à la contrainte de `profile_rights` et à `AREAS` dans `src/lib/rights.ts`. `can()` est toujours faux dans une session à code PIN.
- Les e-mails partent de la base par `_email_queue` (pg_net vers Brevo, clé `brevo_api_key` dans le coffre Vault de Supabase). Un envoi ne doit jamais lever d'erreur ni bloquer l'action qui le déclenche.
- Une session par code PIN passe par le rôle `anon` avec l'en-tête `x-nuba-ticket` ; `my_profile_id()` la reconnaît et `is_gerant()` / `is_manager()` y sont toujours faux. Chaque nouvelle table que l'équipe utilise doit donc donner ses droits et ses règles RLS à `anon, authenticated`, et tester les deux (voir `supabase/tests/tests_pin.sql`). Utiliser `my_profile_id()`, jamais `auth.uid()` directement.
- Supabase charge `pg_safeupdate` pour les demandes de l'appli : un UPDATE ou un DELETE sans WHERE y est refusé, même dans une fonction. Écrire `where true` (ou la clé de la ligne unique). Le banc local ne le charge pas ; `supabase/tests/tests_z_safeupdate.sql` vérifie le texte des fonctions.
- Une migration par module dans `supabase/migrations/`, que le gérant colle dans l'éditeur SQL de Supabase. Ne jamais modifier une migration déjà exécutée : en ajouter une nouvelle.
- Le système visuel est dans `src/styles/app.css` (jetons de couleur, thème clair et sombre). Réutiliser ses classes avant d'en créer. Il suit la charte de la Nuba : vert Nuba #113F24, crème #F7EDE1, terracotta #B64A36, olive #7A7A2E, bordeaux #8B3E3B ; titres en Montserrat, textes en Inter. Le logo est vectorisé dans `src/components/Logo.tsx` (couleurs par les jetons `--logo-*`, variante « fond vert » en thème sombre) ; les icônes de `public/` en sont tirées. Menus (onglets et rail) et carte du jour en vert Nuba dans les deux thèmes (jetons `--nav-*`, `--hero-*`) ; champs et boutons bordés de `--line-strong` (contraste ≥ 3). Le terracotta sur crème n'atteint pas le contraste AA pour un petit texte : le garder pour les touches de couleur. Le thème suit l'appareil ou le choix fait dans Mon compte (`src/lib/theme.ts`, attribut `data-theme` sur `<html>`). La page publique `#/installer` explique l'installation et donne le QR code de l'appli ; la page publique `#/guide` (`src/pages/Guide.tsx`) est le tutoriel des nouveaux arrivants : la mettre à jour quand un écran ou un nom de bouton change.
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
