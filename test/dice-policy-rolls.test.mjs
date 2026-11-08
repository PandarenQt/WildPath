import {test} from "node:test";
import assert from "node:assert/strict";
import {diceTerms, rollFromTerms} from "./fixtures/foundry-dice-terms.mjs";

// Rolls outside an Action (Hit Dice, Recharge, Portent) answered by the dice policy, as an Action's are: physical dice typed
// into the roll prompt, digital dice rolled by Foundry. Only the globals needed to import the real Actor class.
globalThis.Actor = class {};
globalThis.foundry = {
  documents: {Combat: class {}, Combatant: class { _getInitiativeFormula() { return "1d20"; } async _preUpdate() {} }},
  data: {fields: {}, ActiveEffectTypeDataModel: class {}},
  utils: {isEmpty: value => Object.keys(value).length === 0, randomID: () => "abc", escapeHTML: value => value,
    mergeObject: (original, other) => Object.assign(original, other)},
  dice: {terms: diceTerms}
};
Math.clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const {default: WildPathActor} = await import("../module/documents/actor.mjs");
const {getCombatTurnStartLifecycleEvents} = await import("../module/helpers/combat.mjs");
const {simpleFormulaBounds} = await import("../module/helpers/rolls.mjs");
const {answerRollLocally} = await import("../module/resolvers/multiplayer-action-coordinator.mjs");
const {createPhysicalDiceProvider} = await import("../module/resolvers/roll-provider-resolver.mjs");
const {createFoundryDigitalRollProvider} = await import("../module/adapters/foundry-digital-roll-provider.mjs");
const {createTestPromptAdapter} = await import("../module/adapters/test-prompt-adapter.mjs");
const {rollPortentDice} = await import("../module/adapters/foundry-v14-portent.mjs");
const {default: WildPathCombat} = await import("../module/documents/combat.mjs");
const {default: WildPathCombatant} = await import("../module/documents/combatant.mjs");
const {chooseAbilityScores} = await import("../module/applications/ability-scores.mjs");

// The table's dice: digital dice roll their highest; physical ones are what `typed` answers, in order.
function table({policy, typed=[], rulesVersion="2024"}) {
  const asked = [];
  const titles = [];
  const posted = [];
  const created = [];
  globalThis.ChatMessage = {getSpeaker: () => ({}), create: async (data, options) => { created.push({data, options}); }};
  globalThis.Roll = class Roll {
    static fromData(data) { return Object.assign(new Roll(data.formula), data); }
    static fromTerms(terms) { return rollFromTerms(Roll, terms); }
    constructor(formula) { this.formula = formula; }
    async evaluate() {
      this.total = Number.isFinite(Number(this.formula)) ? Number(this.formula) : simpleFormulaBounds(this.formula).max;
      // A d20 test's natural die (a digital initiative roll reads it).
      this.dice = String(this.formula).includes("d20") ? [{faces: 20, number: 1, results: [{result: 20, active: true}]}] : [];
      return this;
    }
    toJSON() { return {formula: this.formula, total: this.total, dice: this.dice}; }
    async toMessage(data, options) { posted.push({formula: this.formula, total: this.total, flavor: data.flavor, options}); return {...data}; }
  };
  const prompt = createTestPromptAdapter({queue: typed});
  const providers = [createFoundryDigitalRollProvider(), createPhysicalDiceProvider()];
  const game = {i18n: {localize: key => key, format: (key, data) => `${key}:${JSON.stringify(data)}`},
    settings: {get: (scope, key) => (key === "rulesVersion" ? rulesVersion : null)},
    wildpath: {requestRoll: (rollRequest, {title}={}) => {
      asked.push(rollRequest);
      titles.push(title);
      return answerRollLocally({rollRequest, title, promptPorts: [prompt], rollProviders: providers,
        context: {providerId: policy === "physical" ? "physical-dice" : "foundry-digital"}});
    }}};
  globalThis.game = game;
  return {game, asked, titles, posted, created};
}

