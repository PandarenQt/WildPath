import {test} from "node:test";
import assert from "node:assert/strict";
import {repeatDamageDefinition, repeatSaveDefinition, repeatSaveGroups} from "../module/adapters/foundry-v14-automation-dispatcher.mjs";
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
  // What the repeated save is against: the conditions it would end.
  assert.deepEqual(repeatSaveGroups([effect("p", "action:sting", "s", held, {statuses: new Set(["poisoned"])}),
    effect("m", "action:sting", "s", held)], "turn.ended")[0].against, ["poisoned"]);
});

test("a save repeated as its creature takes damage (Dominate Person) answers damage.taken, tagged repeat:damaged", () => {
  const save = {ability: "wits", dc: 15, tags: ["spell"]};
  const effects = [effect("charmed", "action:dominate", "s", {...save, onDamage: true}),
    effect("laughing", "action:laughter", "s", {...save, timing: "turnEnd", onDamage: true}),
    effect("held", "action:hold", "s", {...save, timing: "turnEnd"})];
  assert.deepEqual(repeatSaveGroups(effects, "damage.taken").map(group => [group.effectIds, group.tags]),
    [[["charmed"], ["spell", "repeat:damaged"]], [["laughing"], ["spell", "repeat:damaged"]]]);
  assert.deepEqual(repeatSaveGroups(effects, "turn.ended").map(group => [group.effectIds, group.tags]),
    [[["laughing"], ["spell"]], [["held"], ["spell"]]], "a damage-only repeat waits for no turn");

  const dominate = {schemaVersion: 1, id: "action:dominate", label: "Dominate Person", costs: {allOf: []},
    targeting: {type: "single", required: true, count: 1}, save: {ability: "wits", dc: {value: 15}},
    effects: [{id: "effect-1", type: "condition", conditionId: "charmed", saveOutcomePolicy: "failure", repeatOnDamage: true}]};
  assert.equal(validateActionDefinition(dominate).ok, true);
  const plan = planStagedActionResolution({id: "resolution:dominate", actorSystem: {resources: {action: {value: 1, max: 1}}, pools: []},
    action: {id: dominate.id, type: "action", name: dominate.label, system: {definition: dominate}}, source: {actorId: "actor-source"},
    targets: [{id: "orc", actorId: "actor-orc", tokenId: "token-orc", disposition: "enemy"}]});
  const request = plan.state.pendingRequests[0];
  const done = resumeStagedActionResolution({state: plan.state, response: {resolutionId: plan.state.id, requestId: request.id,
    type: RESOLUTION_REQUEST_TYPES.ROLL, value: {requestId: request.payload.rollRequest.id, resolutionId: plan.state.id,
      type: request.payload.rollRequest.type, natural: 3, total: 3}}});
  assert.deepEqual(done.state.mutationPlans.find(entry => entry.type === "conditionEffect")?.metadata?.repeatSave,
    {onDamage: true, ability: "wits", dc: 15});
});

