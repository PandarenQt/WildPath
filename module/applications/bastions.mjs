import {BUILD_COST, ENLARGE_COST, canAddSpecial, defendersLost, recruited, tradeSale} from "../helpers/bastions.mjs";
import {craftingPlan, spendGold} from "../helpers/crafting.mjs";

/**
 * Bastions (2024 DMG, 2026-10-22). A character's Bastion is its facilities (Items) and `system.bastion` (its defenders and
 * map). The GM's "Bastion Turn" tool among the Token controls moves the world 7 days on; each player character's special
 * facilities carry out the orders issued them on its sheet:
 * - Craft: 7 more days on the Item dropped on the facility; when its days (helpers/crafting.mjs) are spent, its materials
 *   are paid from the character's coins and it gains the Item;
 * - Trade: a facility with stock (a Storehouse) buys stock with the character's coins, up to its limit, or sells what it
 *   holds at its profit;
 * - Recruit: up to 4 Bastion Defenders, as many as its facilities house (a Barrack's 12);
 * - the rest (Empower, Harvest, Research, a Stable's trade): its text says what the GM gives.
 * A character whose facilities all maintain has a Bastion event: the "Bastion Events" table a converted book provides,
 * else a d100. An Attack costs a defender for each 1 on 6d6.
 * Each order then goes back to Maintain.
 */

const localize = key => globalThis.game?.i18n?.localize?.(key) ?? key;
const format = (key, data) => globalThis.game?.i18n?.format?.(key, data) ?? key;
const facilitiesOf = actor => [...(actor?.items ?? [])].filter(item => item.type === "facility");

/** A character's special facilities and the orders issued them this turn; `quiet` when every one maintains. */
export function bastionTurn(actor) {
  const special = facilitiesOf(actor).filter(item => item.system?.kind === "special");
  const orders = special.filter(item => (item.system?.current?.order ?? "maintain") !== "maintain")
    .map(item => ({facility: item, order: item.system.current.order}));
  return {special, orders, quiet: special.length > 0 && !orders.length};
}

/** What one order yields this turn, as a line for the chat; it applies what it can. */
export async function carryOut(actor, facility, order) {
  const name = actor.name;
  const label = localize(`WILDPATH.BASTION.Orders.${order}`);
  if ( (order === "craft") && facility.system.current?.craft ) {
    const made = await globalThis.fromUuid?.(facility.system.current.craft);
    if ( !made ) return format("WILDPATH.BASTION.CraftLost", {name, facility: facility.name});
    const plan = craftingPlan({price: made.system?.price ?? made.flags?.wildpath?.price, rarity: made.system?.rarity ?? made.flags?.wildpath?.rarity,
      consumable: made.flags?.wildpath?.source?.type === "consumable", scrollLevel: made.flags?.wildpath?.scrollLevel ?? null});
    const progress = (Number(facility.system.current.progress) || 0) + 7;
    if ( progress < plan.days ) {
      await facility.update({"system.current.progress": progress});
      return format("WILDPATH.BASTION.Crafting", {name, facility: facility.name, item: made.name, progress, days: plan.days});
    }
    const coins = spendGold(actor.system.currency ?? {}, plan.cost);
    if ( !coins ) return format("WILDPATH.BASTION.CraftPoor", {name, item: made.name, cost: plan.cost});
    await actor.update({"system.currency": coins});
    const {_id, ...data} = made.toObject();
    await actor.createEmbeddedDocuments("Item", [{...data, system: {...data.system, ...("quantity" in (data.system ?? {}) ? {quantity: 1} : {})}}]);
    await facility.update({"system.current.craft": "", "system.current.progress": 0});
    return format("WILDPATH.BASTION.Crafted", {name, facility: facility.name, item: made.name, cost: plan.cost});
  }
  if ( (order === "trade") && (Number(facility.system.trade?.stockMax) > 0) ) {
    const stock = Number(facility.system.trade.stock) || 0;
    if ( stock > 0 ) {
      const gold = tradeSale(stock, facility.system.trade.profit);
      await actor.update({"system.currency.gp": (Number(actor.system.currency?.gp) || 0) + gold});
      await facility.update({"system.trade.stock": 0});
      return format("WILDPATH.BASTION.Sold", {name, facility: facility.name, gold});
    }
    const spend = Math.min(Number(facility.system.trade.stockMax), Math.floor((Number(actor.system.currency?.pp) || 0) * 10
      + (Number(actor.system.currency?.gp) || 0)));
    const coins = spend > 0 ? spendGold(actor.system.currency ?? {}, spend) : null;
    if ( !coins ) return format("WILDPATH.BASTION.NoStock", {name, facility: facility.name});
    await actor.update({"system.currency": coins});
    await facility.update({"system.trade.stock": spend});
    return format("WILDPATH.BASTION.Stocked", {name, facility: facility.name, gold: spend});
  }
  if ( (order === "recruit") && (Number(facility.system.defenders) > 0) ) {
    const capacity = facilitiesOf(actor).reduce((total, item) => total + (Number(item.system?.defenders) || 0), 0);
    const added = recruited(actor.system.bastion?.defenders, capacity);
    await actor.update({"system.bastion.defenders": (Number(actor.system.bastion?.defenders) || 0) + added});
    return format("WILDPATH.BASTION.Recruited", {name, facility: facility.name, count: added});
  }
  return format("WILDPATH.BASTION.Order", {name, facility: facility.name, order: label});
}

