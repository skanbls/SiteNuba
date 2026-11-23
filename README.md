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
| | Stocks, fournisseurs et commandes | **En ligne**, une fois la migration 0006 exécutée |
| 3. Clients et événements | Réservations de tables, en ligne et par l'équipe | **En ligne**, une fois la migration 0007 exécutée |
| | Événements (privatisations, concerts, expositions, prestations extérieures) et fichier clients | **En ligne**, une fois la migration 0008 exécutée |
| 4. Pilotage | Fiches techniques, pannes et échéances, procédures et formation | **En ligne**, une fois la migration 0009 exécutée |
| 5. Administration | Accès confiés aux responsables, écran Administration, lien Drive de chaque personne | **En ligne**, une fois la migration 0010 exécutée |
| | Créneaux de réservation calés sur la cuisine (midi 12 h – 14 h, soir 19 h – 22 h ou 22 h 30, dimanche 12 h – 15 h) | **En ligne**, une fois la migration 0010 exécutée |
| | Formulaire de réservation du site web relié à l'appli | Fichier du site remis au gérant, à publier avec le site |
| | E-mails : confirmation au client, alertes à la Nuba | Prêt avec la migration 0010 ; à activer après la mise en route de Brevo (Administration, E-mails) |
| | E-mails des comptes de l'équipe (inscription, mot de passe oublié) | À régler dans Supabase : SMTP de Brevo (voir plus bas) |
| 6. Production | Mercuriales Saveurs Nomades et Comptoir Méditerranéen : fiches, commandes clients, quantités à produire, liste de courses | **En ligne**, une fois les migrations 0011 à 0014 exécutées et le script Google installé (Administration, Mercuriales) |
| | Numéros utiles : urgences, dépannage, fournisseurs, équipe ; modifiés par le gérant et les responsables | **En ligne**, une fois la migration 0015 exécutée |
| | Accès de la comptable : heures travaillées seulement, fichier pour la paie | **En ligne**, une fois la migration 0016 exécutée |
| | Tableau de bord financier de la société (gérants seulement) : solde, alertes, trésorerie 13 semaines, prévisionnel 12 mois, échéances | **En ligne**, une fois la migration 0019 exécutée et le nouveau script Google installé |
| | Bons de livraison Saveurs Nomades et Comptoir, prêts à imprimer en A4 (lot, DLC, allergènes, température, quantités) | **En ligne**, une fois la migration 0018 exécutée et l'en-tête rempli dans Administration |
| | Carte Nuba (mercuriale Nuba) : fiches cuisine et bar, préparations maison, allergènes pour la salle, quantités pour la mise en place, coûts et marges | **En ligne**, une fois la migration 0017 exécutée et le nouveau script Google installé |
| | Ventes Zelty | En attente : accès à l'API à demander à Zelty, puis une fonction côté serveur pour garder la clé secrète |
| | Documents de l'équipe | Restent dans le Drive du gérant ; l'appli garde le lien du dossier de chaque personne |

## Comment ça marche

