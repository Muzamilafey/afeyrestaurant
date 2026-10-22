import { describe, it, expect } from 'vitest';
import { money, toCents, fromCents, titleCase } from './format';

describe('format', () => {
  it('formats integer cents as Kenyan shillings', () => {
    expect(money(147000)).toBe('KSh 1,470.00');
    expect(money(5, false)).toBe('0.05');
    expect(money(null)).toBe('KSh 0.00');
  });
  it('converts between shillings and cents without float drift', () => {
    expect(toCents('19.99')).toBe(1999);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(fromCents(1999)).toBe('19.99');
    expect(titleCase('bar_counter')).toBe('Bar Counter');
  });
});
