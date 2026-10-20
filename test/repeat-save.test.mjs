import {test} from "node:test";
import assert from "node:assert/strict";
import {repeatSaveGroups} from "../module/adapters/foundry-v14-automation-dispatcher.mjs";
import {validateActionDefinition} from "../module/helpers/action-definitions.mjs";
import {planStagedActionResolution, resumeStagedActionResolution} from "../module/resolvers/action-pipeline-resolver.mjs";
import {RESOLUTION_REQUEST_TYPES} from "../module/helpers/resolution-state.mjs";

const effect = (id, actionDefinitionId, sourceRef, repeatSave, extra={}) => ({id, name: "Hold Person", ...extra,
  flags: {wildpath: {conditionEffect: {sourceRef, metadata: {actionDefinitionId, ...(repeatSave ? {repeatSave} : {})}}}}});

test("the saves a creature repeats at a turn boundary: one per Action and source, ending all it let in", () => {
  const held = {timing: "turnEnd", ability: "wits", dc: 15};
  const groups = repeatSaveGroups([
    effect("paralyzed", "action:hold-person", "uuid:Actor.mage", held),
    effect("marker", "action:hold-person", "uuid:Actor.mage", held),
    effect("other-caster", "action:hold-person", "uuid:Actor.lich", {...held, dc: 18}),
    effect("start", "action:x", "uuid:Actor.mage", {...held, timing: "turnStart"}),
    effect("plain", "action:y", "uuid:Actor.mage", null),
    effect("off", "action:z", "uuid:Actor.mage", held, {disabled: true})], "turn.ended");
  assert.deepEqual(groups.map(group => [group.ability, group.dc, group.effectIds]),
    [["wits", 15, ["paralyzed", "marker"]], ["wits", 18, ["other-caster"]]]);
  assert.deepEqual(repeatSaveGroups([effect("start", "action:x", "s", {...held, timing: "turnStart"})], "turn.started")[0].effectIds, ["start"]);
  assert.deepEqual(repeatSaveGroups([effect("a", "b", "c", held)], "round.ended"), []);
});

test("an effect whose save repeats keeps the save it was let in by: its ability and the DC it resolved to", () => {
  const hold = {schemaVersion: 1, id: "action:hold", label: "Hold Person", costs: {allOf: []},
    targeting: {type: "single", required: true, count: 1}, save: {ability: "wits", dc: {value: 14}},
    effects: [{id: "effect-1", type: "condition", conditionId: "paralyzed", saveOutcomePolicy: "failure", repeatSave: "turnEnd"}]};
  assert.equal(validateActionDefinition(hold).ok, true);
  assert.equal(validateActionDefinition({...hold, effects: [{...hold.effects[0], repeatSave: "never"}]}).ok, false);
  const plan = planStagedActionResolution({id: "resolution:hold", actorSystem: {resources: {action: {value: 1, max: 1}}, pools: []},
    action: {id: hold.id, type: "action", name: hold.label, system: {definition: hold}}, source: {actorId: "actor-source"},
    targets: [{id: "orc", actorId: "actor-orc", tokenId: "token-orc", disposition: "enemy"}]});
  const request = plan.state.pendingRequests[0];
  const done = resumeStagedActionResolution({state: plan.state, response: {resolutionId: plan.state.id, requestId: request.id,
    type: RESOLUTION_REQUEST_TYPES.ROLL, value: {requestId: request.payload.rollRequest.id, resolutionId: plan.state.id,
      type: request.payload.rollRequest.type, natural: 3, total: 3}}});
  const condition = done.state.mutationPlans.find(entry => entry.type === "conditionEffect");
  assert.deepEqual(condition?.metadata?.repeatSave, {timing: "turnEnd", ability: "wits", dc: 14});
});

