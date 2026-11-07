import {BUILD_COST, ENLARGE_COST, bastionGroups, canAddSpecial, coverLosses, defendersLost, recruited, tradeSale} from "../helpers/bastions.mjs";
import {craftingPlanOf, giveItem, spendGold, writeInOrder} from "../helpers/crafting.mjs";

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
 * else a d100. An Attack costs a defender for each 1 on 6d6; one that leaves none shuts a special facility (chosen at
 * random) down: it sits out the next Bastion turn, then is repaired. In a shared Bastion, members who cover the others
 * (`system.bastion.shared.cover`) take an Attack's losses in their place, most defenders first.
 * Each order then goes back to Maintain. The turn's chat lists a shared Bastion's lines under its members' names.
 */

const localize = key => globalThis.game?.i18n?.localize?.(key) ?? key;
const format = (key, data) => globalThis.game?.i18n?.format?.(key, data) ?? key;
const facilitiesOf = actor => [...(actor?.items ?? [])].filter(item => item.type === "facility");
// shortcut: an Armory is known by its English name; upgrade when facilities carry dnd5e's identifier.
const isArmory = facility => /^armory$/i.test(facility?.name ?? "");

/**
 * A character's special facilities, the orders issued them this turn, and those shut down (`shut`), which carry out
 * none, as if they maintained; `quiet` when every one maintains.
 */
export function bastionTurn(actor) {
  const special = facilitiesOf(actor).filter(item => item.system?.kind === "special");
  const shut = special.filter(item => item.system?.current?.shutDown);
  const orders = special.filter(item => !shut.includes(item) && ((item.system?.current?.order ?? "maintain") !== "maintain"))
    .map(item => ({facility: item, order: item.system.current.order}));
  return {special, orders, shut, quiet: special.length > 0 && !orders.length};
}

