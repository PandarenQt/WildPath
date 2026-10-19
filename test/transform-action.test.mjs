import {test} from "node:test";
import assert from "node:assert/strict";
import {validateActionDefinition} from "../module/helpers/action-definitions.mjs";
import {resolveActionConfiguration} from "../module/helpers/action-configuration.mjs";
import {applyActionTransformation} from "../module/resolvers/foundry-multiplayer-runtime.mjs";

const WILD_SHAPE = {schemaVersion: 1, id: "action:wild-shape", label: "Wild Shape", costs: {allOf: []}, transform: {choiceId: "form"},
  configuration: [{id: "form", type: "select-one", label: "Form", required: true,
    options: [{id: "Actor.bear", label: "Bear"}, {id: "Actor.wolf", label: "Wolf"}]}]};

test("a transform names exactly one of a fixed form, a configuration choice, or revert", () => {
  const definition = transform => ({schemaVersion: 1, id: "action:t", label: "T", costs: {allOf: []}, transform});
  assert.equal(validateActionDefinition(WILD_SHAPE).ok, true);
  assert.equal(validateActionDefinition(definition({formRef: "Actor.bear"})).ok, true);
  assert.equal(validateActionDefinition(definition({revert: true})).ok, true);
  assert.equal(validateActionDefinition(definition({formRef: "Actor.bear", revert: true})).ok, false);
  assert.equal(validateActionDefinition(definition({})).ok, false);
});

/** A creature that records what it is turned into. */
function shifter() {
  return {calls: [], async transform(form, policy) { this.calls.push(["transform", form.name, policy]); },
    async revertTransformation() { this.calls.push(["revert"]); }};
}
const forms = {"Actor.bear": {name: "Bear"}, "Actor.wolf": {name: "Wolf"}};

test("Wild Shape turns its creature into the form the Player chose, after the Action completes", async () => {
  const actor = shifter();
  const {configuration} = resolveActionConfiguration({actionDefinition: WILD_SHAPE, responses: {form: "Actor.wolf"}});
  await applyActionTransformation({options: {actor}, state: {actionDefinition: WILD_SHAPE, configuration}},
    {fromUuid: async uuid => forms[uuid] ?? null});
  assert.deepEqual(actor.calls, [["transform", "Wolf", {}]]);
});

test("a fixed form keeps its policy, a revert Action returns the creature, and an unknown form changes nothing", async () => {
  const actor = shifter();
  const fixed = {transform: {formRef: "Actor.bear", keepItemTypes: ["feature"]}};
  await applyActionTransformation({options: {actor}, state: {actionDefinition: fixed}}, {fromUuid: async uuid => forms[uuid] ?? null});
  await applyActionTransformation({options: {actor}, state: {actionDefinition: {transform: {revert: true}}}});
  await applyActionTransformation({options: {actor}, state: {actionDefinition: {transform: {formRef: "Actor.none"}}}},
    {fromUuid: async () => null, logger: {warn() {}}});
  assert.deepEqual(actor.calls, [["transform", "Bear", {keepItemTypes: ["feature"]}], ["revert"]]);
});

test("Polymorph turns each creature that failed its save into the Beast chosen, with the Beast's Hit Points as Temporary", async () => {
  const definition = {...WILD_SHAPE, transform: {choiceId: "form", targets: true, keepItemTypes: [], temporaryHealth: "form", concentration: true}};
  const {configuration} = resolveActionConfiguration({actionDefinition: definition, responses: {form: "Actor.bear"}});
  const creature = (level, threat) => ({...shifter(), system: {details: {level, threat}}});
  const [failed, saved, mightier] = [creature(5), creature(5), creature(undefined, 0)];
  const tokens = new Map([["failed", {actor: failed}], ["saved", {actor: saved}], ["weak", {actor: mightier}]]);
  const caster = {id: "caster", parent: {tokens}};
  const bear = {name: "Bear", system: {details: {threat: 1}, resources: {health: {max: 34}}}};
  const results = [{ok: true, success: false, target: {tokenId: "failed"}}, {ok: true, success: true, target: {tokenId: "saved"}},
    {ok: true, success: false, target: {tokenId: "weak"}}];
  await applyActionTransformation({options: {actor: shifter()}, state: {actionDefinition: definition, configuration,
    source: {tokenRef: "Scene.s.Token.caster"}, results: {saveResolution: {results}}}},
  {fromUuid: async uuid => (uuid === "Actor.bear" ? bear : (uuid === "Scene.s.Token.caster" ? caster : null)), logger: {warn() {}}});
  assert.deepEqual(failed.calls, [["transform", "Bear", {keepItemTypes: [], temporaryHealth: 34, untilTemporaryHealthLost: true,
    concentrationRef: "token:caster"}]]);
  assert.deepEqual(saved.calls, [], "a save keeps its shape");
  assert.deepEqual(mightier.calls, [], "a Bear (CR 1) is beyond a CR 0 creature");
});