/** The "Bastion Events" table a converted book provides, if any. */
async function eventsTable() {
  for ( const pack of globalThis.game?.packs ?? [] ) {
    if ( pack.documentName !== "RollTable" ) continue;
    for ( const entry of (await pack.getIndex()).filter(row => row.name === "Bastion Events") ) {
      const table = await pack.getDocument(entry._id);
      if ( table?.results?.size ) return table;
    }
  }
  return null;
}

/** A quiet Bastion's event: its table's result, and an Attack's cost in defenders. */
async function bastionEvent(actor) {
  const table = await eventsTable();
  const drawn = table ? (await table.draw({displayChat: false}))?.results?.[0] : null;
  const roll = drawn ? null : await new Roll("1d100").evaluate();
  const result = drawn?.name || drawn?.description?.replace(/<[^>]+>/g, " ").trim() || null;
  if ( result && /^Attack/i.test(result) ) {
    const dice = await new Roll("6d6").evaluate();
    const lost = Math.min(defendersLost(dice.dice[0].results.map(entry => entry.result)), Number(actor.system.bastion?.defenders) || 0);
    if ( lost ) await actor.update({"system.bastion.defenders": (Number(actor.system.bastion?.defenders) || 0) - lost});
    return format("WILDPATH.BASTION.Attack", {name: actor.name, lost});
  }
  return result ? format("WILDPATH.BASTION.EventDrawn", {name: actor.name, event: result})
    : format("WILDPATH.BASTION.Event", {name: actor.name, total: roll.total});
}

export async function runBastionTurn() {
  const game = globalThis.game;
  const characters = [...game.actors].filter(actor => (actor.type === "character") && actor.hasPlayerOwner);
  const lines = [];
  for ( const actor of characters ) {
    const {special, orders, quiet} = bastionTurn(actor);
    if ( !special.length ) continue;
    for ( const {facility, order} of orders ) lines.push(await carryOut(actor, facility, order));
    if ( quiet ) lines.push(await bastionEvent(actor));
    for ( const {facility} of orders ) await facility.update({"system.current.order": "maintain"});
  }
  await game.time?.advance?.(7 * 86400);
  await ChatMessage.create({content: `<h3>${localize("WILDPATH.BASTION.Turn")}</h3>${lines.length
    ? `<ul>${lines.map(line => `<li>${line}</li>`).join("")}</ul>` : `<p>${localize("WILDPATH.BASTION.Nothing")}</p>`}`});
}

/**
 * Whether a facility may join a character's Bastion (WildPathItem#_preCreate): a special one needs its level and a free
 * slot; a basic one past the first two free costs its space's gold (paid from the character's coins). Returns false to
 * refuse, after saying why.
 */
export async function admitFacility(actor, data) {
  if ( (actor?.type !== "character") || (data?.type !== "facility") ) return true;
  const level = Number(actor.system?.details?.level) || 0;
  const system = data.system ?? {};
  const facilities = facilitiesOf(actor);
  if ( (system.kind ?? "special") === "special" ) {
    const refusal = canAddSpecial({level, facilityLevel: system.level, specialCount: facilities.filter(item => item.system?.kind === "special").length});
    if ( refusal ) globalThis.ui?.notifications?.warn?.(format(refusal.key, refusal.data));
    return !refusal;
  }
  if ( facilities.filter(item => item.system?.kind === "basic").length < 2 ) return true;
  const [cost, days] = BUILD_COST[system.size] ?? BUILD_COST.cramped;
  const coins = spendGold(actor.system?.currency ?? {}, cost);
  if ( !coins ) {
    globalThis.ui?.notifications?.warn?.(format("WILDPATH.BASTION.CantBuild", {name: actor.name, cost}));
    return false;
  }
  await actor.update({"system.currency": coins});
  await ChatMessage.create({content: format("WILDPATH.BASTION.Built", {name: actor.name, facility: data.name, cost, days})});
  return true;
}

/** Enlarge a basic facility one space, paid from its character's coins (Cramped to Roomy, Roomy to Vast). */
export async function enlargeFacility(facility) {
  const actor = facility.actor;
  const step = ENLARGE_COST[facility.system?.size];
  if ( !actor || (facility.system?.kind !== "basic") || !step ) return false;
  const [cost, days, size] = step;
  const coins = spendGold(actor.system?.currency ?? {}, cost);
  if ( !coins ) {
    globalThis.ui?.notifications?.warn?.(format("WILDPATH.BASTION.CantBuild", {name: actor.name, cost}));
    return false;
  }
  await actor.update({"system.currency": coins});
  await facility.update({"system.size": size});
  await ChatMessage.create({content: format("WILDPATH.BASTION.Enlarged", {name: actor.name, facility: facility.name, size: localize(`WILDPATH.BASTION.Sizes.${size}`), cost, days})});
  return true;
}

export function registerBastions() {
  globalThis.Hooks?.on?.("getSceneControlButtons", controls => {
    const tokens = controls?.tokens;
    if ( !tokens?.tools || !globalThis.game?.user?.isGM ) return;
    tokens.tools.bastionTurn = {name: "bastionTurn", title: "WILDPATH.BASTION.Turn", icon: "fa-solid fa-chess-rook", button: true,
      order: Object.keys(tokens.tools).length + 1, onChange: () => void runBastionTurn()};
  });
}
