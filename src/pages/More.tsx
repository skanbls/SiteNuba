import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Layout, navFor } from '../components/ui';
import { useMe } from '../lib/session';

const HINT: Record<string, string> = {
  '/equipe': "Qui a accès à l'appli, avec quel rôle",
  '/reglages': 'Bornes et lieux de pointage',
  '/compte': 'Mes informations, mon mot de passe, me déconnecter',
};

/** Sur téléphone : les écrans qui n'ont pas leur onglet. */
export default function More() {
  const me = useMe();
  const rest = navFor(me.role).filter((n) => !n.tab);
  return (
    <Layout title="Plus">
      <div className="list">
        {rest.map((n) => (
          <Link className="row" to={n.to} key={n.to}>
            <Icon name={n.icon} />
            <div className="grow">
              <span className="t">{n.label}</span>
              <span className="sub">{HINT[n.to]}</span>
            </div>
            <span className="chev"><Icon name="chev" size={18} /></span>
          </Link>
        ))}
      </div>
      <p className="note">Les prochains modules arriveront ici : checklists, stocks et commandes, hygiène, réservations et événements.</p>
    </Layout>
  );
}