test("an effect whose save repeats keeps the save it was let in by: its ability and the DC it resolved to", () => {
  const hold = {schemaVersion: 1, id: "action:hold", label: "Hold Person", costs: {allOf: []}, tags: ["spell", "school:enchantment"],
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
  assert.deepEqual(condition?.metadata?.repeatSave, {timing: "turnEnd", ability: "wits", dc: 14, tags: ["spell", "school:enchantment"]},
    "its spell's tags too: the repeated save is still against a spell (Magic Resistance)");
  const [group] = repeatSaveGroups([{id: "p", name: "Hold Person", flags: {wildpath: {conditionEffect: {sourceRef: "s",
    metadata: {actionDefinitionId: hold.id, repeatSave: condition.metadata.repeatSave}}}}}], "turn.ended");
  assert.deepEqual(group.tags, ["spell", "school:enchantment"]);
});

test("a repeated save whose failure deals damage (repeatDamage): kept as it is applied, dealt only on a failed repeat", () => {
  const killer = {schemaVersion: 1, id: "action:killer", label: "Phantasmal Killer", costs: {allOf: []}, tags: ["spell"],
    targeting: {type: "single", required: true, count: 1}, save: {ability: "wits", dc: {value: 15}},
    damage: [{id: "damage-1", expression: {type: "dice", number: 4, faces: 10}, damageType: "psychic", saveOutcomePolicy: {success: "half", failure: "full"}}],
    effects: [{id: "effect-1", type: "effect", name: "Fears Manifested", ruleElements: [], saveOutcomePolicy: "failure", repeatSave: "turnEnd",
      repeatDamage: [{id: "damage-1", expression: {type: "dice", number: 4, faces: 10}, damageType: "psychic"}]}]};
  assert.equal(validateActionDefinition(killer).ok, true);
  const {repeatSave: _timing, ...unrepeated} = killer.effects[0];
  assert.deepEqual(validateActionDefinition({...killer, effects: [unrepeated]}).errors.map(entry => entry.path), ["effects.0.repeatDamage"],
    "repeatDamage needs a repeated save");
  assert.deepEqual(validateActionDefinition({...killer, effects: [{...unrepeated, repeatOnDamage: true}]}).errors.map(entry => entry.path),
    ["effects.0.repeatDamage"], "at a turn boundary: one its damage brought would bring itself again");
  const roll = (state, value) => {
    const request = state.pendingRequests[0];
    return resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: request.id, type: request.type,
      value: {requestId: request.payload.rollRequest.id, resolutionId: state.id, type: request.payload.rollRequest.type, ...value}}}).state;
  };
  const target = {id: "orc", actorId: "actor-orc", tokenId: "token-orc", disposition: "enemy"};
  const cast = planStagedActionResolution({id: "resolution:killer", actorSystem: {resources: {action: {value: 1, max: 1}}, pools: []},
    action: {id: killer.id, type: "action", name: killer.label, system: {definition: killer}}, source: {actorId: "actor-source"}, targets: [target]});
  let state = roll(cast.state, {natural: 3, total: 3});
  if ( state.pendingRequests.length ) state = roll(state, {total: 22});
  const applied = state.mutationPlans.find(entry => entry.type === "customEffect" || entry.type === "conditionEffect");
  assert.deepEqual(applied?.metadata?.repeatSave?.damage?.map(component => [component.id, component.expression, component.damageType]),
    [["damage-1", {type: "dice", number: 4, faces: 10}, "psychic"]], "the effect keeps what a failed repeat deals");

  const fears = {id: "fears", name: "Fears Manifested", flags: {wildpath: {conditionEffect: {sourceRef: "s",
    metadata: {actionDefinitionId: killer.id, repeatSave: {...applied.metadata.repeatSave, onDamage: true}}}}}};
  const [group] = repeatSaveGroups([fears], "turn.ended");
  // The save keeps its spell's tags (Magic Resistance); the damage, dealt after a failure as the saving creature's own
  // Action, has none, so that creature's own spell-damage rules (Empowered Evocation) don't add to what it takes.
  const save = repeatSaveDefinition(group);
  assert.equal(validateActionDefinition(save).ok, true);
  assert.deepEqual([save.tags, save.damage], [["spell"], undefined]);
  const damage = repeatDamageDefinition(group);
  assert.equal(validateActionDefinition(damage).ok, true);
  assert.deepEqual([damage.tags, damage.save, damage.damage.map(component => [component.id, component.saveOutcomePolicy])],
    [undefined, undefined, [["damage-1", undefined]]]);
  const plan = planStagedActionResolution({id: "resolution:repeat-damage", actorSystem: {resources: {}, pools: []},
    action: {id: damage.id, type: "action", name: damage.label, system: {definition: damage}}, source: {actorId: "actor-orc"}, targets: [target]});
  const dealt = roll(plan.state, {total: 18});
  assert.deepEqual(dealt.results.damageResolution.results.map(entry => [entry.target.id, entry.total]), [["orc", 18]], "a failure: the damage again");
  // A save its damage brought deals none: its damage would bring it again, and again on each failure.
  const [damaged] = repeatSaveGroups([fears], "damage.taken");
  assert.deepEqual([damaged.damage, repeatDamageDefinition(damaged)], [undefined, null]);
  // No damage of its own, none on the repeat (Hold Person).
  assert.equal(repeatDamageDefinition({...group, damage: undefined}), null);
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

