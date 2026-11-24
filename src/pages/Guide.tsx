import { useState, type ReactNode } from 'react';
import { Icon, type IconName } from '../components/Icon';
import { BrandHead } from '../components/Logo';

/**
 * Guide de l'appli pour les nouveaux arrivants : page publique (#/guide), lisible avant même d'avoir un compte,
 * sur téléphone, sur l'iPad ou imprimée pour la salle de pause.
 * Les noms de boutons sont ceux de l'appli : les changer ici quand on les change dans les écrans.
 */
interface Part { id: string; icon: IconName; title: string; who?: string; body: ReactNode }

const B = ({ children }: { children: ReactNode }) => <b>« {children} »</b>;

const PARTS: Part[] = [
  {
    id: 'debut',
    icon: 'down',
    title: 'Premiers pas, à faire une fois',
    body: (
      <>
        <ol>
          <li>Donne ton adresse e-mail au gérant : il t'ajoute à l'équipe.</li>
          <li>Installe l'appli sur ton téléphone avec la page <a className="link" href="#/installer">Installer l'appli</a>. Ensuite, ouvre-la toujours depuis son icône.</li>
          <li>Touche <B>Créer mon compte</B> : ton prénom, la même adresse e-mail, et un mot de passe d'au moins 8 caractères.</li>
          <li>Ouvre l'e-mail de confirmation et touche le lien. Pas d'e-mail ? Regarde dans les courriers indésirables.</li>
          <li>Dans <b>Mon compte</b>, choisis ton code PIN à 4 chiffres : il te servira sur l'iPad de la Nuba.</li>
        </ol>
        <p>Pas d'adresse e-mail ? Le gérant te donne un code PIN : tu utiliseras seulement l'iPad.</p>
      </>
    ),
  },
  {
    id: 'pointer',
    icon: 'qr',
    title: 'Pointer ton arrivée et ton départ',
    body: (
      <>
        <p><b>Sur ton téléphone</b></p>
        <ol>
          <li>Dans <b>Aujourd'hui</b> ou <b>Pointeuse</b>, touche <B>Pointer mon arrivée</B>.</li>
          <li>Scanne le QR code affiché sur l'iPad de la Nuba. L'appareil photo ne marche pas ? Touche <B>Saisir le code</B> et tape les 6 chiffres.</li>
          <li>Pour ta pause : <B>Commencer ma pause</B>, puis <B>Reprendre le service</B>.</li>
          <li>En partant : <B>Pointer mon départ</B>, de la même façon.</li>
        </ol>
        <p><b>Sur l'iPad</b> : ouvre l'appli avec ton code PIN (voir plus bas), puis <B>Pointer mon arrivée</B>. Pas besoin de scanner.</p>
        <p>Le code change toutes les 30 secondes : une photo du code ne marche pas. Tu as oublié de pointer ? Préviens le gérant, il corrige. En prestation extérieure, le responsable affiche le QR code sur son téléphone.</p>
      </>
    ),
  },
  {
    id: 'ipad',
    icon: 'grid',
    title: "L'iPad de la Nuba",
    body: (
      <ol>
        <li>Il affiche en permanence la borne de pointage.</li>
        <li>Pour utiliser l'appli dessus : <B>Utiliser l'appli sur cet appareil</B>, touche ton prénom, tape ton code PIN.</li>
        <li>Tu fais tout comme sur ton téléphone : checklists, températures, stocks, réservations…</li>
        <li>Quand tu as fini : <B>Terminer</B>, en haut de l'écran. Sans activité, l'appli se referme seule au bout de deux minutes.</li>
        <li>Tout ce que tu fais est signé à ton nom : ne donne ton code à personne.</li>
      </ol>
    ),
  },
  {
    id: 'jour',
    icon: 'home',
    title: "Aujourd'hui : ce qu'il reste à faire",
    body: (
      <p>
        L'écran d'accueil rassemble ce qui t'attend : cases de checklists, relevés de température, dates limites, produits à commander,
        livraisons attendues, réservations et événements du jour, procédures à lire. Touche une ligne pour y aller.
      </p>
    ),
  },
  {
    id: 'checklists',
    icon: 'check',
    title: 'Checklists',
    body: (
      <ol>
        <li>Choisis la liste en haut : ouverture du bar, fermeture de la cuisine…</li>
        <li>Touche une ligne pour la cocher : ton prénom et l'heure sont enregistrés.</li>
        <li>Une erreur ? Touche de nouveau ta case pour la décocher.</li>
        <li>Les listes du jour repartent à zéro chaque matin à 5 h : la fermeture de la nuit compte pour la soirée.</li>
      </ol>
    ),
  },
  {
    id: 'hygiene',
    icon: 'thermo',
    title: 'Hygiène',
    body: (
      <ol>
        <li><b>Températures</b> : pour chaque frigo, tape la température et touche <B>Relever</B>. Si elle est hors limite, écris ce que tu as fait (régler, déplacer les produits, prévenir…) et touche <B>Noter</B>.</li>
        <li><b>Nettoyage</b> : coche les tâches du plan de nettoyage, comme une checklist.</li>
        <li><b>Dates limites</b> : quand tu prépares ou ouvres un produit, crée son étiquette avec sa date limite. Quand il est fini : <B>Terminé</B> ; s'il est périmé : <B>Jeter</B>.</li>
        <li><b>Friteuse</b> : note le test de l'huile, et <B>Huile changée</B> quand tu la changes.</li>
      </ol>
    ),
  },
  {
    id: 'planning',
    icon: 'cal',
    title: 'Planning, congés et échanges',
    body: (
      <ol>
        <li><b>Planning</b> montre tes services et ceux de l'équipe, semaine par semaine.</li>
        <li>Pour un congé ou une absence : <B>Demander un congé</B>, choisis le motif (congés payés, récupération, événement familial…) et les dates, ou une demi-journée. Le gérant accepte ou refuse.</li>
        <li>Malade ? <B>Envoyer un arrêt de travail</B> : prends-le en photo, indique ses dates. Il est noté dans le planning et la comptable est prévenue. Tes collègues voient que tu es absent, pas pourquoi.</li>
        <li>Tes autres documents (pièce d'identité, carte Vitale, RIB…) s'envoient dans <b>Mon compte</b>, rubrique « Mes documents ». Seuls le gérant et la comptable les voient. Depuis ton téléphone, avec ton compte : pas depuis l'iPad.</li>
        <li>Tes bulletins de paie arrivent dans <b>Mon compte</b>, rubrique « Mes bulletins de paie ». Un e-mail te prévient à chaque nouveau bulletin.</li>
        <li>Pour donner un de tes services à un collègue : <B>Céder un service</B>, choisis qui le reprend. Le gérant valide, et le planning se met à jour.</li>
        <li>Tes heures travaillées sont dans <b>Pointeuse</b>.</li>
      </ol>
    ),
  },
  {
    id: 'stocks',
    icon: 'box',
    title: 'Stocks et commandes',
    body: (
      <ol>
        <li><b>Stocks</b> : touche <b>−</b> quand tu prends un produit, <b>+</b> quand tu en ranges. <B>Faire l'inventaire</B> sert à tout recompter.</li>
        <li>Un produit sous son seuil apparaît dans <b>Commandes</b>, chez son fournisseur.</li>
        <li>Pour commander : <B>Préparer la commande</B>, ajuste les quantités, puis envoie-la (texte à copier, e-mail ou WhatsApp).</li>
        <li>À la livraison : ouvre la commande, <B>Réceptionner la livraison</B>, indique ce qui est arrivé et la température des produits frais. Le stock se met à jour tout seul.</li>
      </ol>
    ),
  },
  {
    id: 'reservations',
    icon: 'book',
    title: 'Réservations',
    body: (
      <ol>
        <li>Les réservations du jour sont dans <b>Réservations</b>. Celles faites sur le site arrivent toutes seules.</li>
        <li>Un client réserve par téléphone ou sur place : touche <B>Réservation</B> et note son nom, l'heure, le nombre de personnes et son téléphone. Note aussi son e-mail s'il le donne : la case <b>Envoyer la confirmation par e-mail</b> lui envoie la confirmation, et il reçoit un rappel la veille.</li>
        <li>Pour un groupe, une réservation faite en ligne peut arriver en <b>Demandes à valider</b>, en haut de l'écran. Touche <B>Accepter</B> : le client reçoit la confirmation. Ou <B>Refuser</B>, avec un petit mot pour lui.</li>
        <li>Quand les clients arrivent : <B>Arrivés</B>. S'ils ne viennent pas : <B>Absents</B>.</li>
      </ol>
    ),
  },
  {
    id: 'evenements',
    icon: 'star',
    title: 'Événements',
    body: (
      <ol>
        <li>Privatisations, soirées, concerts, expositions, prestations extérieures : ouvre un événement pour lire son déroulé et voir son affiche.</li>
        <li>Les soirées, l'exposition et les rendez-vous de <b>Chaque semaine</b> viennent du fichier du site web : ils arrivent tout seuls et se modifient dans le fichier.</li>
        <li>Coche les choses à préparer au fur et à mesure.</li>
        <li>Un client te parle d'une privatisation : touche <B>Demande</B> pour la noter. Le gérant le rappelle.</li>
      </ol>
    ),
  },
  {
    id: 'production',
    icon: 'pot',
    title: 'Production (Saveurs Nomades, Comptoir Méditerranéen)',
    body: (
      <ol>
        <li><b>Commandes</b> : touche une commande pour voir les quantités à peser, fiche par fiche. <B>Fiche process : étapes et dressage</B> donne les étapes de production, la photo du dressage à viser et les règles d'hygiène, prêtes à imprimer pour le poste.</li>
        <li><b>Liste de courses</b> : tout ce qu'il faut acheter pour une livraison, par famille (fruits et légumes, crèmerie…) ou par fournisseur, pertes comprises. Coche chaque article mis dans le panier : la case est cochée pour toute l'équipe.</li>
        <li><b>Fiches</b> : chaque recette, à mettre à l'échelle du nombre de portions.</li>
        <li><b>Bon de livraison</b>, sous chaque jour de commandes : le bon de livraison prêt à imprimer, avec lot, DLC et allergènes. Écris la température au départ, corrige une quantité livrée si besoin, puis <B>Imprimer</B>. Le client le signe à la livraison.</li>
        <li>Les fiches et les commandes se modifient dans les mercuriales (Google Sheets), pas dans l'appli : elle suit toute seule.</li>
      </ol>
    ),
  },
  {
    id: 'fiches',
    icon: 'list',
    title: 'Fiches techniques, la carte et les allergènes',
    body: (
      <ol>
        <li><b>Cuisine</b> et <b>Bar</b> : chaque plat et chaque boisson de la carte, avec ses ingrédients, ses quantités et son prix. Touche une fiche, puis écris le nombre de portions : les quantités suivent.</li>
        <li>« À sortir » : la quantité à prendre en réserve, pertes comprises (épluchage, cuisson, mousse…).</li>
        <li><b>Maison</b> : les préparations maison (sauces, bases, garnitures). Dans une fiche, touche le nom d'une préparation pour l'ouvrir ; <B>Retour</B> pour revenir.</li>
        <li><b>Allergènes</b> : un client est allergique ? Touche ses allergènes : l'appli range la carte en « Possible », « À confirmer en cuisine » et « À éviter ».</li>
        <li><b>Quantités</b> : pour la mise en place ou un événement, choisis les plats et le nombre de portions. L'appli donne les préparations maison à faire et les ingrédients à sortir ou à commander, par fournisseur.</li>
        <li>La carte se modifie dans la mercuriale Nuba (Google Sheets), par la cheffe, la responsable bar ou le gérant : l'appli suit toute seule.</li>
      </ol>
    ),
  },
  {
    id: 'pannes',
    icon: 'tool',
    title: 'Signaler une panne',
    body: (
      <ol>
        <li>Dans <b>Maintenance</b>, touche <B>Signaler une panne</B>.</li>
        <li>Dis ce qui ne marche pas et où. Coche <b>Urgent</b> si ça gêne le service ou présente un danger.</li>
        <li>Tu suis ensuite la réparation au même endroit.</li>
      </ol>
    ),
  },
  {
    id: 'numeros',
    icon: 'phone',
    title: 'Numéros utiles',
    body: (
      <>
        <p>Urgences, dépannage, fournisseurs, équipe : dans <b>Numéros utiles</b>, touche un numéro pour l'appeler.</p>
        <p>En cas d'urgence : <b>15</b> (SAMU), <b>18</b> (pompiers), <b>17</b> (police), <b>112</b> (depuis n'importe quel téléphone). Odeur de gaz : coupe le gaz, aère, sors, puis appelle l'urgence gaz.</p>
        <p>Un numéro manque ou a changé ? Préviens le gérant ou ton responsable : eux seuls modifient la liste.</p>
      </>
    ),
  },
  {
    id: 'procedures',
    icon: 'doc',
    title: 'Procédures',
    body: <p>Les consignes de la Nuba. Lis chaque procédure marquée « À lire », puis touche <B>J'ai lu et compris</B>. Le gérant voit qui a lu quoi.</p>,
  },
  {
    id: 'compte',
    icon: 'user',
    title: 'Mon compte',
    body: <p>Ton mot de passe, ton code PIN pour l'iPad, l'apparence (claire ou sombre), la version de l'appli, et le bouton pour te déconnecter.</p>,
  },
  {
    id: 'aide',
    icon: 'alert',
    title: 'Un souci ?',
    body: (
      <ul>
        <li><b>Mot de passe oublié</b> : sur l'écran de connexion, <B>Mot de passe oublié</B>, puis le lien reçu par e-mail.</li>
        <li><b>« Tu n'as pas le droit de faire cette action »</b> : c'est réservé au gérant ou à un responsable. Demande-lui.</li>
        <li><b>Le scan ne marche pas</b> : autorise l'appareil photo pour l'appli, ou touche <B>Saisir le code</B>.</li>
        <li><b>Une nouveauté n'apparaît pas</b> : Mon compte, <B>Chercher une mise à jour</B>, et donne au gérant la version affichée.</li>
        <li><b>Pas de réseau</b> : l'appli a besoin d'Internet. Réessaie dès qu'il revient.</li>
      </ul>
    ),
  },
  {
    id: 'responsables',
    icon: 'team',
    title: 'Pour les responsables',
    who: 'Responsables',
    body: (
      <ul>
        <li>Dans <b>Pointeuse</b>, vue <b>Équipe</b> : qui est là, et les heures de chacun.</li>
        <li><B>Afficher le QR code</B> sur ton téléphone pour faire pointer l'équipe en prestation extérieure.</li>
        <li>Tu tiens à jour les <b>Numéros utiles</b> : <B>Numéro</B> pour en ajouter un, l'icône réglages pour le modifier.</li>
        <li>Le gérant peut te confier des parties de l'appli (checklists, stocks, procédures, planning…). Tu les modifies avec ton compte, pas avec le code PIN de l'iPad.</li>
      </ul>
    ),
  },
  {
    id: 'gerant',
    icon: 'cog',
    title: 'Pour le gérant',
    who: 'Gérant',
    body: (
      <ul>
        <li><b>Équipe</b> : ajouter une personne, son rôle, son code PIN, le lien de son dossier Drive ; <B>QR code d'installation</B> pour l'équipe.</li>
        <li><b>Administration</b> : accès des responsables, e-mails, bornes, mercuriales (Nuba, Saveurs Nomades, Comptoir), en-tête des bons de livraison, liens publics.</li>
        <li><b>Tableau de bord</b> (gérants seulement) : solde, alertes, trésorerie sur 13 semaines, prévisionnel sur 12 mois et échéances, repris du fichier « Tableau de bord financier ». Les chiffres se modifient dans Google Sheets.</li>
        <li><b>Fiches techniques</b>, avec l'accès « fiches techniques » : coût matière, marge, coefficient et prix conseillé de chaque fiche, en rouge au-dessus de l'objectif.</li>
        <li><b>Accès comptable</b>, dans Administration : ajoute l'adresse e-mail de la comptable. Elle crée son compte avec cette adresse. Son espace : le récap du mois (heures et absences par motif, à télécharger pour la paie), les documents de l'équipe (elle y dépose les bulletins de paie de chacun : <B>Déposer les bulletins de paie</B>), et la caisse Zelty. Elle reçoit un e-mail à chaque document envoyé.</li>
        <li><b>Équipe</b> : dans la fiche de chacun, ses documents ; <B>Ajouter un document</B> pour la DPAE ou le contrat.</li>
        <li><b>Pointeuse</b>, vue Équipe : corriger un pointage, <B>Exporter pour le comptable</B>.</li>
        <li><b>Planning</b> : <B>Service</B> pour planifier, <B>Recopier la semaine précédente</B>, et les demandes de congé et d'échange à accepter.</li>
      </ul>
    ),
  },
];

