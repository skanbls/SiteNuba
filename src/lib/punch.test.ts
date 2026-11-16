import { describe, expect, it } from 'vitest';
import { parsePunchLink } from './punch';

const site = '0b9f6c1e-52a4-4f0e-9d0c-3f1f6a2b7c88';

describe('lien de pointage', () => {
  it('lit le lieu et le code', () => {
    expect(parsePunchLink(`https://exemple.fr/app/#/pointer?s=${site}&c=042917`)).toEqual({ site, code: '042917' });
  });
  it('refuse un QR code qui ne vient pas de la borne', () => {
    expect(parsePunchLink('https://exemple.fr/menu.pdf')).toBeNull();
    expect(parsePunchLink(`https://exemple.fr/#/pointer?s=${site}&c=12ab56`)).toBeNull();
    expect(parsePunchLink('https://exemple.fr/#/pointer?s=nimporte&c=123456')).toBeNull();
  });
});