test("Tactical Mind (a test offer): a failed check may add 1d10 from Second Wind, spent only when the check then succeeds", async () => {
  const {withTestOffers} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const fighter = level => ({pools: [{id: "second-wind", value: 2, max: 2}], classes: [{id: "fighter", level}], resources: {}});
  const tactical = {id: "tm", name: "Tactical Mind", system: {active: true}, flags: {wildpath: {testOffer: {tests: ["check"], refundOnFail: true,
    pool: "second-wind", faces: {type: "constant", value: 10}}}}};
  const roller = {uuid: "Actor.fighter", name: "Fighter", items: [tactical]};
  assert.equal(withTestOffers(null, {...roller, items: []}, fighter(1), null, "check"), null, "only with the feature");
  assert.equal(withTestOffers(null, roller, {...fighter(2), pools: [{id: "second-wind", value: 0, max: 2}]}, null, "check"), null, "a use left");
  const offer = withTestOffers(null, roller, fighter(2), null, "check");
  assert.deepEqual([offer.options[0].addDice, offer.options[0].refundOnFail, offer.rollerName], [{number: 1, faces: 10}, true, "Fighter"],
    "its roller named for the question with the roll's numbers");
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

test("Fanatical Focus (a test offer): a failed save rerolled with its Rage Damage bonus, only while raging and with its one use", async () => {
  const {withTestOffers} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const {convertItem} = await import("../scripts/content/dnd5e-to-wildpath.mjs");
  const [focus] = convertItem({_id: "fanaticalfocus00", name: "Fanatical Focus", type: "feat", effects: [], system: {
    source: {license: "CC-BY-4.0", rules: "2024", book: ""}, identifier: "fanatical-focus", activities: {}, description: {value: ""}}},
  {scales: {"barbarian.rage-damage": {1: 2, 9: 3, 16: 4}}}).items;
  const system = value => ({classes: [{id: "barbarian", level: 9}], resources: {}, pools: [{id: "fanatical-focus", value, max: 1}]});
  const roller = statuses => ({uuid: "Actor.barb", name: "Barbarian", statuses: new Set(statuses),
    items: [{id: focus._id, name: focus.name, flags: focus.flags, system: focus.system}]});
  const offer = withTestOffers(null, roller(["raging"]), system(1), null, "save");
  assert.deepEqual(offer.options.map(option => [option.value, option.bonus, option.plan?.ok]), [[`test-offer:${focus._id}`, 3, true]],
    "its Rage Damage at barbarian 9");
  assert.equal(withTestOffers(null, roller([]), system(1), null, "save"), null, "not raging");
  assert.equal(withTestOffers(null, roller(["raging"]), system(0), null, "save"), null, "used this Rage");
  assert.equal(withTestOffers(null, roller(["raging"]), system(1), null, "check"), null, "saves only");
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

test("beside a monster offer, an ally's Countercharm is asked only when the save failed", () => {
  const charm = {schemaVersion: 1, id: "action:charm", label: "Charm", costs: {allOf: []}, targeting: {type: "single", required: true, count: 1},
    save: {ability: "wits", dc: {value: 13}}, effects: [{id: "effect-1", type: "condition", conditionId: "charmed", saveOutcomePolicy: "failure"}]};
  const plan = {ok: true, updates: {}, payments: []};
  const bard = {kind: "specific", userIds: ["player-b"]};
  const offer = {own: false, chooser: "gm", label: "x", options: [
    {value: "spend:Actor.pc", payerRef: "Actor.pc", plan, label: "A player's Heroic Inspiration"},
    {value: "ally-offer:Actor.bard:cc", payerRef: "Actor.bard", plan, rollMode: "advantage", label: "Bard's Countercharm", authority: bard,
      failedOnly: true, offerLabel: "Ogre's save failed. Reroll it?"}]};
  const run = natural => {
    let state = planStagedActionResolution({id: `resolution:charm-monster-${natural}`, actorSystem: {resources: {action: {value: 1, max: 1}}, pools: []},
      action: {id: charm.id, type: "action", name: charm.label, system: {definition: charm}}, source: {actorId: "actor-source"},
      targets: [{id: "ogre", actorId: "actor-ogre", tokenId: "token-ogre", disposition: "friendly"}],
      save: {inspirationByTarget: {"token-ogre": offer}}}).state;
    const asked = [];
    const answer = value => {
      const request = state.pendingRequests[0];
      asked.push(request);
      state = resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: request.id, type: request.type,
        value: typeof value === "function" ? value(request) : value}}).state;
    };
    answer(request => ({requestId: request.payload.rollRequest.id, resolutionId: state.id, type: request.payload.rollRequest.type, natural, total: natural}));
    answer("keep");
    return {state, asked};
  };
  const saved = run(18);
  assert.deepEqual(saved.asked[1].payload.options.map(option => option.value), ["spend:Actor.pc", "keep"], "a success: the GM's question only");
  assert.equal(saved.state.pendingRequests.length, 0);
  const failed = run(4);
  assert.equal(failed.state.pendingRequests[0]?.payload?.options?.[0]?.value, "ally-offer:Actor.bard:cc", "a failure: then the bard's player");
  assert.deepEqual(failed.state.pendingRequests[0].authority, bard);
  assert.equal(failed.state.pendingRequests[0].payload.label, "Ogre's save failed. Reroll it?", "in its own words");
  assert.equal(failed.asked[1].payload.label, "x", "the GM's question keeps the monster offer's");
});

test("a foe's offer on saves: asked on a rolled success only, never an automatic one, and its bearer pays once in the stage", () => {
  const blast = {schemaVersion: 1, id: "action:blast", label: "Blast", costs: {allOf: []}, targeting: {type: "multiple", required: true, count: 2},
    save: {ability: "agility", dc: {value: 13}}};
  const plan = {ok: true, updates: {"system.pools.0.value": 0}, payments: []};
  const fate = {value: "foe-offer:Actor.seer:fate", payerRef: "Actor.seer", plan, name: "Boon of Fate", authority: {kind: "specific", userIds: ["player-b"]},
    succeededOnly: true, addDice: {number: 2, faces: 4, subtract: true}, offerLabel: "Its save succeeded. Change the result?", label: "Subtract 2d4"};
  // The same bearer's option paid from elsewhere (its Heroic Inspiration) is still asked after its pool is spent.
  const other = {...fate, value: "foe-offer:Actor.seer:hi", plan: {ok: true, updates: {"system.resources.inspiration.value": 0}, payments: []}};
  const offer = {own: true, chooser: "target-controller", label: "x", options: [fate, other]};
  const run = (id, outcomesByTarget=null) => {
    let state = planStagedActionResolution({id, actorSystem: {resources: {action: {value: 1, max: 1}}, pools: []},
      action: {id: blast.id, type: "action", name: blast.label, system: {definition: blast}}, source: {actorId: "actor-source"},
      targets: ["orc", "goblin"].map(name => ({id: name, actorId: `actor-${name}`, tokenId: `token-${name}`, disposition: "enemy"})),
      save: {inspirationByTarget: {"token-orc": offer, "token-goblin": offer}, ...(outcomesByTarget ? {outcomesByTarget} : {})}}).state;
    const asked = [];
    for ( let step = 0; state.pendingRequests.length && (step < 12); step += 1 ) {
      const request = state.pendingRequests[0];
      if ( request.type === RESOLUTION_REQUEST_TYPES.CHOICE ) asked.push(request);
      const total = (request.payload.rollKind === "save-added-die") ? 2 : 18;
      state = resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: request.id, type: request.type,
        value: (request.type === RESOLUTION_REQUEST_TYPES.CHOICE) ? fate.value
          : {requestId: request.payload.rollRequest.id, resolutionId: state.id, type: request.payload.rollRequest.type, natural: total, total}}}).state;
    }
    return {state, asked};
  };
  // Both succeed on 18; the bearer's one use was planned from one snapshot, so its pool is offered for the first only.
  const both = run("resolution:foe-saves");
  assert.deepEqual(both.asked.map(request => [request.authority.userIds, request.payload.label, request.payload.options.map(option => option.value)]),
    [[["player-b"], "Its save succeeded. Change the result?", [fate.value, other.value, "keep"]],
      [["player-b"], "Its save succeeded. Change the result?", [other.value, "keep"]]]);
  assert.equal(both.state.mutationPlans.filter(plan => plan.payerRef === "Actor.seer").length, 1, "paid once");
  assert.equal(both.state.results.saveResolution.successes.length, 2, "18 - 2 still saves");
  // A save it can't fail rolls nothing to take dice off.
  const automatic = run("resolution:foe-automatic", {"token-orc": "automatic-success", "token-goblin": "automatic-success"});
  assert.deepEqual([automatic.asked.length, automatic.state.results.saveResolution.successes.length], [0, 2]);
});