function creature({fortitude=10, pools=[], items=[], grants=[]}={}) {
  const source = {system: {pools: structuredClone(pools)}};
  const actor = Object.assign(Object.create(WildPathActor.prototype), {id: "spender", uuid: "Actor.spender", name: "Ana",
    effects: [], items, statuses: new Set(), flags: {}, updates: [],
    system: {abilities: {fortitude: {value: fortitude}}, resources: {health: {value: 5, max: 40}}, pools: structuredClone(pools)},
    toObject: () => structuredClone(source),
    getGrantedResources: () => grants,
    async applyConditionTriggers() { return {ok: true}; },
    async update(updates) { this.updates.push(structuredClone(updates)); }});
  return actor;
}

test("Hit Dice with physical dice: the roller types the total, each die floored where the rules floor its healing", async () => {
  const {asked, posted} = table({policy: "physical", typed: [{total: 9}]});
  // Fortitude 4 (-3): a die heals at least 1, so each counts as at least 4. Rolled 1 and 5: typed 4 + 5.
  const actor = creature({fortitude: 4, pools: [{id: "hit-die.d8", value: 3, max: 3}]});
  assert.equal(await actor.spendHitDice({8: 2}), 3, "1 + 2");
  assert.deepEqual([asked[0].formula, asked[0].type], ["2d8min4", "healing"]);
  assert.deepEqual(actor.updates[0]["system.pools"], [{id: "hit-die.d8", value: 1, max: 3}]);
  assert.equal(actor.updates[0]["system.resources.health.value"], 8);
  assert.equal(posted[0].formula, "9", "the typed roll's card shows its total");

  const digital = table({policy: "digital"});
  assert.equal(await creature({fortitude: 14, pools: [{id: "hit-die.d8", value: 3, max: 3}]}).spendHitDice({8: 2}), 20,
    "digital dice: 16 + 2 + 2");
  assert.equal(digital.posted[0].formula, "2d8", "rolled as the dice");

  table({policy: "physical", typed: [{ok: false, status: "cancelled"}]});
  const closed = creature({pools: [{id: "hit-die.d8", value: 3, max: 3}]});
  assert.equal(await closed.spendHitDice({8: 1}), 0, "closed unrolled: nothing healed");
  assert.deepEqual(closed.updates, [], "and no Hit Die spent");

  // Closing the first size's prompt backs out: the next size is not asked for.
  const backing = table({policy: "physical", typed: [{ok: false, status: "cancelled"}, {total: 4}]});
  const multiclass = creature({pools: [{id: "hit-die.d6", value: 1, max: 1}, {id: "hit-die.d10", value: 1, max: 1}]});
  assert.equal(await multiclass.spendHitDice({10: 1, 6: 1}), 0);
  assert.deepEqual([backing.asked.length, multiclass.updates], [1, []]);
});

test("Recharge is rolled by the GM with the table's dice: a typed d6 recharges; closed unrolled it stays spent", async () => {
  const recharging = async typed => {
    const {posted} = table({policy: "physical", typed});
    const actor = creature({pools: [{id: "fire-breath", value: 0, max: 1}], grants: [{id: "fire-breath", label: "Fire Breath", recharge: 5}]});
    const combat = {id: "combat", round: 1, turn: 0};
    const combatant = {id: "combatant", _id: "combatant", actor, actorId: actor.id, parent: combat};
    Object.assign(combat, {turns: [combatant], combatants: new Map([["combatant", combatant]]), combatant});
    const context = {round: 1, turn: 0, skipped: false};
    const result = await actor.startTurn({combat, combatant, context, events: getCombatTurnStartLifecycleEvents(combat, combatant, context)});
    assert.equal(result.ok, true);
    return {posted, pools: result.updates["system.pools"] ?? null};
  };
  const ready = await recharging([{total: 5}]);
  assert.deepEqual(ready.pools, [{id: "fire-breath", value: 1, max: 1}]);
  assert.match(ready.posted[0].flavor, /^WILDPATH\.RECHARGE\.Recharged/u);
  assert.deepEqual(ready.posted[0].options, {messageMode: "gm"});

  const spent = await recharging([{total: 4}]);
  assert.equal(spent.pools, null, "a typed 4 does not recharge it");
  assert.match(spent.posted[0].flavor, /^WILDPATH\.RECHARGE\.Spent/u);

  const closed = await recharging([{ok: false, status: "cancelled"}]);
  assert.deepEqual([closed.pools, closed.posted], [null, []], "nothing rolled, nothing told");
});

