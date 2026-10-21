/**
 * Encounters and experience (2024 DMG and PHB, 2026-10-22).
 * - A creature's XP is its Challenge Rating's (`xpForThreat`).
 * - An encounter's difficulty is its creatures' total XP against the party's budget: each character's by its level, for
 *   Low, Moderate or High difficulty (no multiplier for numbers, 2024).
 * - A character's level by XP (`levelForXp`); the XP to its next (`xpForLevel`).
 */

/** XP by Challenge Rating. */
const XP_BY_CR = Object.freeze({0: 10, 0.125: 25, 0.25: 50, 0.5: 100, 1: 200, 2: 450, 3: 700, 4: 1100, 5: 1800, 6: 2300, 7: 2900, 8: 3900,
  9: 5000, 10: 5900, 11: 7200, 12: 8400, 13: 10000, 14: 11500, 15: 13000, 16: 15000, 17: 18000, 18: 20000, 19: 22000, 20: 25000,
  21: 33000, 22: 41000, 23: 50000, 24: 62000, 25: 75000, 26: 90000, 27: 105000, 28: 120000, 29: 135000, 30: 155000});

/** XP budget per character by level: Low, Moderate, High. */
const BUDGETS = Object.freeze([null, [50, 75, 100], [100, 150, 200], [150, 225, 400], [250, 375, 500], [500, 750, 1100],
  [600, 1000, 1400], [750, 1300, 1700], [1000, 1700, 2100], [1300, 2000, 2600], [1600, 2300, 3100], [1900, 2900, 4100],
  [2200, 3700, 4700], [2600, 4200, 5400], [2900, 4900, 6200], [3300, 5400, 7800], [3800, 6100, 9800], [4500, 7200, 11700],
  [5000, 8700, 14200], [5500, 10700, 17200], [6400, 13200, 22000]]);

/** XP needed for each level (index: level). */
const LEVEL_XP = Object.freeze([0, 0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000, 165000,
  195000, 225000, 265000, 305000, 355000]);

/** A creature's XP by its Challenge Rating (its `details.threat`). */
export function xpForThreat(threat) {
  const cr = Number(threat);
  if ( !Number.isFinite(cr) ) return 0;
  return XP_BY_CR[cr] ?? XP_BY_CR[Math.min(Math.max(Math.round(cr), 0), 30)] ?? 0;
}

/** The XP a character needs for `level`. */
export const xpForLevel = level => LEVEL_XP[Math.min(Math.max(Math.floor(Number(level) || 1), 1), 20)];

/** The level `xp` reaches. */
export function levelForXp(xp) {
  let level = 1;
  while ( (level < 20) && (Number(xp) >= LEVEL_XP[level + 1]) ) level++;
  return level;
}

/**
 * An encounter of `threats` (its foes' Challenge Ratings) against a party of `levels`: its XP, the party's budgets, and
 * its difficulty: "low", "moderate" or "high" (the highest budget it reaches, or "low" below the Low one), else
 * "beyond" (more than High).
 */
export function encounterDifficulty({levels=[], threats=[]}={}) {
  const xp = threats.reduce((total, threat) => total + xpForThreat(threat), 0);
  const budgets = levels.reduce((total, level) => {
    const row = BUDGETS[Math.min(Math.max(Math.floor(Number(level) || 1), 1), 20)];
    return {low: total.low + row[0], moderate: total.moderate + row[1], high: total.high + row[2]};
  }, {low: 0, moderate: 0, high: 0});
  const difficulty = (xp > budgets.high) ? "beyond" : (xp > budgets.moderate) ? "high" : (xp > budgets.low) ? "moderate" : "low";
  return {xp, budgets, difficulty};
}