test("Bardic Inspiration: a failed save may add the die, which can turn it into a success, and ends the effect", async () => {
  const save = {schemaVersion: 1, id: "action:trip", label: "Trip", costs: {allOf: []}, targeting: {type: "single", required: true, count: 1},
    save: {ability: "might", dc: {value: 12}}, effects: [{id: "effect-1", type: "condition", conditionId: "prone", saveOutcomePolicy: "failure"}]};
  const ending = {type: "conditionEffect", conditionId: "custom:inspired", levels: -1, action: "delete", target: {id: "orc", tokenId: "token-orc"}};
  const offer = {own: true, chooser: "target-controller", label: "x",
    options: [{value: "add:inspired", addDice: {number: 1, faces: 8}, label: "Add Inspired (d8)", payment: ending}]};
  let state = planStagedActionResolution({id: "resolution:inspired", actorSystem: {resources: {action: {value: 1, max: 1}}, pools: []},
    action: {id: save.id, type: "action", name: save.label, system: {definition: save}}, source: {actorId: "actor-source"},
    targets: [{id: "orc", actorId: "actor-orc", tokenId: "token-orc", disposition: "enemy"}],
    save: {inspirationByTarget: {"token-orc": offer}}}).state;
  const answer = value => {
    const request = state.pendingRequests[0];
    state = resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: request.id, type: request.type,
      value: typeof value === "function" ? value(request) : value}}).state;
    return request;
  };
  answer(request => ({requestId: request.payload.rollRequest.id, resolutionId: state.id, type: request.payload.rollRequest.type, natural: 8, total: 8}));
  const choice = answer("add:inspired");
  assert.equal(choice.type, "choice");
  const die = answer(request => ({requestId: request.payload.rollRequest.id, resolutionId: state.id, type: request.payload.rollRequest.type, total: 5}));
  assert.equal(die.payload.rollRequest.formula, "1d8");
  assert.equal(state.results.saveResolution.results[0].success, true, "8 + 5 = 13 against DC 12");
  assert.ok(state.mutationPlans.some(plan => (plan.type === "conditionEffect") && (plan.conditionId === "custom:inspired")), "the effect ends");
  assert.equal(state.mutationPlans.some(plan => plan.conditionId === "prone"), false, "and no Prone");
});

test("Tactical Mind: a failed check may add 1d10 from Second Wind, spent only when the check then succeeds", async () => {
  const {withTacticalMind} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const fighter = level => ({pools: [{id: "second-wind", value: 2, max: 2}], classes: [{id: "fighter", level}], resources: {}});
  const roller = {uuid: "Actor.fighter", name: "Fighter"};
  assert.equal(withTacticalMind(null, roller, fighter(1), null), null, "fighter level 2");
  assert.equal(withTacticalMind(null, roller, {...fighter(2), pools: [{id: "second-wind", value: 0, max: 2}]}, null), null, "a use left");
  const offer = withTacticalMind(null, roller, fighter(2), null);
  assert.deepEqual([offer.options[0].addDice, offer.options[0].refundOnFail], [{number: 1, faces: 10}, true]);
  const definition = {schemaVersion: 1, id: "action:climb", label: "Climb", costs: {allOf: []}, targeting: {type: "self"},
    check: {skill: "athletics", ability: "might", dc: {value: 15}}};
  const run = die => {
    let state = planStagedActionResolution({id: `resolution:tactical-${die}`, actorSystem: fighter(2),
      action: {id: definition.id, type: "action", name: definition.label, system: {definition}}, source: {actorId: "actor-fighter"},
      check: {modifier: 2, inspiration: offer}}).state;
    const answer = value => {
      const request = state.pendingRequests[0];
      state = resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: request.id, type: request.type,
        value: typeof value === "function" ? value(request) : value}}).state;
    };
    answer(request => ({requestId: request.payload.rollRequest.id, resolutionId: state.id, type: request.payload.rollRequest.type, die: 8}));
    answer(offer.options[0].value);
    answer(request => ({requestId: request.payload.rollRequest.id, resolutionId: state.id, type: request.payload.rollRequest.type, total: die}));
    return state;
  };
  const succeeded = run(6);
  assert.equal(succeeded.results.checkResolution.success, true, "10 + 6 = 16 against DC 15");
  assert.ok(succeeded.mutationPlans.some(plan => (plan.type === "resourcePayment") && (plan.payerRef === "Actor.fighter")), "the use is spent");
  const failed = run(2);
  assert.equal(failed.results.checkResolution.success, false, "10 + 2 = 12");
  assert.equal(failed.mutationPlans.some(plan => plan.payerRef === "Actor.fighter"), false, "the use is kept");
});