export default function Guide() {
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<Set<string>>(() => new Set(['debut']));

  function toggle(id: string, isOpen: boolean) {
    setOpen((s) => {
      const n = new Set(s);
      if (isOpen) n.add(id);
      else n.delete(id);
      return n;
    });
  }

  function print() {
    setAll(true);
    setTimeout(() => window.print(), 50);
  }

  return (
    <div className="full guide-page">
      <div className="card wide">
        <BrandHead />
        <div>
          <h1>Bienvenue dans l'appli de la Nuba</h1>
          <p className="sub">
            Elle sert à tout ce qui se passe pendant un service : pointer, cocher les checklists, relever les températures, suivre les stocks,
            les réservations et les événements. Elle marche sur ton téléphone et sur l'iPad de la Nuba.
          </p>
        </div>
        <div className="acts no-print">
          <a className="btn pri" href="#/installer"><Icon name="down" />Installer l'appli</a>
          <a className="btn" href="#/">Ouvrir l'appli</a>
        </div>
        <nav className="chips no-print" aria-label="Sommaire" style={{ flexWrap: 'wrap', overflow: 'visible' }}>
          {PARTS.map((p) => (
            <a key={p.id} className="chip" href={`#/guide`} onClick={(e) => { e.preventDefault(); toggle(p.id, true); document.getElementById(`g-${p.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>
              <Icon name={p.icon} size={16} />{p.title.split(' (')[0].split(',')[0]}
            </a>
          ))}
        </nav>
        {PARTS.map((p) => (
          <details
            key={p.id}
            id={`g-${p.id}`}
            className="guide"
            open={all || open.has(p.id)}
            onToggle={(e) => toggle(p.id, (e.currentTarget as HTMLDetailsElement).open)}
          >
            <summary><Icon name={p.icon} size={18} /> {p.title}{p.who ? <span className="pill info" style={{ marginLeft: 8 }}>{p.who}</span> : null}</summary>
            <div className="guide-body">{p.body}</div>
          </details>
        ))}
        <div className="acts no-print">
          <button type="button" className="btn" onClick={() => setAll(!all)}>{all ? 'Tout replier' : 'Tout déplier'}</button>
          <button type="button" className="btn" onClick={print}>Imprimer le guide</button>
        </div>
        <p className="note">Une question qui n'est pas ici ? Demande au gérant ou à ton responsable.</p>
      </div>
    </div>
  );
}
