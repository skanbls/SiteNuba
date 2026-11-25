import { describe, expect, it } from 'vitest';
import { driveTree, fmtSize, type DriveFile } from './driveTree';

const f = (id: string, folder: string[], name: string, profile_id: string | null = null): DriveFile =>
  ({ id, folder, name, mime: 'application/pdf', size: 1000, modified_at: '2026-11-20T09:00:00Z', profile_id, storage_path: `drive/${id}/1`, pending_path: null });

describe('dossier des salariés', () => {
  const files = [
    f('a', ['LÉA TEST', 'DPAE'], 'DPAE.pdf', 'p1'),
    f('b', ['LÉA TEST', 'BULLETINS DE PAIE'], 'Paie 10.pdf', 'p1'),
    f('c', ['LÉA TEST', 'BULLETINS DE PAIE'], 'Paie 9.pdf', 'p1'),
    f('d', ['FICHES DE POSTE'], 'Serveur.pdf'),
    f('e', [], 'Lisez-moi.pdf'),
  ];
  it("garde l'arborescence du Drive, dossiers et fichiers par ordre alphabétique", () => {
    const t = driveTree(files);
    expect(t.count).toBe(5);
    expect(t.files.map((x) => x.name)).toEqual(['Lisez-moi.pdf']);
    expect(t.folders.map((x) => `${x.name} (${x.count})`)).toEqual(['FICHES DE POSTE (1)', 'LÉA TEST (3)']);
    const lea = t.folders[1];
    expect(lea.folders.map((x) => x.name)).toEqual(['BULLETINS DE PAIE', 'DPAE']);
    expect(lea.folders[0].files.map((x) => x.name)).toEqual(['Paie 9.pdf', 'Paie 10.pdf']);
    expect(lea.folders[0].path).toEqual(['LÉA TEST', 'BULLETINS DE PAIE']);
  });
  it("montre le dossier d'une personne sans répéter son nom", () => {
    const t = driveTree(files.filter((x) => x.profile_id === 'p1'), 1);
    expect(t.folders.map((x) => x.name)).toEqual(['BULLETINS DE PAIE', 'DPAE']);
  });
  it('écrit la taille simplement', () => {
    expect(fmtSize(800)).toBe('1 Ko');
    expect(fmtSize(820 * 1024)).toBe('820 Ko');
    expect(fmtSize(2.4 * 1024 * 1024)).toBe('2,4 Mo');
    expect(fmtSize(null)).toBe('');
  });
});
