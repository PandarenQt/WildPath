import {test} from "node:test";
import assert from "node:assert/strict";
import {diceTerms, rollFromTerms} from "./fixtures/foundry-dice-terms.mjs";

// Only the globals needed to import the real Actor class; no Foundry schema emulation.
globalThis.Actor = class {};
globalThis.foundry = {
  data: {fields: {}, ActiveEffectTypeDataModel: class {}},
  utils: {isEmpty: value => Object.keys(value).length === 0, randomID: () => "abc"},
  dice: {terms: diceTerms}
};
Math.clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const {default: WildPathActor} = await import("../module/documents/actor.mjs");
const {WILDPATH} = await import("../module/config.mjs");
const {answerRollLocally} = await import("../module/resolvers/multiplayer-action-coordinator.mjs");
const {createPhysicalDiceProvider} = await import("../module/resolvers/roll-provider-resolver.mjs");
const {createFoundryDigitalRollProvider} = await import("../module/adapters/foundry-digital-roll-provider.mjs");
const {createTestPromptAdapter} = await import("../module/adapters/test-prompt-adapter.mjs");
const {countedRollTotal} = await import("../module/helpers/rolls.mjs");

// A sheet roll answered as an Action's: the Foundry digital provider (its d20 shows 20) or the physical one, asking the prompt.
function sheetGame({policy, typed=[]}) {
  const asked = [];
  const posted = [];
  const notified = [];
  const prompt = createTestPromptAdapter({queue: typed});
  globalThis.CONFIG = {WILDPATH};
  globalThis.ChatMessage = {getSpeaker: () => ({})};
  globalThis.Roll = class Roll {
    static fromData(data) { return Object.assign(new Roll(data.formula), data); }
    static fromTerms(terms) { return rollFromTerms(Roll, terms); }
    constructor(formula) { this.formula = formula; }
    async evaluate() {
      const typed = Number(this.formula);
      this.dice = Number.isFinite(typed) ? [] : [{faces: 20, number: 1, results: [{result: 20, active: true}]}];
      this.total = Number.isFinite(typed) ? typed : 20 + 3;
      this.evaluated = true;
      return this;
    }
    toJSON() { return {formula: this.formula, total: this.total, evaluated: true, dice: this.dice}; }
    async toMessage(data) { posted.push({formula: this.formula, total: this.total, dice: this.dice, ...data}); }
  };
  const providers = [createFoundryDigitalRollProvider(), createPhysicalDiceProvider()];
  globalThis.game = {i18n: {localize: key => key, format: key => key}, wildpath: {requestRoll: (rollRequest, {title}={}) => {
    asked.push(rollRequest);
    return answerRollLocally({rollRequest, title, promptPorts: [prompt], rollProviders: providers,
      context: {providerId: policy === "physical" ? "physical-dice" : "foundry-digital"}, notify: event => notified.push(event)});
  }}};
  return {asked, posted, notified};
}

function hero(statistic={}) {
  const actor = Object.assign(Object.create(WildPathActor.prototype), {uuid: "Actor.hero", name: "Ana", effects: [], items: [],
    statuses: new Set(), flags: {}, system: {abilities: {fortitude: {value: 16}}}});
  actor.allApplicableEffects = () => [];
  actor.getRollModes = () => [];
  return Object.assign(actor, statistic);
}

test("a sheet roll with physical dice gives the typed natural d20 in a RollResult, as digital dice do", async () => {
  const physical = sheetGame({policy: "physical", typed: [{natural: 1}]});
  const result = await hero().rollTest({save: "fortitude"});
  assert.equal(result.natural, 1, "the natural 1 is kept, not lost in a typed total");
  assert.equal(result.total, 1 + 3, "the d20 plus the Fortitude save modifier");
  assert.equal(result.provenance.type, "physical");
  assert.equal(physical.asked[0].type, "saving-throw");
  assert.deepEqual([physical.posted[0].formula, physical.posted[0].total, physical.posted[0].dice?.[0]?.results],
    ["1d20 + 3", 4, [{result: 1, active: true}]], "the typed roll's card shows its entered d20 and its modifier");
  assert.equal(physical.posted[0].flags.wildpath.rollTest.save, "fortitude");

  const {posted} = sheetGame({policy: "digital"});
  const digital = await hero().rollTest({save: "fortitude"});
  assert.deepEqual([digital.natural, digital.total, digital.provenance.type], [20, 23, "foundry-digital"],
    "the digital provider gives the same RollResult shape");
  assert.deepEqual([posted[0].formula, posted[0].total], ["1d20 + 3", 23], "its card shows the dice as rolled");
});