test("an ally's offer is its own controller's to decide, asked after the saver's own options are kept", () => {
  const charm = {schemaVersion: 1, id: "action:charm", label: "Charm", costs: {allOf: []}, targeting: {type: "single", required: true, count: 1},
    save: {ability: "wits", dc: {value: 13}}, effects: [{id: "effect-1", type: "condition", conditionId: "charmed", saveOutcomePolicy: "failure"}]};
  const plan = {ok: true, updates: {}, payments: []};
  const bard = {kind: "specific", userIds: ["player-b"]};
  const offer = {own: true, chooser: "target-controller", label: "x", options: [
    {value: "heroic", payerRef: "Actor.fighter", plan, label: "Heroic Inspiration"},
    {value: "ally-offer:Actor.bard:cc", payerRef: "Actor.bard", plan, rollMode: "advantage", label: "Bard's Countercharm", authority: bard}]};
  let state = planStagedActionResolution({id: "resolution:charm-ally", actorSystem: {resources: {action: {value: 1, max: 1}}, pools: []},
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
  const own = answer("keep");
  assert.deepEqual([own.chooser, own.payload.options.map(option => option.value)], ["target-controller", ["heroic", "keep"]],
    "the fighter's player is asked about its own Heroic Inspiration only");
  const ally = answer("ally-offer:Actor.bard:cc");
  assert.deepEqual([ally.authority, ally.payload.options.map(option => option.value)], [bard, ["ally-offer:Actor.bard:cc", "keep"]],
    "then the bard's player, about its Countercharm");
  answer(request => ({requestId: request.payload.rollRequest.id, resolutionId: state.id, type: request.payload.rollRequest.type, natural: 15, total: 15}));
  assert.equal(state.results.saveResolution.results[0].success, true);
  assert.ok(state.mutationPlans.some(entry => (entry.type === "resourcePayment") && (entry.payerRef === "Actor.bard")), "the bard pays");
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

test("an effect `appliesTo: \"source\"` lands on the Action's user, not its target (Resurrection's Spell Taxed)", async () => {
  const {resolveActionEffects} = await import("../module/resolvers/action-resolver.mjs");
  const {actionDefinitionToResolverInput} = await import("../module/helpers/action-definitions.mjs");
  const definition = {schemaVersion: 1, id: "action:taxing", label: "Taxing Cast", costs: {allOf: []}, targeting: {type: "single"},
    effects: [{id: "taxed", type: "effect", name: "Spell Taxed", appliesTo: "source", ruleElements: []}]};
  const effects = actionDefinitionToResolverInput(definition).effects;
  assert.equal(effects.conditions[0].appliesTo, "source", "the definition carries it to the resolver");
  const targetResolution = {targetContexts: [{target: {id: "dead", tokenId: "dead"}, selected: true}]};
  const resolved = resolveActionEffects({effects, targetResolution, actionContext: {source: {actorId: "caster", tokenId: "caster-token"}}});
  assert.deepEqual(resolved.mutationPlans.map(plan => plan.target), ["token:caster-token"]);
  assert.equal(resolveActionEffects({effects, targetResolution, actionContext: {source: null}}).ok, false, "no user: it fails, never a guess");
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

test("Heightened Focus' Step of the Wind: the monk Disengages and Dashes, the creature it picks is Carried unless it is Huge or bigger", async () => {
  const fs = await import("node:fs");
  const file = fs.readdirSync("packs/_source/srd-items").find(name => name.startsWith("heightened-focus-step-of-the-wind"));
  const definition = JSON.parse(fs.readFileSync(`packs/_source/srd-items/${file}`, "utf8")).system.definition;
  const square = x => ({type: "TokenGridFootprint", topology: "square", size: "medium", effectiveSize: "medium", anchor: {x, y: 0}, fields: [{x, y: 0}]});
  const effects = size => {
    const target = {id: "ally", actorId: "actor-ally", tokenId: "ally-token", disposition: "ally", size};
    const {state} = planStagedActionResolution({id: `resolution:carry-${size}`, actorSystem: {resources: {bonus: {value: 1, max: 1}},
      pools: [{id: "monk-s-focus", value: 2, max: 2}]}, action: {id: definition.id, type: "action", name: "Step", system: {definition}},
      source: {actorId: "monk", tokenId: "monk-token"}, targets: [target], targeting: {candidates: [{id: "ally", target, size}]},
      // Side by side, within its 5-foot reach.
      context: {spatial: {gridDistance: 5, sourceFootprint: square(0), targetFootprints: [{target, footprint: square(1)}]}}});
    return state.mutationPlans.filter(plan => plan.type === "conditionEffect").map(plan => [plan.conditionId, String(plan.target?.target?.tokenId ?? plan.target)]).sort();
  };
  assert.deepEqual(effects("medium"), [["carried", "ally-token"], ["dashing", "token:monk-token"], ["disengaged", "token:monk-token"]]);
  assert.deepEqual(effects("huge"), [["dashing", "token:monk-token"], ["disengaged", "token:monk-token"]],
    "a Huge creature is too big to carry; the monk still Disengages and Dashes");
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

test("Heightened Spell: its caster picks one target, which saves with Disadvantage; Careful: the picked ones succeed and take nothing", () => {
  const base = {schemaVersion: 1, id: "action:burst", label: "Burst", tags: ["spell"], costs: {allOf: []},
    targeting: {type: "multiple", required: true, count: 2}, damage: [{id: "fire", expression: {type: "constant", value: 8}, damageType: "fire",
      saveOutcomePolicy: {success: "half", failure: "full"}}]};
  const targets = [{id: "ally", actorId: "actor-ally", tokenId: "tok-ally", disposition: "friendly", name: "Ally"},
    {id: "foe", actorId: "actor-foe", tokenId: "tok-foe", disposition: "enemy", name: "Foe"}];
  const actors = Object.fromEntries(targets.flatMap(target => {
    const actor = {id: target.actorId, uuid: `Actor.${target.actorId}`, system: {resources: {health: {value: 20, max: 20}}}};
    return [[target.actorId, actor], [actor.uuid, actor], [`actor:${target.actorId}`, actor], [target.id, actor], [target.tokenId, actor],
      [`token:${target.tokenId}`, actor]];
  }));
  const plan = save => planStagedActionResolution({id: `resolution:${Object.keys(save).join("-")}`, actorSystem: {resources: {action: {value: 1, max: 1}}, pools: []},
    action: {id: base.id, type: "action", name: "Burst", system: {definition: {...base, save: {ability: "agility", dc: {value: 15}, ...save}}}},
    source: {actorId: "caster", disposition: "friendly"}, targets, durability: true, targetActors: actors}).state;
  const answer = (state, value) => resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: state.pendingRequests[0].id,
    type: state.pendingRequests[0].type, value}, services: {targetActors: actors}}).state;
  // Heightened: asked which; the foe's save then rolls with Disadvantage.
  let state = plan({heightened: true});
  assert.equal(state.pendingRequests[0].payload.id, "heightened");
  state = answer(state, "tok-foe");
  const modes = Object.fromEntries(state.pendingRequests.map(request => [request.payload.rollRequest?.source?.tokenId ?? request.payload.rollRequest?.target?.tokenId,
    request.payload.rollRequest?.rollMode]));
  assert.equal(Object.values(modes).filter(mode => mode === "disadvantage").length, 1, JSON.stringify(modes));
  // Careful: asked with its ally ticked; the ally then succeeds without rolling and takes no damage.
  state = plan({careful: 1});
  assert.deepEqual([state.pendingRequests[0].payload.id, state.pendingRequests[0].payload.defaultValue, state.pendingRequests[0].payload.max],
    ["careful", ["tok-ally"], 1]);
  state = answer(state, ["tok-ally"]);
  assert.equal(state.pendingRequests.length, 1, "only the foe rolls");
  const roll = state.pendingRequests[0].payload.rollRequest;
  state = answer(state, {requestId: roll.id, resolutionId: state.id, type: roll.type, natural: 2, total: 2});
  const damage = Object.fromEntries(state.mutationPlans.filter(entry => entry.type === "durabilityDamage")
    .map(entry => [entry.target.tokenId, entry.plan.amount]));
  assert.deepEqual(damage, {"tok-ally": 0, "tok-foe": 8}, "the ally succeeds and takes nothing; the foe fails");
});

test("zeroHpFor (Death Ward): a ward on an effect drops its creature to 1 instead, naming the effect that then ends", async () => {
  const {zeroHpFor} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const ward = {uuid: "Actor.x.ActiveEffect.ward", name: "Protection from Death", disabled: false, system: {ruleElements: [{type: "Trigger",
    data: {kind: "zero-hp", event: "health.zero", zeroHp: {mode: "set", hitPoints: 1}}}]}};
  const actor = {items: [], effects: [ward]};
  assert.deepEqual(zeroHpFor(actor, {pools: []}), {name: "Protection from Death", mode: "set", hitPoints: 1, effectUuid: ward.uuid});
  assert.equal(zeroHpFor({items: [], effects: [{...ward, disabled: true}]}, {pools: []}), null, "a disabled one does nothing");
});

test("Failure by 5 or More (a Homunculus's Bite): its condition lands only on a save failed by that much", () => {
  const bite = {schemaVersion: 1, id: "action:bite", label: "Bite", costs: {allOf: []}, targeting: {type: "single", required: true, count: 1},
    save: {ability: "fortitude", dc: {value: 12}}, effects: [
      {id: "effect-1", type: "condition", conditionId: "poisoned", saveOutcomePolicy: "failure"},
      {id: "effect-2", type: "condition", conditionId: "unconscious", saveOutcomePolicy: {failedBy: 5}, metadata: {endsWhen: "damaged"}}]};
  assert.equal(validateActionDefinition(bite).ok, true);
  const conditionsAfter = total => {
    let state = planStagedActionResolution({id: `resolution:bite-${total}`, actorSystem: {resources: {action: {value: 1, max: 1}}, pools: []},
      action: {id: bite.id, type: "action", name: bite.label, system: {definition: bite}}, source: {actorId: "actor-source"},
      targets: [{id: "fighter", actorId: "actor-fighter", tokenId: "token-fighter", disposition: "enemy"}]}).state;
    const request = state.pendingRequests[0];
    state = resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: request.id, type: request.type,
      value: {requestId: request.payload.rollRequest.id, resolutionId: state.id, type: request.payload.rollRequest.type, natural: total, total}}}).state;
    return state.mutationPlans.map(entry => entry.conditionId).filter(Boolean).sort();
  };
  assert.deepEqual(conditionsAfter(7), ["poisoned", "unconscious"], "7 against DC 12 fails by 5");
  assert.deepEqual(conditionsAfter(8), ["poisoned"], "8 fails by 4");
  assert.deepEqual(conditionsAfter(12), [], "a success");
});

test("an effect that ends when its creature is attacked remembers the resolution that applied it", () => {
  const strike = {schemaVersion: 1, id: "action:stun", label: "Stunning Strike", costs: {allOf: []}, targeting: {type: "single", required: true, count: 1},
    save: {ability: "fortitude", dc: {value: 12}}, effects: [{id: "effect-1", type: "effect", name: "Off Balance", saveOutcomePolicy: "success",
      endsWhen: "attacked", ruleElements: [{schemaVersion: 1, id: "off-balance", type: "RollMode", data: {domains: ["attacked"], mode: "advantage"}}]}]};
  assert.equal(validateActionDefinition(strike).ok, true);
  let state = planStagedActionResolution({id: "resolution:child", ancestry: [{id: "resolution:attack"}], actorSystem: {resources: {}, pools: []},
    action: {id: strike.id, type: "action", name: strike.label, system: {definition: strike}}, source: {actorId: "actor-source"},
    targets: [{id: "fighter", actorId: "actor-fighter", tokenId: "token-fighter", disposition: "enemy"}]}).state;
  const request = state.pendingRequests[0];
  state = resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: request.id, type: request.type,
    value: {requestId: request.payload.rollRequest.id, resolutionId: state.id, type: request.payload.rollRequest.type, natural: 15, total: 15}}}).state;
  const plan = state.mutationPlans.find(entry => JSON.stringify(entry).includes("attacked"));
  assert.ok(plan, JSON.stringify(state.mutationPlans).slice(0, 400));
  assert.match(JSON.stringify(plan), /"resolutionIds":\["resolution:child"/u);
});

