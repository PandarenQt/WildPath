/**
 * Crafting and coins (2024 PHB and DMG, 2026-10-22).
 * - A mundane item takes raw materials worth half its price, and a day's work (8 hours) for each 10 GP of its price.
 * - A magic item takes its rarity's days and gold (Common 5 days and 50 GP to Legendary 250 days and 100,000 GP), half
 *   of each for a consumable (a potion, a scroll). A Spell Scroll takes its spell level's.
 * - Coins are a character's `system.currency` (pp, gp, ep, sp, cp); spending makes change from the largest coins down.
 * shortcut: the tool proficiency it needs, its formula and any rare ingredient are the GM's to check; upgrade with tool
 * proficiencies on items.
 */

const MAGIC = Object.freeze({common: [5, 50], uncommon: [10, 200], rare: [50, 2000], veryRare: [125, 20000], legendary: [250, 100000]});
const SCROLLS = Object.freeze([[1, 15], [1, 25], [3, 100], [5, 150], [10, 1000], [25, 1500], [40, 10000], [50, 12500], [60, 15000], [120, 50000]]);
const COINS = Object.freeze({pp: 1000, gp: 100, ep: 50, sp: 10, cp: 1});

/** What crafting `item` takes: `{days, cost}` (gold). `scrollLevel` for a Spell Scroll. */
export function craftingPlan({price=0, rarity="", consumable=false, scrollLevel=null}={}) {
  if ( Number.isFinite(Number(scrollLevel)) && (scrollLevel !== null) ) {
    const [days, cost] = SCROLLS[Math.min(Math.max(Math.floor(Number(scrollLevel)), 0), 9)];
    return {days, cost};
  }
  const magic = MAGIC[rarity];
  if ( magic ) return {days: consumable ? Math.ceil(magic[0] / 2) : magic[0], cost: consumable ? magic[1] / 2 : magic[1]};
  const value = Math.max(Number(price) || 0, 0);
  return {days: Math.max(Math.ceil(value / 10), 1), cost: value / 2};
}

/** A character's coins worth in copper. */
export const coinsInCopper = (currency={}) => Object.entries(COINS).reduce((total, [coin, value]) => total + ((Number(currency[coin]) || 0) * value), 0);

/** Its coins after spending `gold` (in GP), as change from its largest coins down; null when it has too little. */
export function spendGold(currency={}, gold=0) {
  const left = coinsInCopper(currency) - Math.round(Number(gold) * 100);
  if ( left < 0 ) return null;
  let rest = left;
  const result = {};
  for ( const [coin, value] of Object.entries(COINS).filter(([coin]) => coin !== "ep") ) {
    result[coin] = Math.floor(rest / value);
    rest -= result[coin] * value;
  }
  return {...result, ep: 0};
}

/**
 * Related writes made one after another, each `[document, update]` or, last, a function; when one fails, those made are
 * put back (the latest first) and the error rethrown, so a purchase pays and delivers once. Write what the character
 * gives up (stock, coins, the claim on a craft) before what it gains: a write that can't be put back leaves it short,
 * with an AggregateError, never paid twice. shortcut: separate updates, not one; upgrade if Foundry gains multi-document
 * transactions.
 */
export async function writeInOrder(writes) {
  const undo = [];
  try {
    for ( const write of writes ) {
      if ( typeof write === "function" ) {
        await write();
        continue;
      }
      const [document, data] = write;
      const before = structuredClone(Object.fromEntries(Object.keys(data).map(path =>
        [path, path.split(".").reduce((value, key) => value?.[key], document)])));
      await document.update(data);
      undo.unshift(() => document.update(before));
    }
  } catch (error) {
    try {
      for ( const step of undo ) await step();
    } catch (failed) {
      throw new AggregateError([error, failed], "A write failed and what it had written could not be put back.");
    }
    throw error;
  }
}

/** Gives `actor` the Item `data`, as writeInOrder's last step. */
export async function giveItem(actor, data) {
  // Foundry resolves a refused creation (a _preCreate or hook returning false, invalid data) with none made.
  const created = await actor.createEmbeddedDocuments("Item", [data]);
  if ( !created?.length ) throw new Error(`${data.name} could not be created on ${actor.name}.`);
}