test("test offers (SRD): Peerless Skill's Bardic Inspiration die on a check or attack, Dark One's Own Luck's d10 on a check or save", async () => {
  const fs = await import("node:fs");
  const {withTestOffers} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const feature = file => {
    const item = JSON.parse(fs.readFileSync(`packs/_source/srd-items/${file}.json`, "utf8"));
    return {id: item._id, name: item.name, flags: item.flags, system: item.system};
  };
  const system = {classes: [{id: "bard", level: 10}], resources: {},
    pools: [{id: "bardic-inspiration", value: 1, max: 4}, {id: "dark-one-s-own-luck", value: 0, max: 2}]};
  const roller = {uuid: "Actor.hero", name: "Hero", items: [feature("peerless-skill-phbbrdPeerlessSk"), feature("dark-one-s-own-luck-phbwlkDarkOnesOw")]};
  const offer = withTestOffers(null, roller, system, null, "attack");
  assert.deepEqual(offer.options.map(option => [option.addDice.faces, option.refundOnFail]), [[10, true]], "a d10 at bard 10; no luck left");
  assert.equal(withTestOffers(null, roller, system, null, "save"), null, "Peerless Skill is no save's");
  const lucky = withTestOffers(null, roller, {...system, pools: [{id: "dark-one-s-own-luck", value: 1, max: 2}]}, null, "save");
  assert.deepEqual(lucky.options.map(option => option.addDice.faces), [10]);
});

test("zeroHpFor (SRD Relentless Rage): while raging, DC 10 + 5 a use spent, 2x its barbarian level, a use paid", async () => {
  const fs = await import("node:fs");
  const {zeroHpFor} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const item = JSON.parse(fs.readFileSync("packs/_source/srd-items/relentless-rage-phbbrbRelentless.json", "utf8"));
  const barbarian = (statuses, value) => ({uuid: "Actor.barb", statuses: new Set(statuses),
    items: [{id: item._id, name: item.name, system: item.system}]});
  const system = value => ({classes: [{id: "barbarian", level: 11}], resources: {}, pools: [{id: "relentless-rage", value, max: 20}]});
  assert.equal(zeroHpFor(barbarian([], 20), system(20)), null, "not raging");
  const first = zeroHpFor(barbarian(["raging"]), system(20));
  assert.deepEqual([first.mode, first.dc, first.hitPoints, first.payment.payerRef], ["save", 10, 22, "Actor.barb"]);
  assert.equal(zeroHpFor(barbarian(["raging"]), system(18)).dc, 20, "two uses spent");
});

test("Stroke of Luck (SRD): a missed attack becomes a natural 20, a critical hit, for its use", async () => {
  const fs = await import("node:fs");
  const {withTestOffers} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const item = JSON.parse(fs.readFileSync("packs/_source/srd-items/stroke-of-luck-phbrgeStrokeOfLu.json", "utf8"));
  const system = {resources: {}, pools: [{id: "stroke-of-luck", value: 1, max: 1}]};
  const offer = withTestOffers(null, {uuid: "Actor.rogue", name: "Rogue", items: [{id: item._id, name: item.name, flags: item.flags,
    system: item.system}]}, system, null, "attack");
  assert.equal(offer.options[0].setNatural, 20);
  const definition = {schemaVersion: 1, id: "action:stab", label: "Stab", costs: {allOf: []}, targeting: {type: "single", required: true, count: 1},
    attack: {type: "melee", statistic: "weapon", defenseKey: "ac"}};
  let state = planStagedActionResolution({id: "resolution:luck", actorSystem: system, action: {id: definition.id, type: "action",
    name: definition.label, system: {definition}}, source: {actorId: "actor-rogue"},
    targeting: {required: true, candidates: [{id: "orc", target: {id: "orc", actorId: "actor-orc", tokenId: "token-orc", disposition: "enemy",
      defenses: {ac: {value: 15}}}, actor: {id: "actor-orc"}, disposition: "enemy", kind: "creature"}]},
    attack: {modifierTotal: 2, inspiration: offer}}).state;
  const answer = value => {
    const request = state.pendingRequests[0];
    state = resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: request.id, type: request.type,
      value: typeof value === "function" ? value(request) : value}}).state;
  };
  answer(request => ({requestId: request.payload.rollRequest.id, resolutionId: state.id, type: request.payload.rollRequest.type, die: 3}));
  answer(offer.options[0].value);
  assert.equal(state.results.attackResolution.hits[0]?.outcome, "criticalHit", JSON.stringify(state.errors ?? []).slice(0, 300));
  assert.ok(state.mutationPlans.some(plan => (plan.type === "resourcePayment") && (plan.payerRef === "Actor.rogue")), "its use is spent");
});