test("a typed d20 under a floor (Reliable Talent) shows as a digital one does, so a Portent replaces it to the same total", async () => {
  const {createD20RollRequest} = await import("../module/helpers/rolls.mjs");
  const {requestShownRoll} = await import("../module/adapters/foundry-digital-roll-provider.mjs");
  const {replacedTotal} = await import("../module/adapters/foundry-v14-portent.mjs");
  sheetGame({policy: "physical", typed: [{natural: 3}]});
  const request = createD20RollRequest({id: "sheet:floor", resolutionId: "sheet", type: "skill-check", modifier: 5,
    expected: {naturalMinimum: 10}});
  const {result, roll} = await requestShownRoll(request);
  assert.equal(result.total, 15, "the 3 counts as 10, plus 5");
  assert.deepEqual([roll.formula, roll.total, roll.dice[0].results], ["1d20min10 + 5", 15,
    [{result: 3, active: true, count: 10, rerolled: true}]], "the die as rolled, counted as its floor, as Foundry's min leaves it");
  assert.equal(replacedTotal(roll, 2), 2 + 5, "the Portent die in the counted 10's place, as on a digital 1d20min10 + 5");
});

test("a sheet roll's floor (Indomitable Might) is on its RollResult; closing the prompt rolls nothing", async () => {
  const {posted} = sheetGame({policy: "physical", typed: [{natural: 2}]});
  const floored = await hero({getRollOutcomes: () => [{outcome: "minimum-score"}]}).rollTest({save: "fortitude"});
  assert.deepEqual([floored.total, floored.totalMinimum, countedRollTotal(floored)], [5, 16, 16],
    "rolled 2 + 3, counted as its Fortitude score");
  assert.equal(posted[0].flags.wildpath.rollTest.totalMinimum, 16, "its card keeps the floor for a later Portent");

  // A roll is a required request: its closed prompt comes back as REQUIRED_REQUEST_CANCELLED, which is no failure either.
  const closed = sheetGame({policy: "physical", typed: [{ok: false, status: "cancelled"}]});
  assert.equal(await hero().rollTest({ability: "fortitude"}), null, "closed unrolled");
  assert.deepEqual(closed.notified, [], "closing the prompt warns no one");
});

test("answerRollLocally asks again after a rejected physical roll, and counts a floored total", async () => {
  const {createD20RollRequest} = await import("../module/helpers/rolls.mjs");
  const rollRequest = createD20RollRequest({id: "sheet:roll", resolutionId: "sheet", type: "ability-check", modifier: 2,
    expected: {totalMinimum: 18}});
  const notified = [];
  const result = await answerRollLocally({rollRequest, promptPorts: [createTestPromptAdapter({queue: [{natural: 25}, {natural: 9}]})],
    rollProviders: [createPhysicalDiceProvider()], context: {providerId: "physical-dice"}, notify: event => notified.push(event)});
  assert.equal(result.natural, 9, "the second, valid die");
  assert.deepEqual(notified.map(event => event.error.code), ["INVALID_MANUAL_RESULT"], "the roller is told why");
  assert.deepEqual([result.total, countedRollTotal(result)], [11, 18], "the total as rolled, counted as its floor");
  assert.equal(countedRollTotal(null), null);

  // The last rejected entry ends the roll without telling the roller to enter it again.
  const told = [];
  const given = await answerRollLocally({rollRequest, promptPorts: [createTestPromptAdapter({queue: [{natural: 25}, {natural: 0}, {natural: 21}]})],
    rollProviders: [createPhysicalDiceProvider()], context: {providerId: "physical-dice"}, notify: event => told.push(event)});
  assert.equal(given, null, "three bad entries roll nothing");
  assert.equal(told.length, 2, "told to enter it again only before the second and third tries");
});