/** What one order yields this turn, as a line for the chat; it applies what it can. */
export async function carryOut(actor, facility, order) {
  const name = actor.name;
  const label = localize(`WILDPATH.BASTION.Orders.${order}`);
  if ( (order === "craft") && facility.system.current?.craft ) {
    const made = await globalThis.fromUuid?.(facility.system.current.craft);
    if ( !made ) return format("WILDPATH.BASTION.CraftLost", {name, facility: facility.name});
    const plan = craftingPlanOf(made);
    const progress = (Number(facility.system.current.progress) || 0) + 7;
    if ( progress < plan.days ) {
      await facility.update({"system.current.progress": progress});
      return format("WILDPATH.BASTION.Crafting", {name, facility: facility.name, item: made.name, progress, days: plan.days});
    }
    const coins = spendGold(actor.system.currency ?? {}, plan.cost);
    if ( !coins ) return format("WILDPATH.BASTION.CraftPoor", {name, item: made.name, cost: plan.cost});
    const {_id, ...data} = made.toObject();
    await writeInOrder([[facility, {"system.current.craft": "", "system.current.progress": 0}], [actor, {"system.currency": coins}],
      () => giveItem(actor, {...data, system: {...data.system, ...("quantity" in (data.system ?? {}) ? {quantity: 1} : {})}})]);
    return format("WILDPATH.BASTION.Crafted", {name, facility: facility.name, item: made.name, cost: plan.cost});
  }
  // Stocking an Armory: 100 GP plus 100 per Bastion Defender, half with a Smithy; stocked, defenders are harder to kill.
  if ( (order === "trade") && isArmory(facility) ) {
    const smithy = facilitiesOf(actor).some(item => /^smithy$/i.test(item.name ?? ""));
    const cost = (100 + (100 * (Number(actor.system.bastion?.defenders) || 0))) / (smithy ? 2 : 1);
    const coins = spendGold(actor.system.currency ?? {}, cost);
    if ( !coins ) return format("WILDPATH.BASTION.CraftPoor", {name, item: facility.name, cost});
    await writeInOrder([[actor, {"system.currency": coins}], [facility, {"system.trade.stock": 1}]]);
    return format("WILDPATH.BASTION.Stocked", {name, facility: facility.name, gold: cost});
  }
  if ( (order === "trade") && (Number(facility.system.trade?.stockMax) > 0) ) {
    const stock = Number(facility.system.trade.stock) || 0;
    if ( stock > 0 ) {
      const gold = tradeSale(stock, facility.system.trade.profit);
      await writeInOrder([[facility, {"system.trade.stock": 0}], [actor, {"system.currency.gp": (Number(actor.system.currency?.gp) || 0) + gold}]]);
      return format("WILDPATH.BASTION.Sold", {name, facility: facility.name, gold});
    }
    const spend = Math.min(Number(facility.system.trade.stockMax), Math.floor((Number(actor.system.currency?.pp) || 0) * 10
      + (Number(actor.system.currency?.gp) || 0)));
    const coins = spend > 0 ? spendGold(actor.system.currency ?? {}, spend) : null;
    if ( !coins ) return format("WILDPATH.BASTION.NoStock", {name, facility: facility.name});
    await writeInOrder([[actor, {"system.currency": coins}], [facility, {"system.trade.stock": spend}]]);
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
async function eventsTable(game) {
  for ( const pack of game?.packs ?? [] ) {
    if ( pack.documentName !== "RollTable" ) continue;
    for ( const entry of (await pack.getIndex()).filter(row => row.name === "Bastion Events") ) {
      const table = await pack.getDocument(entry._id);
      if ( table?.results?.size ) return table;
    }
  }
  return null;
}

/** A quiet Bastion's event: its table's result, and an Attack's cost in defenders (`group`: its shared Bastion's members). */
async function bastionEvent(actor, game, group=[actor]) {
  const table = await eventsTable(game);
  const drawn = table ? (await table.draw({displayChat: false}))?.results?.[0] : null;
  const roll = drawn ? null : await new Roll("1d100").evaluate();
  const result = drawn?.name || drawn?.description?.replace(/<[^>]+>/g, " ").trim() || null;
  if ( result && /^Attack/i.test(result) ) {
    // A stocked Armory: d8s in place of the d6s, and its stock is spent. shortcut: Defensive Walls' 2 fewer dice are the GM's.
    const armory = facilitiesOf(actor).find(item => isArmory(item) && (Number(item.system?.trade?.stock) > 0));
    const dice = await new Roll(armory ? "6d8" : "6d6").evaluate();
    if ( armory ) await armory.update({"system.trade.stock": 0});
    const defenders = Number(actor.system.bastion?.defenders) || 0;
    // The members covering this one take its losses first; it loses what they can't. Only what it could lose is covered:
    // a Bastion with no defenders shuts down whatever its allies hold.
    const covers = group.filter(member => (member !== actor) && member.system?.bastion?.shared?.cover);
    const {by, rest: lost} = coverLosses(Math.min(defendersLost(dice.dice[0].results.map(entry => entry.result)), defenders),
      covers.map(member => ({id: member.id, defenders: member.system.bastion.defenders})));
    if ( lost ) await actor.update({"system.bastion.defenders": defenders - lost});
    const lines = [format("WILDPATH.BASTION.Attack", {name: actor.name, lost})];
    for ( const {id, lost: count} of by ) {
      const member = covers.find(cover => cover.id === id);
      await member.update({"system.bastion.defenders": (Number(member.system.bastion.defenders) || 0) - count});
      lines.push(format("WILDPATH.BASTION.Covered", {name: member.name, count, ally: actor.name}));
    }
    const open = facilitiesOf(actor).filter(item => (item.system?.kind === "special") && !item.system?.current?.shutDown);
    if ( (defenders - lost > 0) || !open.length ) return lines.join(" ");
    const shut = open[(await new Roll(`1d${open.length}`).evaluate()).total - 1];
    await shut.update({"system.current.shutDown": true});
    return [...lines, format("WILDPATH.BASTION.ShutDown", {name: actor.name, facility: shut.name})].join(" ");
  }
  return result ? format("WILDPATH.BASTION.EventDrawn", {name: actor.name, event: result})
    : format("WILDPATH.BASTION.Event", {name: actor.name, total: roll.total});
}

/** A Bastion turn in progress on this client: a second click while it runs does nothing. */
let running = false;

/**
 * A Bastion turn: each character's orders, then an event for each whose special facilities all maintain. Only the active
 * GM runs it, so a second GM client (or a second login as the GM) never runs it again.
 */
export async function runBastionTurn({game=globalThis.game, ChatMessage=globalThis.ChatMessage}={}) {
  if ( running || !game?.user?.id || (game.users?.activeGM?.id !== game.user.id) ) return;
  running = true;
  try {
    const characters = [...game.actors].filter(actor => (actor.type === "character") && actor.hasPlayerOwner);
    // Bastions as they stand when the turn starts: one joined or left during it counts from the next turn.
    const solo = [];
    const shared = [];
    for ( const group of bastionGroups(characters).values() ) {
      const lines = group[0].system?.bastion?.shared?.id ? [] : solo;
      for ( const actor of group ) {
        // One character's error ends only its part, said in the chat: running the whole turn again would give the others
        // a second event and move time on twice.
        try {
          await bastionActor(actor, game, group, lines);
        } catch (error) {
          console.error(`Wild Path | ${actor.name}'s Bastion turn failed`, error);
          lines.push(format(error instanceof AggregateError ? "WILDPATH.BASTION.FailedUndo" : "WILDPATH.BASTION.Failed", {name: actor.name}));
        }
      }
      if ( (lines !== solo) && lines.length ) shared.push({names: group.map(actor => actor.name).join(", "), lines});
    }
    await game.time?.advance?.(7 * 86400);
    const list = lines => `<ul>${lines.map(line => `<li>${line}</li>`).join("")}</ul>`;
    const body = (solo.length ? list(solo) : "") + shared.map(({names, lines}) =>
      `<h4>${format("WILDPATH.BASTION.SharedTitle", {names})}</h4>${list(lines)}`).join("");
    await ChatMessage.create({content: `<h3>${localize("WILDPATH.BASTION.Turn")}</h3>${body || `<p>${localize("WILDPATH.BASTION.Nothing")}</p>`}`});
  } finally {
    running = false;
  }
}

/** One character's part of a Bastion turn, its lines added to `lines`. */
async function bastionActor(actor, game, group, lines) {
  const {special, orders, shut, quiet} = bastionTurn(actor);
  if ( !special.length ) return;
  // Shut down by last turn's Attack: it sits this turn out (its order waits), then is repaired.
  for ( const facility of shut ) {
    lines.push(format("WILDPATH.BASTION.Repaired", {name: actor.name, facility: facility.name}));
    await facility.update({"system.current.shutDown": false});
  }
  // Each order back to Maintain before it is carried out, and given back if that fails having put back its own writes
  // (writeInOrder), so the next turn carries it out; one whose writes could not be put back is not. One its player gave
  // while the turn ran (no longer the order carried out) stays for the next turn.
  for ( const {facility, order} of orders ) {
    const claimed = facility.system?.current?.order === order;
    if ( claimed ) await facility.update({"system.current.order": "maintain"});
    try {
      lines.push(await carryOut(actor, facility, order));
    } catch (error) {
      const undone = !(error instanceof AggregateError);
      if ( claimed && undone && (facility.system?.current?.order === "maintain") ) await facility.update({"system.current.order": order});
      throw error;
    }
  }
  if ( quiet ) lines.push(await bastionEvent(actor, game, group));
}

/**
 * Whether a facility may join a character's Bastion (WildPathItem#_preCreate): a special one needs its level and a free
 * slot; a basic one past the first two free costs its space's gold. `batch` counts the facilities admitted earlier in
 * the same creation (none exists yet), and the gold they will cost. Returns `{ok, cost, days}`; refused, after saying
 * why. Nothing is paid here: payFacility does that once the facility exists.
 */
export function admitFacility(actor, data, batch={special: 0, basic: 0, cost: 0}) {
  if ( (actor?.type !== "character") || (data?.type !== "facility") ) return {ok: true, cost: 0};
  const level = Number(actor.system?.details?.level) || 0;
  const system = data.system ?? {};
  const facilities = facilitiesOf(actor);
  if ( (system.kind ?? "special") === "special" ) {
    const refusal = canAddSpecial({level, facilityLevel: system.level,
      specialCount: facilities.filter(item => item.system?.kind === "special").length + batch.special});
    if ( refusal ) globalThis.ui?.notifications?.warn?.(format(refusal.key, refusal.data));
    if ( !refusal ) batch.special++;
    return {ok: !refusal, cost: 0};
  }
  const basics = facilities.filter(item => item.system?.kind === "basic").length + batch.basic;
  if ( basics < 2 ) {
    batch.basic++;
    return {ok: true, cost: 0};
  }
  const [cost, days] = BUILD_COST[system.size || "cramped"] ?? BUILD_COST.cramped;
  if ( !spendGold(actor.system?.currency ?? {}, batch.cost + cost) ) {
    globalThis.ui?.notifications?.warn?.(format("WILDPATH.BASTION.CantBuild", {name: actor.name, cost}));
    return {ok: false, cost};
  }
  batch.basic++;
  batch.cost += cost;
  return {ok: true, cost, days};
}

/** A built facility's gold, paid once it exists (WildPathItem#_onCreate), and the chat saying so. */
export async function payFacility(actor, name, {cost=0, days=0}={}) {
  const coins = cost ? spendGold(actor.system?.currency ?? {}, cost) : null;
  if ( !coins ) return;
  await actor.update({"system.currency": coins});
  await ChatMessage.create({content: format("WILDPATH.BASTION.Built", {name: actor.name, facility: name, cost, days})});
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
  await writeInOrder([[actor, {"system.currency": coins}], [facility, {"system.size": size}]]);
  await ChatMessage.create({content: format("WILDPATH.BASTION.Enlarged", {name: actor.name, facility: facility.name, size: localize(`WILDPATH.BASTION.Sizes.${size}`), cost, days})});
  return true;
}

/**
 * A character joining the shared Bastion `id`, founding it (an id no one carries yet), or leaving its own (""), said in
 * chat so the table sees it: joining is open to any group (owner's question 3), and only the character's owner, or the
 * GM removing a member, can write it.
 */
export async function shareBastion(actor, id, {game=globalThis.game, ChatMessage=globalThis.ChatMessage}={}) {
  if ( (actor?.system?.bastion?.shared?.id ?? "") === id ) return;
  const group = id ? [...game.actors].filter(other => (other.type === "character") && other.visible
    && (other.system?.bastion?.shared?.id === id)) : [];
  await actor.update({"system.bastion.shared.id": id});
  const key = !id ? "Left" : group.length ? "Joined" : "Founded";
  await ChatMessage.create({content: format(`WILDPATH.BASTION.${key}`, {name: actor.name, names: group.map(other => other.name).join(", ")})});
}

export function registerBastions() {
  globalThis.Hooks?.on?.("getSceneControlButtons", controls => {
    const tokens = controls?.tokens;
    if ( !tokens?.tools || !globalThis.game?.user?.isGM ) return;
    tokens.tools.bastionTurn = {name: "bastionTurn", title: "WILDPATH.BASTION.Turn", icon: "fa-solid fa-chess-rook", button: true,
      order: Object.keys(tokens.tools).length + 1, onChange: () => void runBastionTurn().catch(error => {
        globalThis.ui?.notifications?.error?.(localize("WILDPATH.BASTION.TurnFailed"));
        throw error;
      })};
  });
}