function startTurn(actor) {
  const combat = {id: "combat", round: 1, turn: 0};
  const combatant = {id: "combatant", _id: "combatant", actor, actorId: actor.id, parent: combat};
  Object.assign(combat, {turns: [combatant], combatants: new Map([["combatant", combatant]]), combatant});
  const context = {round: 1, turn: 0, skipped: false};
  return actor.startTurn({combat, combatant, context, events: getCombatTurnStartLifecycleEvents(combat, combatant, context)});
}

test("Recharge is asked for after the turn's refills are written, named for its creature, and keeps what changed meanwhile", async () => {
  const {game, titles} = table({policy: "physical", typed: [{total: 6}]});
  const actor = creature({pools: [{id: "action", value: 0, max: 1, recovery: "turn"}, {id: "fire-breath", value: 0, max: 1},
    {id: "spell", value: 2, max: 2}], grants: [{id: "fire-breath", label: "Fire Breath", recharge: 5}]});
  const source = {system: {pools: structuredClone(actor.system.pools)}};
  actor.toObject = () => structuredClone(source);
  actor.update = async function(updates) {
    this.updates.push(structuredClone(updates));
    if ( updates["system.pools"] ) source.system.pools = this.system.pools = structuredClone(updates["system.pools"]);
  };
  const ask = game.wildpath.requestRoll;
  let written = null;
  game.wildpath.requestRoll = (request, options) => {
    written = structuredClone(actor.updates);
    source.system.pools[2].value = 1; // a slot spent while the GM's prompt is open
    return ask(request, options);
  };
  await startTurn(actor);
  assert.equal(written[0]["system.pools"][0].value, 1, "the Action is back before the prompt");
  assert.deepEqual(actor.updates.at(-1)["system.pools"].map(pool => pool.value), [1, 1, 1], "recharged, the slot still spent");
  assert.equal(titles[0], 'WILDPATH.ROLL.Whose:{"name":"Ana","roll":"Fire Breath"}');
});

test("Portent's foretelling rolls with physical dice: each d20 typed on its own, the old dice lost even when one is closed", async () => {
  const feature = {name: "Portent", system: {active: true}, flags: {wildpath: {portentDice: 2}}};
  const {game, asked, titles, created} = table({policy: "physical", typed: [{total: 14}, {total: 3}]});
  const diviner = creature({items: [feature]});
  await rollPortentDice(diviner, game);
  assert.deepEqual(asked.map(request => request.formula), ["1d20", "1d20"]);
  assert.equal(titles[0], 'WILDPATH.ROLL.Whose:{"name":"Ana","roll":"WILDPATH.PORTENT.Title"}', "a GM's Party Rest says whose dice");
  assert.deepEqual(diviner.updates[0], {"flags.wildpath.portent": {1: 14, 2: 3, 3: 0}, "flags.wildpath.portentTurn": null});
  assert.deepEqual(created[0].data.rolls.map(roll => roll.total), [14, 3], "one card with both rolls");
  assert.deepEqual(created[0].options, {messageMode: "gm"});

  const closed = table({policy: "physical", typed: [{total: 17}, {ok: false, status: "cancelled"}]});
  const hasty = creature({items: [feature]});
  await rollPortentDice(hasty, closed.game);
  assert.deepEqual(hasty.updates[0]["flags.wildpath.portent"], {1: 17, 2: 0, 3: 0}, "the closed one is not rolled");

  const digital = table({policy: "digital"});
  const rolled = creature({items: [feature]});
  await rollPortentDice(rolled, digital.game);
  assert.deepEqual(rolled.updates[0]["flags.wildpath.portent"], {1: 20, 2: 20, 3: 0}, "digital dice roll each d20");
});

test("Initiative set where there was none counts as rolled; a later change does not", async () => {
  const fighter = (id, initiative) => Object.assign(Object.create(WildPathCombatant.prototype), {id, initiative});
  const options = {};
  await fighter("ada", null)._preUpdate({initiative: 15}, options);
  await fighter("bo", null)._preUpdate({initiative: 9}, options);
  assert.deepEqual(options.wildpath.initiativeRolled, {ada: true, bo: true}, "one batch, each Combatant by id");
  const edited = {};
  await fighter("ada", 15)._preUpdate({initiative: 17}, edited);
  await fighter("bo", null)._preUpdate({hidden: true}, edited);
  assert.deepEqual(edited, {}, "a GM's edit or Portent's replacement, and an update without initiative, are no roll");
});