test("a countered spell wastes the Action that cast it, never its slot, and says what stopped it", async () => {
  const {afterCountered} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const updates = [];
  const actor = {name: "Caster", system: {resources: {action: {max: 1, spent: 0}, bonus: {max: 1, spent: 0}}},
    update: async data => updates.push(data)};
  const posted = [];
  globalThis.ChatMessage = {create: async data => posted.push(data)};
  const state = {warnings: [{code: "COUNTERED", reason: "Counterspell stopped it."}],
    actionDefinition: {label: "Fireball", costs: {allOf: [{capability: "action", amount: 1}, {capability: "spell-slot.3", amount: 1}]}}};
  assert.deepEqual(await afterCountered({options: {actor, action: {name: "Fireball"}}, state}, {game: {}}), {"system.resources.action.spent": 1});
  assert.deepEqual(updates, [{"system.resources.action.spent": 1}], "the Action, not the slot");
  assert.match(posted[0].content, /Fireball: Counterspell stopped it\./);
  assert.equal(await afterCountered({options: {actor}, state: {warnings: [{code: "CANCELLED"}]}}, {game: {}}), null, "only a counter");
  delete globalThis.ChatMessage;
});

test("an Action that ends effects (Dispel Magic, Remove Curse) ends them on its targets once it completes", async () => {
  const {endEffectsOnTargets} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const effect = (id, metadata) => ({id, name: id, flags: {wildpath: {conditionEffect: {metadata}}}});
  const deleted = [];
  const actor = {uuid: "Actor.orc", effects: [effect("bless", {spellLevel: 1}), effect("haste", {spellLevel: 3}), effect("fly", {spellLevel: 4}),
    effect("curse", {spellLevel: 3, tags: ["curse"]}), effect("prone", {})], deleteEmbeddedDocuments: async (type, ids) => deleted.push(...ids)};
  const scene = {tokens: {get: id => (id === "orc" ? {actor} : null)}};
  const posted = [];
  globalThis.ChatMessage = {create: async data => posted.push(data)};
  const state = (ends, castingLevel=3) => ({actionDefinition: {ends}, configuration: {castingLevel}, source: {tokenRef: "Scene.s.Token.caster"},
    targets: [{tokenId: "orc"}]});
  const fromUuid = async () => ({parent: scene});
  await endEffectsOnTargets({state: state({spells: "slot"})}, {fromUuid, game: {}});
  assert.deepEqual(deleted, ["bless", "haste", "curse"], "spells up to the slot's level; a spell's curse is a spell too");
  assert.match(posted[0].content, /fly \(4\)/, "above it: named for the caster's check");
  deleted.length = 0;
  await endEffectsOnTargets({state: state({tags: ["curse"]})}, {fromUuid, game: {}});
  assert.deepEqual(deleted, ["curse"], "Remove Curse: only curses");
  delete globalThis.ChatMessage;
});

test("Indomitable: a fighter's own failed save may be rerolled with its fighter level, from its pool", async () => {
  const {withIndomitable} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const fighter = {uuid: "Actor.fighter", name: "Fighter"};
  const system = uses => ({resources: {}, pools: [{id: "indomitable", value: uses, max: 1}], classes: [{id: "fighter", level: 9}]});
  const alone = withIndomitable(null, fighter, system(1), {});
  assert.deepEqual([alone.own, alone.options.map(option => [option.value, option.bonus])], [true, [["indomitable:Actor.fighter", 9]]]);
  const inspired = {own: true, chooser: "target-controller", label: "x", options: [{value: "spend:Actor.fighter"}]};
  assert.deepEqual(withIndomitable(inspired, fighter, system(1), {}).options.map(option => option.value),
    ["spend:Actor.fighter", "indomitable:Actor.fighter"], "beside Heroic Inspiration");
  assert.equal(withIndomitable(null, fighter, system(0), {}), null, "none left");
  const monster = {own: false, options: []};
  assert.equal(withIndomitable(monster, fighter, system(1), {}), monster, "never on a monster's GM-chosen reroll");
});

test("a die an effect lets its creature add (Bardic Inspiration) is offered at its giver's size", async () => {
  const {withAddedDice} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const bard = {documentName: "Actor", system: {classes: [{id: "bard", level: 5}]}};
  globalThis.fromUuidSync = uuid => (uuid === "Actor.bard.Item.inspire" ? {documentName: "Item", parent: bard, actor: bard} : null);
  const inspired = {id: "inspired", name: "Inspired", flags: {wildpath: {conditionEffect: {conditionId: "custom:action:bardic:effect-1",
    sourceRef: "uuid:Actor.bard.Item.inspire", metadata: {addDie: {faces: {type: "table", key: {type: "class-level", class: "bard"},
      rows: {1: 6, 5: 8, 10: 10, 15: 12}}}}}}}};
  const offer = withAddedDice(null, {name: "Fighter", effects: [inspired]}, {}, {chooser: "target-controller", target: {id: "fighter"}});
  assert.deepEqual(offer.options.map(option => [option.value, option.addDice.faces, option.payment.conditionId]),
    [["add:inspired", 8, "custom:action:bardic:effect-1"]], "a 5th-level bard's d8");
  assert.equal(withAddedDice(null, {name: "Fighter", effects: []}, {}, {}), null);
  delete globalThis.fromUuidSync;
});