test("Countercharm: an ally's reroll of a failed save rolls with Advantage, and that ally pays", () => {
  const charm = {schemaVersion: 1, id: "action:charm", label: "Charm", costs: {allOf: []}, targeting: {type: "single", required: true, count: 1},
    save: {ability: "wits", dc: {value: 13}}, effects: [{id: "effect-1", type: "condition", conditionId: "charmed", saveOutcomePolicy: "failure"}]};
  const plan = {ok: true, updates: {"system.resources.reaction.value": 0}, payments: []};
  const offer = {own: true, chooser: "target-controller", label: "x",
    options: [{value: "ally-offer:Actor.bard:cc", payerRef: "Actor.bard", plan, rollMode: "advantage", label: "Bard's Countercharm"}]};
  let state = planStagedActionResolution({id: "resolution:charm", actorSystem: {resources: {action: {value: 1, max: 1}}, pools: []},
    action: {id: charm.id, type: "action", name: charm.label, system: {definition: charm}}, source: {actorId: "actor-source"},
    targets: [{id: "fighter", actorId: "actor-fighter", tokenId: "token-fighter", disposition: "enemy"}],
    save: {inspirationByTarget: {"token-fighter": offer}}}).state;
  const answer = value => {
    const request = state.pendingRequests[0];
    state = resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: request.id, type: request.type,
      value: typeof value === "function" ? value(request) : value}}).state;
    return request;
  };
  answer(request => ({requestId: request.payload.rollRequest.id, resolutionId: state.id, type: request.payload.rollRequest.type, natural: 4, total: 4}));
  answer("ally-offer:Actor.bard:cc");
  const reroll = answer(request => ({requestId: request.payload.rollRequest.id, resolutionId: state.id, type: request.payload.rollRequest.type,
    natural: 15, total: 15}));
  assert.equal(reroll.payload.rollRequest.rollMode, "advantage");
  assert.equal(state.results.saveResolution.results[0].success, true, "15 against DC 13");
  assert.ok(state.mutationPlans.some(entry => (entry.type === "resourcePayment") && (entry.payerRef === "Actor.bard")), "the bard pays");
  assert.equal(state.mutationPlans.some(entry => entry.conditionId === "charmed"), false);
});

test("rerolls a feature offers: Disciplined Survivor paid from its pool, Halfling Luck free and only on a natural 1", async () => {
  const {withTestOffers} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const roller = items => ({uuid: "Actor.hero", name: "Hero", items});
  const survivor = {id: "ds", name: "Disciplined Survivor", system: {active: true}, flags: {wildpath: {testOffer: {tests: ["save"], reroll: true,
    pool: "monk-s-focus"}}}};
  const luck = {id: "luck", name: "Luck", system: {active: true}, flags: {wildpath: {testOffer: {tests: ["check", "save", "attack"], reroll: true,
    natural: 1}}}};
  const system = focus => ({resources: {}, pools: [{id: "monk-s-focus", value: focus, max: 5}]});
  const paid = withTestOffers(null, roller([survivor]), system(2), {}, "save", {chooser: "target-controller"});
  assert.deepEqual(paid.options.map(option => [option.value, !!option.plan, option.natural]), [["test-offer:ds", true, undefined]]);
  assert.equal(withTestOffers(null, roller([survivor]), system(0), {}, "save", {}), null, "no Focus Point left");
  const free = withTestOffers(null, roller([luck]), system(0), {}, "attack", {chooser: "source-controller"});
  assert.deepEqual(free.options.map(option => [option.natural, option.plan ?? null]), [[1, null]]);

  const save = {schemaVersion: 1, id: "action:trip", label: "Trip", costs: {allOf: []}, targeting: {type: "single", required: true, count: 1},
    save: {ability: "might", dc: {value: 12}}, effects: [{id: "effect-1", type: "condition", conditionId: "prone", saveOutcomePolicy: "failure"}]};
  const offer = withTestOffers(null, roller([luck]), system(0), {}, "save", {chooser: "target-controller"});
  const run = natural => {
    let state = planStagedActionResolution({id: `resolution:luck-${natural}`, actorSystem: {resources: {action: {value: 1, max: 1}}, pools: []},
      action: {id: save.id, type: "action", name: save.label, system: {definition: save}}, source: {actorId: "actor-source"},
      targets: [{id: "hero", actorId: "actor-hero", tokenId: "token-hero", disposition: "enemy"}],
      save: {inspirationByTarget: {"token-hero": offer}}}).state;
    const request = state.pendingRequests[0];
    state = resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: request.id, type: request.type,
      value: {requestId: request.payload.rollRequest.id, resolutionId: state.id, type: request.payload.rollRequest.type, natural, total: natural}}}).state;
    return state;
  };
  assert.equal(run(1).pendingRequests[0]?.type, "choice", "a natural 1 offers Luck");
  const five = run(5);
  assert.deepEqual([five.pendingRequests.length, five.results.saveResolution.results[0].success], [0, false], "a failed 5 does not");
});