test("Boon of Combat Prowess (SRD): a missed attack, even a natural 1, hits instead, not as a critical hit, for its use", async () => {
  const fs = await import("node:fs");
  const {withTestOffers} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const item = JSON.parse(fs.readFileSync("packs/_source/srd-items/boon-of-combat-prowess-phbBoonofCombatP.json", "utf8"));
  const system = {resources: {}, pools: [{id: "boon-of-combat-prowess", value: 1, max: 1}]};
  const offer = withTestOffers(null, {uuid: "Actor.fighter", name: "Fighter", items: [{id: item._id, name: item.name, flags: item.flags,
    system: item.system}]}, system, null, "attack");
  assert.equal(offer.options[0].forceHit, true);
  assert.equal(withTestOffers(null, {uuid: "Actor.fighter", items: [{id: item._id, flags: item.flags, system: item.system}]},
    {resources: {}, pools: [{id: "boon-of-combat-prowess", value: 0, max: 1}]}, null, "attack"), null, "used this turn");
  const definition = {schemaVersion: 1, id: "action:stab", label: "Stab", costs: {allOf: []}, targeting: {type: "single", required: true, count: 1},
    attack: {type: "melee", statistic: "weapon", defenseKey: "ac"}};
  const run = die => {
    let state = planStagedActionResolution({id: `resolution:aim-${die}`, actorSystem: system, action: {id: definition.id, type: "action",
      name: definition.label, system: {definition}}, source: {actorId: "actor-fighter"},
      targeting: {required: true, candidates: [{id: "orc", target: {id: "orc", actorId: "actor-orc", tokenId: "token-orc", disposition: "enemy",
        defenses: {ac: {value: 15}}}, actor: {id: "actor-orc"}, disposition: "enemy", kind: "creature"}]},
      attack: {modifierTotal: 2, inspiration: offer}}).state;
    const answer = value => {
      const request = state.pendingRequests[0];
      state = resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: request.id, type: request.type,
        value: typeof value === "function" ? value(request) : value}}).state;
    };
    answer(request => ({requestId: request.payload.rollRequest.id, resolutionId: state.id, type: request.payload.rollRequest.type, die}));
    answer(offer.options[0].value);
    return state;
  };
  for ( const die of [8, 1] ) {
    const state = run(die);
    assert.equal(state.results.attackResolution.hits[0]?.outcome, "hit", `a ${die}: ${JSON.stringify(state.errors ?? []).slice(0, 300)}`);
    assert.ok(state.mutationPlans.some(plan => (plan.type === "resourcePayment") && (plan.payerRef === "Actor.fighter")), "its use is spent");
  }
});
