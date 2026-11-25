import { useQuery } from '@tanstack/react-query';
import { useSession } from './session';
import { supabase } from './supabase';

/** Parties de l'appli que le gérant peut confier à un responsable. Même liste que la table profile_rights. */
export const AREAS = [
  ['checklists', 'Checklists', 'Créer et modifier les listes, plan de nettoyage compris'],
  ['stocks', 'Stocks et commandes', 'Produits, seuils, prix et fournisseurs ; annuler une commande'],
  ['procedures', 'Procédures', 'Écrire les procédures, voir qui les a lues'],
  ['fiches', 'Fiches techniques', 'Écrire les recettes, voir les coûts et les marges'],
  ['hygiene', 'Hygiène', 'Enceintes froides, suppression des relevés'],
  ['maintenance', 'Maintenance', 'Supprimer une panne ; contrôles et contrats (pas les documents de l\'équipe)'],
  ['planning', 'Planning', 'Écrire le planning, accepter les congés et les échanges'],
  ['pointages', 'Pointages', 'Corriger les heures, ajouter un pointage, exporter'],
  ['reservations', 'Réservations', 'Horaires, créneaux et règles de la réservation en ligne'],
  ['evenements', 'Événements et clients', 'Créer, chiffrer et confirmer les événements'],
  ['caisse', 'Caisse', 'Fermetures de caisse : corriger tous les jours, historique et export'],
] as const;

export type Area = (typeof AREAS)[number][0];
export const AREA_LABEL = Object.fromEntries(AREAS.map(([a, l]) => [a, l])) as Record<Area, string>;

/**
 * Ce que la personne peut modifier. Le gérant peut tout ; un responsable, ce que le gérant lui a confié,
 * et seulement avec son compte (jamais dans une session à code PIN). La base applique les mêmes règles.
 */
export function useCan(): (area: Area) => boolean {
  const { profile, pin } = useSession();
  const delegated = !!profile && !pin && profile.role === 'responsable';
  const rights = useQuery({
    queryKey: ['rights', profile?.id],
    enabled: delegated,
    queryFn: async () => {
      const { data, error } = await supabase.from('profile_rights').select('area').eq('profile_id', profile!.id);
      // Base pas encore mise à jour : aucun accès délégué.
      if (error) return [] as string[];
      return (data as { area: string }[]).map((r) => r.area);
    },
  });
  return (area) => !pin && (profile?.role === 'gerant' || (delegated && (rights.data ?? []).includes(area)));
}