test("its creature's spell save DC bonus (Innate Sorcery's `dc.spell`) adds to the DC its Action resolves", () => {
  const charm = {schemaVersion: 1, id: "action:charm", label: "Charm", tags: ["spell"], costs: {allOf: []},
    targeting: {type: "single", required: true, count: 1}, save: {ability: "wits", dc: {value: 13}},
    effects: [{id: "effect-1", type: "condition", conditionId: "charmed", saveOutcomePolicy: "failure"}]};
  const state = planStagedActionResolution({id: "resolution:dc", actorSystem: {resources: {action: {value: 1, max: 1}}, pools: []},
    action: {id: charm.id, type: "action", name: charm.label, system: {definition: charm}}, source: {actorId: "actor-source"},
    targets: [{id: "hero", actorId: "actor-hero", tokenId: "token-hero", disposition: "enemy"}], save: {dcBonus: 1}}).state;
  assert.equal(state.pendingRequests[0].payload.rollRequest.dc?.value ?? state.pendingRequests[0].payload.rollRequest.dc, 14);
});

test("an effect with a maxSize skips a bigger creature (Eldritch Smite's Prone: Huge or smaller); Prone is the warlock's choice", async () => {
  const fs = await import("node:fs");
  const {resolveActionEffects} = await import("../module/resolvers/action-resolver.mjs");
  const prone = [{id: "effect-1", type: "condition", conditionId: "prone", maxSize: "huge"}];
  const targetsOf = size => ({targetContexts: [{target: {id: "t", tokenId: "t"}, size, selected: true}]});
  const planned = size => resolveActionEffects({effects: prone, targetResolution: targetsOf(size), actionContext: {source: {}}}).mutationPlans.length;
  assert.deepEqual([planned("huge"), planned("gargantuan"), planned(null)], [1, 0, 1]);
  const {createResolvedActionPreview} = await import("../module/helpers/action-configuration.mjs");
  const smite = JSON.parse(fs.readFileSync("packs/_source/srd-items/eldritch-smite-phbinvEldritchSm.json", "utf8")).system.definition;
  const actorSystem = {resources: {action: {value: 1, max: 1}, reaction: {value: 1, max: 1}},
    classes: [{id: "warlock", level: 5, spellcasting: {progression: "pact"}}], pools: [{id: "spell-slot.pact", value: 2, max: 2}]};
  const effects = choices => createResolvedActionPreview({definition: smite, actorSystem, choices: {"spell-slot": {resourceId: "spell-slot.pact"},
    ...choices}}).configuration.effectiveDefinition.effects.map(effect => effect.conditionId);
  assert.deepEqual([effects({prone: "prone"}), effects({prone: "standing"})], [["prone"], []], "Prone, or not: the warlock's choice");
});

