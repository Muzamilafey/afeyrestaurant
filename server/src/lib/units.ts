import { badRequest } from './errors';

const STANDARD: Record<string, { base: 'g' | 'ml' | 'pcs'; factor: number }> = {
  g: { base: 'g', factor: 1 },
  kg: { base: 'g', factor: 1000 },
  mg: { base: 'g', factor: 0.001 },
  ml: { base: 'ml', factor: 1 },
  cl: { base: 'ml', factor: 10 },
  l: { base: 'ml', factor: 1000 },
  pcs: { base: 'pcs', factor: 1 },
  pc: { base: 'pcs', factor: 1 },
  dozen: { base: 'pcs', factor: 12 },
};

/** Convert a quantity in `unit` to the ingredient's base unit using standard or ingredient-specific units (bottle, keg, shot, crate…). */
export function toBaseQty(qty: number, unit: string | undefined, ingredient: { baseUnit: string; units?: Array<{ name?: string | null; factor?: number | null }>; name?: string }) {
  const u = (unit || ingredient.baseUnit).toLowerCase();
  const custom = ingredient.units?.find((x) => x.name?.toLowerCase() === u);
  if (custom?.factor) return round(qty * custom.factor);
  const std = STANDARD[u];
  if (std && std.base === ingredient.baseUnit) return round(qty * std.factor);
  throw badRequest(`Unit "${unit}" cannot be converted to ${ingredient.baseUnit} for ${ingredient.name ?? 'ingredient'}`);
}

export const round = (n: number, dp = 4) => Math.round(n * 10 ** dp) / 10 ** dp;
