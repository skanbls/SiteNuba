import { describe, expect, it } from 'vitest';
import { driveId, posterSrc } from './poster';

describe('affiches', () => {
  it('change un lien de partage Google Drive en image', () => {
    expect(posterSrc('https://drive.google.com/file/d/1AbCdEfGhIjK_lm-no/view?usp=sharing')).toBe('https://drive.google.com/thumbnail?id=1AbCdEfGhIjK_lm-no&sz=w1200');
    expect(posterSrc('https://drive.google.com/open?id=1AbCdEfGhIjK_lm-no', 400)).toBe('https://drive.google.com/thumbnail?id=1AbCdEfGhIjK_lm-no&sz=w400');
    expect(driveId('https://docs.google.com/uc?export=view&id=1AbCdEfGhIjK_lm-no')).toBe('1AbCdEfGhIjK_lm-no');
  });
  it('garde un lien d\'image ordinaire, refuse le reste', () => {
    expect(posterSrc(' https://exemple.fr/affiche.jpg ')).toBe('https://exemple.fr/affiche.jpg');
    expect(posterSrc('http://exemple.fr/affiche.jpg')).toBe('');
    expect(posterSrc('javascript:alert(1)')).toBe('');
    expect(posterSrc('')).toBe('');
    expect(driveId('https://exemple.fr/file/d/1AbCdEfGhIjK_lm-no')).toBe('');
  });
});