test("a reroll's own mode is one more source: Advantage cancels one Disadvantage, not two", () => {
  const charm = {schemaVersion: 1, id: "action:charm", label: "Charm", costs: {allOf: []}, targeting: {type: "single", required: true, count: 1},
    save: {ability: "wits", dc: {value: 13}}, effects: [{id: "effect-1", type: "condition", conditionId: "charmed", saveOutcomePolicy: "failure"}]};
  const offer = {own: true, chooser: "target-controller", label: "x", options: [{value: "ally", payerRef: "Actor.bard",
    plan: {ok: true, updates: {}, payments: []}, rollMode: "advantage", label: "Countercharm"}]};
  const rerollMode = sources => {
    let state = planStagedActionResolution({id: `resolution:modes-${sources.length}`, actorSystem: {resources: {action: {value: 1, max: 1}}, pools: []},
      action: {id: charm.id, type: "action", name: charm.label, system: {definition: charm}}, source: {actorId: "actor-source"},
      targets: [{id: "fighter", actorId: "actor-fighter", tokenId: "token-fighter", disposition: "enemy"}],
      save: {inspirationByTarget: {"token-fighter": offer}, rollModesByTarget: {"token-fighter": "disadvantage"},
        rollModeSourcesByTarget: {"token-fighter": sources}}}).state;
    const answer = value => {
      const request = state.pendingRequests[0];
      state = resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: request.id, type: request.type,
        value: typeof value === "function" ? value(request) : value}}).state;
      return request;
    };
    answer(request => ({requestId: request.payload.rollRequest.id, resolutionId: state.id, type: request.payload.rollRequest.type, natural: 4, total: 4}));
    answer("ally");
    return state.pendingRequests[0].payload.rollRequest.rollMode;
  };
  assert.equal(rerollMode(["disadvantage"]), "normal");
  assert.equal(rerollMode(["disadvantage", "disadvantage"]), "disadvantage", "two sources of Disadvantage outweigh it");
});

test("an attack's or check's reroll keeps its own bonus and adds its mode as one more source", () => {
  const offer = {own: true, chooser: "source-controller", label: "x", options: [{value: "ally", payerRef: "Actor.bard",
    plan: {ok: true, updates: {}, payments: []}, rollMode: "advantage", bonus: 3, label: "Reroll"}]};
  const run = (definition, input) => {
    let state = planStagedActionResolution({id: `resolution:reroll-${definition.id}`, actorSystem: {resources: {action: {value: 1, max: 1}}, pools: []},
      action: {id: definition.id, type: "action", name: definition.label, system: {definition}}, source: {actorId: "actor-source"},
      targets: [{id: "foe", actorId: "actor-foe", tokenId: "token-foe", disposition: "enemy"}], ...input}).state;
    const answer = value => {
      const request = state.pendingRequests[0];
      state = resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: request.id, type: request.type,
        value: typeof value === "function" ? value(request) : value}}).state;
    };
    answer(request => ({requestId: request.payload.rollRequest.id, resolutionId: state.id, type: request.payload.rollRequest.type, natural: 2, total: 4}));
    answer("ally");
    const {rollMode, expected} = state.pendingRequests[0].payload.rollRequest;
    return [rollMode, expected.modifierTotal];
  };
  const base = {schemaVersion: 1, costs: {allOf: []}, targeting: {type: "single", required: true, count: 1}};
  const strike = {...base, id: "action:strike", label: "Strike", attack: {type: "melee", statistic: "weapon", defenseKey: "ac"}};
  assert.deepEqual(run(strike, {attack: {modifierTotal: 2, defense: 30, rollMode: "disadvantage", rollModeSources: ["disadvantage"], inspiration: offer}}),
    ["normal", 5], "the attack's reroll: +3, and its Advantage cancels the one Disadvantage");
  const shove = {...base, id: "action:test", label: "Test", check: {ability: "might", dc: {value: 25}}};
  assert.deepEqual(run(shove, {check: {modifierTotal: 2, dc: 25, rollMode: "disadvantage", rollModeSources: ["disadvantage", "disadvantage"],
    inspiration: offer}}), ["disadvantage", 5], "a check's: two sources of Disadvantage outweigh it");
});

test("an effect `whenDamaged` is only on a creature its Action damaged (a fall's Prone, unless it took no damage)", async () => {
  const {resolveActionEffects} = await import("../module/resolvers/action-resolver.mjs");
  const prone = [{id: "fall-prone", type: "condition", conditionId: "prone", whenDamaged: true}];
  const targetResolution = {targetContexts: [{target: {id: "t", tokenId: "tok"}, selected: true}]};
  const planned = damagedTargets => resolveActionEffects({effects: prone, targetResolution, actionContext: {source: {}}, damagedTargets})
    .mutationPlans.length;
  const wrapped = {targetContexts: [{target: {id: "token:s.tok", target: {id: "tok", tokenId: "tok"}, size: "medium"}, selected: true}]};
  assert.equal(resolveActionEffects({effects: prone, targetResolution: wrapped, actionContext: {source: {}}, damagedTargets: [{tokenId: "tok"}]})
    .mutationPlans.length, 1, "the runtime's candidate (its ref inside `target`) is matched by its Token");
  assert.deepEqual([planned([{tokenId: "tok"}]), planned([]), planned(null)], [1, 0, 1],
    "damaged: Prone; immune to it: standing; no damage information: as before");
});

