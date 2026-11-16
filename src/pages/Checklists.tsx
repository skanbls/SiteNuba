import { ChecklistBoard } from '../components/ChecklistBoard';
import { Layout } from '../components/ui';

/** Checklists de service : ouverture, fermeture, tâches de la semaine. */
export default function Checklists() {
  return (
    <Layout title="Checklists">
      <ChecklistBoard kind="service" />
      <p className="note">Touche une ligne pour la cocher : ton nom et l'heure sont enregistrés. Le plan de nettoyage se trouve dans Hygiène.</p>
    </Layout>
  );
}