test("Initiative with physical dice: the roller types the d20 and its modifier is added; a closed prompt stops the rest", async () => {
  const {asked, posted, created} = table({policy: "physical", typed: [{natural: 12}, {ok: false, status: "cancelled"}]});
  const fighter = (id, name, agility) => Object.assign(Object.create(WildPathCombatant.prototype), {id, name, isOwner: true, hidden: false,
    token: null, updated: [], async update(data) { this.updated.push(data); return this; },
    actor: {system: {abilities: {agility: {value: agility}}}, getRollModes: () => [], getStatistic: () => ({totalModifier: 0})}});
  const ada = fighter("ada", "Ada", 16);
  const bo = fighter("bo", "Bo", 10);
  const written = [];
  const combat = Object.assign(Object.create(WildPathCombat.prototype), {turn: 0, combatants: new Map([["ada", ada], ["bo", bo]]),
    async updateEmbeddedDocuments(...args) { written.push(args); }});
  await combat.rollInitiative(["ada", "bo"]);
  assert.deepEqual(asked.map(request => [request.type, request.formula]), [["initiative", "1d20 + 3"], ["initiative", "1d20"]]);
  assert.deepEqual(written, [["Combatant", [{_id: "ada", initiative: 15}], {turnEvents: false}]], "Bo's closed prompt rolls nothing");
  assert.deepEqual([posted[0].formula, posted[0].total], ["1d20 + 3", 15], "the typed roll's card shows its entered d20 and modifier");
  assert.deepEqual(created[0].data.map(message => message.flags), [{core: {initiativeRoll: true}}], "a Portent may replace its d20");

  // Digital dice roll it; a closed prompt on one Combatant's own roll leaves its initiative.
  table({policy: "digital"});
  assert.equal(await bo.rollInitiative(), bo);
  assert.deepEqual(bo.updated, [{initiative: 20}]);
  table({policy: "physical", typed: [{ok: false, status: "cancelled"}]});
  await ada.rollInitiative();
  assert.deepEqual(ada.updated, []);
});

test("Ability-score rolls with physical dice: a closed prompt keeps the scores rolled, and the next click rolls only the rest", async () => {
  const {asked} = table({policy: "physical",
    typed: [{total: 15}, {total: 14}, {ok: false, status: "cancelled"}, {total: 13}, {total: 12}, {total: 10}, {total: 9}]});
  globalThis.CONFIG = {WILDPATH: {ABILITIES: Object.fromEntries(["a", "b", "c", "d", "e", "f"].map(key => [key, {label: key}]))}};
  // The dialog's form, only as far as the dialog reads it.
  const elements = new Map();
  const form = {addEventListener() {}, querySelector(selector) {
    if ( !elements.has(selector) ) elements.set(selector, {value: "", hidden: false, disabled: false, innerHTML: "", textContent: "",
      listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; }});
    return elements.get(selector);
  }};
  form.querySelector('select[name="method"]').value = "roll";
  const clicks = [];
  globalThis.foundry.applications = {api: {DialogV2: {wait: async config => {
    config.render(null, {element: {querySelector: () => form}});
    const button = form.querySelector("[data-roll]");
    for ( let click = 0; click < 2; click++ ) {
      await button.listeners.click();
      clicks.push([asked.length, button.disabled, form.querySelector("[data-hint]").textContent]);
    }
    return null;
  }}}};
  try {
    assert.equal(await chooseAbilityScores({name: "Ana", update: async () => {}}), false);
  } finally {
    delete globalThis.foundry.applications;
  }
  assert.deepEqual(clicks, [[3, false, 'WILDPATH.ABILITYSCORES.Rolled:{"values":"15, 14"}'],
    [7, true, 'WILDPATH.ABILITYSCORES.Rolled:{"values":"15, 14, 13, 12, 10, 9"}']]);
});
