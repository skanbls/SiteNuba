/**
 * Le dossier des salariés copié depuis le Drive (migration 0028) : la même arborescence que dans Google Drive,
 * un dossier par personne, ses sous-dossiers, les dossiers communs.
 */
export interface DriveFile {
  id: string;
  /** Les dossiers depuis la racine : ["PRÉNOM NOM", "DPAE"]. */
  folder: string[];
  name: string;
  mime: string;
  size: number | null;
  modified_at: string;
  profile_id: string | null;
  /** La copie téléchargeable ; null tant que le script ne l'a pas déposée. */
  storage_path: string | null;
  /** Une nouvelle version en cours de copie. */
  pending_path: string | null;
}

export interface DriveNode { name: string; path: string[]; folders: DriveNode[]; files: DriveFile[]; count: number }

const byName = (a: string, b: string) => a.localeCompare(b, 'fr', { numeric: true, sensitivity: 'base' });

/** L'arborescence des fichiers. `strip` : niveaux de dossiers retirés en tête (1 pour le dossier d'une personne). */
export function driveTree(files: DriveFile[], strip = 0): DriveNode {
  const root: DriveNode = { name: '', path: [], folders: [], files: [], count: 0 };
  for (const f of files) {
    let node = root;
    node.count++;
    for (const part of f.folder.slice(strip)) {
      let next = node.folders.find((x) => x.name === part);
      if (!next) {
        next = { name: part, path: [...node.path, part], folders: [], files: [], count: 0 };
        node.folders.push(next);
      }
      next.count++;
      node = next;
    }
    node.files.push(f);
  }
  const sort = (n: DriveNode) => {
    n.folders.sort((a, b) => byName(a.name, b.name));
    n.files.sort((a, b) => byName(a.name, b.name));
    n.folders.forEach(sort);
  };
  sort(root);
  return root;
}

/** « 820 Ko », « 2,4 Mo ». */
export function fmtSize(n: number | null | undefined): string {
  if (!n) return '';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} Ko`;
  return `${(n / 1024 / 1024).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mo`;
}
