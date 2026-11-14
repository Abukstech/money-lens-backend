
import { describe, expect, it } from 'vitest';
import { Registry } from '../src/merchants/registry';

const registry = new Registry();

describe('Nigerian merchant context', () => {
  it('preserves the existing 248 vendors', () => {
    expect(registry.vendors).toHaveLength(248);
  });

  it('provides multiple purchase categories for Shoprite', () => {
    const match = registry.match('POS SHOPRITE LEKKI');

    const shoprite = match.merchants[0];

    expect(shoprite).toBeDefined();

    const categories = shoprite.typical_purchases.map(
      p => p.category,
    );

    expect(categories).toContain('groceries');
    expect(categories).toContain('shopping');
    expect(categories).toContain('personal_care');
  });

  it('provides telecommunications context for MTN', () => {
    const match = registry.match('MTN DATA BUNDLE');

    const mtn = match.merchants[0];

    expect(mtn.typical_purchases.some(
      p => p.category === 'telecommunications',
    )).toBe(true);
  });

  it('does not confuse processors with stores', () => {
    const match = registry.match(
      'PAYSTACK PAYMENT REF 9921',
    );

    expect(match.merchants).toHaveLength(0);
    expect(match.processors.length).toBeGreaterThan(0);
  });
});