- **L'appli** (dossier `src/`) est écrite en React et TypeScript, construite avec Vite. Elle s'installe sur l'écran d'accueil du téléphone.
- **Les données** vivent dans un projet [Supabase](https://supabase.com) (base PostgreSQL, comptes, règles de sécurité). Les fichiers de `supabase/migrations/` décrivent toute la base.
- **La sécurité** est dans la base, pas dans l'appli : chaque table a des règles (RLS) qui disent qui peut lire ou écrire quoi.

### Rôles

| Rôle | Peut |
| --- | --- |
| Gérant | Tout : équipe, accès, administration, corrections de pointage, export |
| Responsable | Voir les pointages de l'équipe, afficher le QR code de pointage, et modifier ce que le gérant lui confie |
| Équipier | Pointer, voir ses propres heures, cocher, relever, signaler |

### Accès des responsables

Le gérant confie à chaque responsable des parties de l'appli, dans Administration ou dans sa fiche d'équipe : checklists, stocks et commandes (catalogue, fournisseurs), procédures, fiches techniques, hygiène, maintenance (sans les documents de l'équipe), planning, pointages, réservations, événements et clients. La base applique ces accès par la fonction `can('zone')`. Ils ne valent qu'avec le compte par e-mail : dans une session à code PIN sur l'iPad, chacun a les droits d'un équipier. L'équipe, les accès, les bornes, les lieux et les e-mails restent au gérant.

Le tout premier compte confirmé devient le gérant. Les autres personnes sont ajoutées par le gérant (écran Équipe), puis créent leur compte avec l'adresse e-mail enregistrée : le compte se rattache tout seul à leur fiche.

### Planning

Toute l'équipe voit le planning de la semaine ; seul le gérant l'écrit (un service = une personne, un jour, des heures, un poste). Chacun peut demander un congé ou proposer de céder un service à un collègue ; le gérant accepte ou refuse, et un échange accepté met le planning à jour. L'accueil du gérant compare le planning du jour aux pointages : prévu, en retard, en service, parti.

### Pointeuse

Une borne (un iPad fixe) affiche un QR code et un code à 6 chiffres qui changent toutes les 30 secondes. Pour pointer son arrivée ou son départ, il faut scanner ce QR code ou saisir ce code : une photo du code ne sert donc à rien plus tard. En prestation extérieure, un responsable affiche le même code sur son téléphone.

Pour transformer un appareil en borne : le gérant ouvre Réglages, « Ajouter une borne » (ou « Relier un appareil »), et tape le code à 6 chiffres obtenu sur l'appareil, depuis l'écran de connexion (« Cet appareil est une borne de pointage »). L'appareil s'ouvre ensuite toujours sur la borne. Relier un nouvel appareil remplace l'ancien.

### Checklists et hygiène

Une checklist se coche pour une période : le jour de service (de 5 h à 5 h le lendemain, pour que la fermeture appartienne à la soirée), la semaine ou le mois. Chaque case garde qui l'a cochée et quand. Le gérant compose les listes ; des modèles sont fournis.

Hygiène regroupe les relevés de température (hors de la cible, l'action corrective est demandée), le plan de nettoyage (des checklists), les dates limites des préparations et produits entamés, et le suivi de l'huile de friture. Le gérant exporte le tout en un fichier pour un contrôle. L'accueil rappelle à chacun ce qu'il reste à faire.

### Stocks et commandes

Chaque produit a une quantité, un seuil d'alerte, une quantité voulue et un fournisseur. La quantité ne change que par un mouvement signé : boutons − et +, inventaire, ou réception d'une commande. Sous son seuil, un produit est proposé à la commande chez son fournisseur ; la commande se prépare, s'envoie (texte à copier, e-mail ou WhatsApp) puis se réceptionne, ce qui met le stock à jour et garde le contrôle à réception. Toute l'équipe peut le faire ; le gérant tient le catalogue (produits, seuils, prix, fournisseurs) et peut annuler une commande.

### Réservations

Les clients réservent sur le formulaire du site web, ou sur une page publique, `#/reserver`, à ouvrir par un lien (Instagram, fiche Google) ou à intégrer dans une page avec le code donné dans les réglages. La réservation est confirmée à l'écran, avec un lien pour la consulter ou l'annuler, et par e-mail une fois les e-mails activés. En ligne : jusqu'à 9 personnes, au moins une heure à l'avance, sur les créneaux de la cuisine (dernière table 30 minutes avant sa fermeture, une heure le dimanche) ; à partir de 10, la page invite à appeler ou à demander une privatisation. L'équipe saisit les réservations prises par téléphone ou sur place, sans limite, et note les arrivées et les absences. Le gérant règle les créneaux jour par jour, la capacité par créneau, le téléphone affiché, et peut fermer la réservation en ligne.

### Événements et fichier clients

Un événement est une privatisation, un concert, une exposition ou une prestation extérieure. Il avance de la demande au devis, à l'acompte, puis à la confirmation, et porte sa liste de choses à préparer, que l'équipe coche. Les clients envoient une demande par la page publique `#/privatiser` ; l'équipe peut aussi en noter une. Le gérant chiffre, confirme et modifie ; toute l'équipe consulte. L'accueil montre les événements du jour et, au gérant, les demandes à traiter. Le fichier clients regroupe particuliers, entreprises, artistes et prestataires ; une demande en ligne crée sa fiche toute seule.

### Pilotage

Les fiches techniques décrivent chaque recette : ingrédients et grammages, préparation, allergènes. Un ingrédient relié à un produit du stock prend son coût tout seul ; le gérant voit le coût par portion, sa part du prix hors taxe et la marge, l'équipe voit la recette et le tableau des allergènes. Dans Maintenance, toute l'équipe signale et suit les pannes ; le gérant y tient ses échéances (contrôles, contrats, documents de l'équipe), rappelées sur son accueil 30 jours avant. Les procédures se lisent dans l'appli et chacun confirme sa lecture ; le gérant voit qui a lu quoi.

### Administration

L'écran Administration (gérant) réunit les accès des responsables, les raccourcis vers tout ce qui se modifie (listes, catalogue, procédures, horaires…), les liens publics de réservation et de privatisation, les e-mails, les bornes et les lieux. Les documents de l'équipe restent dans le Drive du gérant : sa fiche garde seulement le lien de son dossier, visible du gérant seul.

### E-mails

Les e-mails partent de la base, par l'extension `pg_net`, vers le service Brevo : confirmation au client à chaque réservation en ligne et annulation, alerte à la Nuba pour chaque réservation, annulation par le client et demande de privatisation en ligne. Rien ne part tant que le gérant ne l'a pas activé. Un envoi qui échoue ne bloque jamais une réservation ; le journal des derniers e-mails est dans Administration.

Mise en route, une seule fois :

1. Créer un compte Brevo, y ajouter et valider l'adresse d'expédition, et de préférence authentifier le nom de domaine.
2. Créer une clé API dans Brevo (SMTP et API, Clés API).
3. Dans Supabase, Vault : ajouter un secret nommé `brevo_api_key` avec cette clé. Elle ne va jamais dans l'appli, dans ce dépôt ni dans une conversation.
4. Dans l'appli, Administration, E-mails : activer, indiquer les adresses, enregistrer, puis « Envoyer un essai ».

Pour les e-mails des comptes de l'équipe (inscription, mot de passe oublié), Supabase envoie lui-même, avec une limite très basse tant qu'il utilise son propre service : dans Authentication, Emails, SMTP Settings, activer le SMTP personnalisé avec `smtp-relay.brevo.com`, port 587, l'identifiant et une clé SMTP de Brevo ; puis relever la limite d'e-mails par heure dans Authentication, Rate Limits.

### Site web

Le formulaire de réservation du site de la Nuba appelle directement les fonctions publiques de la base : `booking_info` (jours ouverts, nombre maximum de personnes, téléphone), `booking_slots` (tables libres d'un jour) et `book_table` (réserver). Il utilise l'adresse du projet et sa clé publique, et renvoie les groupes vers la page `#/privatiser`. Le fichier du site n'est pas dans ce dépôt.

### Production (mercuriales Google Sheets)

Les mercuriales Saveurs Nomades et Comptoir Méditerranéen restent dans Google Sheets : on y crée les fiches (onglet COMPOSITION), les prix et les commandes (PRESTATIONS). Un petit script Google, généré dans Administration avec une clé de synchronisation, lit RECETTES, COMPOSITION CALCUL, PRESTATIONS, GRAMMAGES SUR MESURE et PRIX INGREDIENTS, et les envoie à la base (`sync_mercuriale`) toutes les dix minutes quand quelque chose a changé. Les colonnes sont retrouvées par leur titre.

L'écran Production montre, pour chaque commande, les quantités nettes à produire, fiche par fiche ; pour un plat sur mesure, chaque élément (base, protéine, légume, sauce) est multiplié par son facteur. La liste de courses d'une livraison additionne les besoins, pertes comprises, par fournisseur et dans l'unité d'achat. Toute l'équipe lit fiches et commandes ; les prix, coûts et marges demandent l'accès « fiches techniques ». La clé ne permet que d'envoyer les mercuriales ; une nouvelle clé remplace l'ancienne.

### iPad partagé

Sur un appareil relié à une borne, « Utiliser l'appli sur cet appareil » ouvre l'appli au nom de la personne : elle touche son prénom et tape son code PIN à 4 chiffres. Cette session a les droits d'un équipier (jamais ceux du gérant), permet de pointer directement sur la borne, et se referme avec « Terminer » ou seule après deux minutes sans activité. Chacun choisit son code dans Mon compte ; le gérant peut en donner un, y compris à un extra sans adresse e-mail, qui n'utilise alors que l'iPad.

### Guide et installation

Deux pages publiques, lisibles sans compte : `#/installer` (installer l'appli sur iPhone, Android ou ordinateur, avec le QR code de l'appli) et `#/guide`, le tutoriel des nouveaux arrivants, partie par partie, imprimable. On les ouvre depuis l'écran de connexion, le menu (« Guide de l'appli ») et l'écran Équipe.

### Mises à jour

L'appli se met à jour toute seule : elle cherche une nouvelle version à chaque retour à l'écran et toutes les cinq minutes, puis se recharge. La version en cours (date de construction) s'affiche sur l'écran de connexion, sur la borne et dans Mon compte.

## Relier l'appli à Supabase

Pour une base qui a déjà les scripts 0001 à 0003, `supabase/installation/0004-a-0009.sql` regroupe les six suivants en un seul collage, tout ou rien. Les migrations 0010 à 0019 se collent ensuite une par une ; elles aussi passent en entier ou pas du tout.

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