test("through the pipeline: a fall's Prone only on a creature it damaged, Eldritch Smite's Prone only on one Huge or smaller", () => {
  const planned = ({amount=4, size=null, effect}) => {
    const definition = {schemaVersion: 1, id: "action:test-effects", label: "Test", costs: {allOf: []}, targeting: {type: "single", required: true, count: 1},
      damage: [{id: "hit", expression: {type: "constant", value: amount}, damageType: "bludgeoning"}], effects: [effect]};
    const target = {id: "t", actorId: "actor-t", tokenId: "tok", disposition: "enemy", ...(size ? {size} : {})};
    const actor = {id: "actor-t", uuid: "Actor.actor-t", system: {resources: {health: {value: 10, max: 10}}}};
    const {state} = planStagedActionResolution({id: `resolution:effects-${amount}-${size}`, actorSystem: {resources: {action: {value: 1, max: 1}}, pools: []},
      action: {id: definition.id, type: "action", name: "Test", system: {definition}}, source: {actorId: "a"}, targets: [target],
      // Its size comes with its footprint, as the runtime's targeting candidates carry it.
      ...(size ? {targeting: {candidates: [{id: "t", target, size}]}} : {}),
      durability: true, targetActors: {"actor-t": actor, "Actor.actor-t": actor, "actor:actor-t": actor}});
    return state.mutationPlans.some(plan => plan.type === "conditionEffect");
  };
  const fallProne = {id: "fall-prone", type: "condition", conditionId: "prone", whenDamaged: true};
  assert.deepEqual([planned({amount: 4, effect: fallProne}), planned({amount: 0, effect: fallProne})], [true, false]);
  const smiteProne = {id: "effect-1", type: "condition", conditionId: "prone", maxSize: "huge"};
  assert.deepEqual([planned({size: "huge", effect: smiteProne}), planned({size: "gargantuan", effect: smiteProne})], [true, false]);
});

test("Daze: once its creature moves, acts or takes a Bonus Action, the other two are capped at 0", async () => {
  const fs = await import("node:fs");
  const {resourceCapsFromRuleElements} = await import("../module/helpers/rule-elements.mjs");
  const daze = JSON.parse(fs.readFileSync("packs/_source/srd-items/devious-strikes-daze-phbrgeDeviousStr.json", "utf8"));
  const [effect] = daze.system.definition.effects;
  const caps = spent => resourceCapsFromRuleElements([{ruleElements: effect.ruleElements}], {actorSystem: {resources: {
    movement: {spent: spent.movement ?? 0}, action: {spent: spent.action ?? 0}, bonus: {spent: spent.bonus ?? 0}}}});
  assert.deepEqual(caps({}), {}, "nothing used yet: anything is open");
  assert.deepEqual(caps({movement: 5}), {action: 0, bonus: 0}, "it moved: no action or Bonus Action");
  assert.deepEqual(caps({action: 1}), {movement: 0, bonus: 0});
});

test("Knock Out ends when its creature takes damage, but not from the hit that knocked it out", async () => {
  const {endEffectsWhenDamaged} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const deleted = [];
  const out = {id: "out", flags: {wildpath: {conditionEffect: {metadata: {endsWhen: "damaged", resolutionIds: ["hit"]}}}}};
  const actor = {effects: [out, {id: "other", flags: {}}], deleteEmbeddedDocuments: async (_type, ids) => deleted.push(...ids)};
  const fromUuid = async () => ({actor});
  const state = id => ({id, mutationPlans: [{type: "durabilityDamage", target: {uuid: "Scene.s.Token.t"}, plan: {ok: true, amount: 6}}]});
  assert.deepEqual(await endEffectsWhenDamaged({state: state("hit")}, {fromUuid}), [], "the knocking-out hit's own damage");
  assert.deepEqual(await endEffectsWhenDamaged({state: state("later")}, {fromUuid}), ["out"], "any later damage wakes it");
  assert.deepEqual(deleted, ["out"]);
});
