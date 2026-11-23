import {test} from "node:test";
import assert from "node:assert/strict";
import {RESOLUTION_REQUEST_TYPES, RESOLUTION_STATE_STATUS} from "../module/helpers/resolution-state.mjs";
import {createActionResolutionState, planStagedActionResolution, resumeStagedActionResolution}
  from "../module/resolvers/action-pipeline-resolver.mjs";
import {evaluatePredicate} from "../module/helpers/predicates.mjs";
import {validateActionDefinition} from "../module/helpers/action-definitions.mjs";
import {projectPendingRequestPayloadForChooser, projectResolutionResultForDisclosure, sanitizeResolutionResultForTransport}
  from "../module/helpers/multiplayer-authority.mjs";
import {createResolutionCardViewModel} from "../module/helpers/chat-card-view-model.mjs";
import {createFoundryV14PromptAdapter} from "../module/adapters/foundry-v14-prompt-adapter.mjs";

// Magic Missile's shape: three darts, each a separate hit, sent at one creature or several (`targeting.repeatable`).
const darts = {schemaVersion: 1, id: "action:darts", label: "Darts", tags: ["spell"], costs: {allOf: []},
  targeting: {type: "multiple", required: true, count: 3, repeatable: true,
  refinementPolicy: {minSelections: 1}}, damage: [{id: "dart", expression: {type: "constant", value: 3}, damageType: "force"}]};
const action = {id: darts.id, type: "action", name: darts.label, system: {definition: darts}};
const target = id => ({id, actorId: `actor-${id}`, tokenId: `token-${id}`, disposition: "enemy"});
const candidate = id => ({id, target: target(id), actor: {id: `actor-${id}`}, disposition: "enemy", kind: "creature"});
const health = value => ({resources: {health: {value, max: value}}, pools: []});
const plan = (id, names, extra={}) => planStagedActionResolution({id, actorSystem: {resources: {action: {value: 1, max: 1}}, pools: []}, action,
  source: {actorId: "actor-caster", tokenId: "token-caster"}, targeting: {required: true, candidates: names.map(candidate)},
  durability: {targetSystems: Object.fromEntries(names.map(name => [`token-${name}`, health(30)]))}, ...extra});
const damagePlans = state => state.mutationPlans.filter(entry => entry.type === "durabilityDamage")
  .map(entry => [entry.target.tokenId, entry.plan.from, entry.plan.to]);

// Scorching Ray's shape: three rays at one creature or several, each its own attack roll and its own 2d6 on a hit.
const rays = {...darts, id: "action:rays", label: "Rays", attack: {type: "ranged", statistic: "spell", defenseKey: "ac"},
  damage: [{id: "ray", expression: {type: "dice", number: 2, faces: 6}, damageType: "fire"}]};
const rayAction = {id: rays.id, type: "action", name: rays.label, system: {definition: rays}};
const armored = id => ({...candidate(id), target: {...target(id), defenses: {ac: {value: 15}}}});
const planRays = (id, names, {attack={}, damage=null, definition=rays, durability={}}={}) => planStagedActionResolution({id,
  actorSystem: {resources: {action: {value: 1, max: 1}}, pools: []},
  action: (definition === rays) ? rayAction : {...rayAction, system: {definition}}, source: {actorId: "actor-caster", tokenId: "token-caster"},
  targeting: {required: true, candidates: names.map(armored)}, attack: {modifierTotal: 0, ...attack}, ...(damage ? {damage} : {}),
  durability: {targetSystems: Object.fromEntries(names.map(name => [`token-${name}`, health(30)])), ...durability}});
const answer = (state, suffix, value) => {
  const request = state.pendingRequests.find(entry => entry.id === `request:${state.id}:${suffix}`);
  assert.ok(request, `${suffix} is asked for (pending: ${state.pendingRequests.map(entry => entry.id)})`);
  const roll = request.payload.rollRequest;
  const resumed = resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: request.id,
    type: RESOLUTION_REQUEST_TYPES.ROLL, value: {requestId: roll.id, resolutionId: state.id, type: roll.type, ...value}}});
  assert.equal(resumed.ok, true, JSON.stringify(resumed.state.errors));
  return resumed.state;
};
const pendingIds = state => state.pendingRequests.map(entry => entry.id.replace(`request:${state.id}:`, ""));
const diceOf = (state, suffix) => state.pendingRequests.find(entry => entry.id === `request:${state.id}:${suffix}`)
  ?.payload.rollRequest.definition.dice.map(die => die.number);

test("every dart at the one creature targeted: three hits, each its own damage and its own concentration check", () => {
  const waiting = plan("resolution:darts-one", ["orc"], {concentration: {states: {"token-orc": {concentrating: true, actorId: "actor-orc",
    sourceRef: "token:token-orc"}}, dependents: []}});
  assert.deepEqual(waiting.state.results.damageResolution.results.map(result => [result.target.tokenId, result.total]),
    [["token-orc", 3], ["token-orc", 3], ["token-orc", 3]], "one target took all three darts, not one");
  assert.deepEqual(damagePlans(waiting.state), [["token-orc", 30, 27], ["token-orc", 27, 24], ["token-orc", 24, 21]],
    "each hit builds on the last");
  let state = waiting.state;
  for ( let check = 0; check < 3; check++ ) {
    const request = state.pendingRequests[0];
    assert.equal(request?.payload.rollKind, "concentration", `concentration check ${check + 1}`);
    const roll = request.payload.rollRequest;
    state = resumeStagedActionResolution({state, response: {resolutionId: state.id, requestId: request.id, type: RESOLUTION_REQUEST_TYPES.ROLL,
      value: {requestId: roll.id, resolutionId: state.id, type: roll.type, natural: 15, total: 15}}}).state;
  }
  assert.equal(state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, JSON.stringify(state.errors));
});

test("as many creatures as darts: one each, without asking", () => {
  const done = plan("resolution:darts-three", ["orc", "goblin", "kobold"]);
  assert.equal(done.state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, JSON.stringify(done.state.errors));
  assert.deepEqual(damagePlans(done.state), [["token-orc", 30, 27], ["token-goblin", 30, 27], ["token-kobold", 30, 27]]);
});

test("two creatures and three darts: its user shares them in the prompt, and only shares adding up to three resolve", async () => {
  const waiting = plan("resolution:darts-two", ["orc", "goblin"]);
  const request = waiting.state.pendingRequests[0];
  assert.equal(request.type, RESOLUTION_REQUEST_TYPES.TARGET_REFINEMENT, "how two creatures share three darts is asked");
  const chooser = projectPendingRequestPayloadForChooser(request.type, request.payload);
  assert.equal(chooser.targeting.refinementPolicy.instances, 3);
  assert.deepEqual(chooser.candidates.map(entry => [entry.id, entry.share]), [["orc", 2], ["goblin", 1]], "an even spread is offered first");

  let rendered = "";
  const prompt = createFoundryV14PromptAdapter({DialogV2: {input: async ({content}) => {
    rendered = content;
    return {"share:orc": 1, "share:goblin": 2};
  }}});
  const answer = await prompt.request({...request, payload: chooser}, {isGM: true});
  assert.equal((rendered.match(/type="number"/g) ?? []).length, 2, "a number for each creature, not a tick");
  assert.deepEqual(answer.value.decisions, [{operation: "select", targetId: "orc", count: 1},
    {operation: "select", targetId: "goblin", count: 2}]);
  const respond = value => resumeStagedActionResolution({state: waiting.state, response: {resolutionId: waiting.state.id,
    requestId: request.id, type: RESOLUTION_REQUEST_TYPES.TARGET_REFINEMENT, value}});
  const resumed = respond(answer.value);
  assert.equal(resumed.state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, JSON.stringify(resumed.state.errors));
  assert.deepEqual(damagePlans(resumed.state), [["token-orc", 30, 27], ["token-goblin", 30, 27], ["token-goblin", 27, 24]]);
  assert.equal(respond({decisions: [{operation: "select", targetId: "orc", count: 1}, {operation: "select", targetId: "goblin", count: 1}]}).ok,
    false, "two darts of three");
  assert.equal(respond({decisions: [{operation: "select", targetId: "orc", count: 3}, {operation: "select", targetId: "goblin", count: 0}]}).ok,
    false, "a creature kept with no dart");
  const all = respond({decisions: [{operation: "select", targetId: "orc", count: 3}, {operation: "deselect", targetId: "goblin"}]});
  assert.deepEqual(damagePlans(all.state).map(([token]) => token), ["token-orc", "token-orc", "token-orc"], "all three at one of the two");
});

test("repeatable targets may have an attack roll: each hit then rolls its own", () => {
  assert.equal(validateActionDefinition(darts).ok, true);
  assert.equal(validateActionDefinition(rays).ok, true, JSON.stringify(validateActionDefinition(rays).errors));
});

test("three rays at one creature: each its own attack roll, judged on its own, and each hit its own damage roll", () => {
  const waiting = planRays("resolution:rays-one", ["orc"]);
  assert.deepEqual(pendingIds(waiting.state), ["attack-roll", "attack-roll:2", "attack-roll:3"], "all three attacks are asked for at once");
  let state = answer(waiting.state, "attack-roll", {natural: 20, total: 20});
  assert.deepEqual(pendingIds(state), ["attack-roll:2", "attack-roll:3"], "the other two still wait");
  state = answer(state, "attack-roll:2", {natural: 5, total: 5});
  state = answer(state, "attack-roll:3", {natural: 15, total: 15});
  assert.deepEqual(state.results.attackResolution.results.map(result => [result.target.id, result.outcome, result.targetContext.instance]),
    [["orc", "criticalHit", 0], ["orc", "miss", 1], ["orc", "hit", 2]], "a critical, a miss against AC 15, and a hit on the tie");
  assert.deepEqual(pendingIds(state), ["damage-roll"]);
  assert.deepEqual(diceOf(state, "damage-roll"), [4], "the critical ray's 2d6 rolled twice");
  state = answer(state, "damage-roll", {total: 14});
  assert.deepEqual(pendingIds(state), ["damage-roll:hit-3"], "the hit ray rolls its own damage");
  assert.deepEqual(diceOf(state, "damage-roll:hit-3"), [2], "not doubled: its own hit is no critical");
  state = answer(state, "damage-roll:hit-3", {total: 7});
  assert.equal(state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, JSON.stringify(state.errors));
  assert.deepEqual(damagePlans(state), [["token-orc", 30, 16], ["token-orc", 16, 9]], "two hits, each its own damage");
});

test("a ray's critical doubles its own damage only, never another creature's ray", () => {
  const waiting = planRays("resolution:rays-crit-other", ["orc", "goblin", "kobold"]);
  let state = answer(waiting.state, "attack-roll", {natural: 15, total: 15});
  state = answer(state, "attack-roll:2", {natural: 20, total: 20});
  state = answer(state, "attack-roll:3", {natural: 2, total: 2});
  assert.deepEqual(diceOf(state, "damage-roll"), [2], "the orc's ray is no critical");
  state = answer(state, "damage-roll", {total: 7});
  assert.deepEqual(pendingIds(state), ["damage-roll:hit-2"], "no extra critical dice for the goblin on the orc's ray");
  assert.deepEqual(diceOf(state, "damage-roll:hit-2"), [4], "the goblin's own ray is doubled");
  state = answer(state, "damage-roll:hit-2", {total: 14});
  assert.equal(state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, JSON.stringify(state.errors));
  assert.deepEqual(damagePlans(state), [["token-orc", 30, 23], ["token-goblin", 30, 16]]);
});

test("rays at two creatures: each attack rolls with its own creature's roll mode, one an attack uses up on one ray", () => {
  // The orc's Advantage ends once it is attacked (Guiding Bolt: `once: "attacked"`): only the first ray at it has it.
  const waiting = planRays("resolution:rays-two", ["orc", "goblin"], {attack: {rollMode: "normal", rollModeSourcesByTarget: {
    "token-orc": [{mode: "advantage", once: "attacked"}], "token-goblin": [{mode: "disadvantage"}]}}});
  const request = waiting.state.pendingRequests[0];
  assert.equal(request.type, RESOLUTION_REQUEST_TYPES.TARGET_REFINEMENT, "how two creatures share three rays is asked");
  const shared = resumeStagedActionResolution({state: waiting.state, response: {resolutionId: waiting.state.id, requestId: request.id,
    type: RESOLUTION_REQUEST_TYPES.TARGET_REFINEMENT, value: {decisions: [{operation: "select", targetId: "orc", count: 2},
      {operation: "select", targetId: "goblin", count: 1}]}}});
  assert.equal(shared.ok, true, JSON.stringify(shared.state.errors));
  assert.deepEqual(shared.state.pendingRequests.map(entry => [entry.payload.targets[0].id, entry.payload.rollRequest.rollMode]),
    [["orc", "advantage"], ["orc", "normal"], ["goblin", "disadvantage"]]);
  // The caster's own Disadvantage ends once it attacks (Sap: `once: "attacks"`): the Action's first ray only.
  const sapped = planRays("resolution:rays-sapped", ["orc"], {attack: {rollMode: "disadvantage", rollModeSourcesByTarget: {
    "token-orc": [{mode: "disadvantage", once: "attacks"}]}}});
  assert.deepEqual(sapped.state.pendingRequests.map(entry => entry.payload.rollRequest.rollMode), ["disadvantage", "normal", "normal"]);
});

test("a ray's damage after the first: its creature's damage modifier on each hit, a once-a-turn extra on the first only", () => {
  // Agonizing Blast's modifier (`modifierTotal`) is on each damage roll; Sneak Attack's once-a-turn 1d6 on one.
  let state = planRays("resolution:rays-extra", ["orc"], {damage: {modifierTotal: 3, extraComponents: [{id: "extra:once",
    expression: {type: "dice", number: 1, faces: 6}, damageType: "fire", once: {key: "once", turn: "1.1"}}]}}).state;
  state = answer(state, "attack-roll", {natural: 15, total: 15});
  state = answer(state, "attack-roll:2", {natural: 16, total: 16});
  state = answer(state, "attack-roll:3", {natural: 2, total: 2});
  assert.deepEqual(pendingIds(state), ["damage-roll"]);
  assert.equal(state.pendingRequests[0].payload.rollRequest.definition.modifierTotal, 3);
  state = answer(state, "damage-roll", {total: 10});
  assert.deepEqual(pendingIds(state), ["damage-roll:1"], "the first hit's once-a-turn extra");
  state = answer(state, "damage-roll:1", {total: 4});
  assert.deepEqual(pendingIds(state), ["damage-roll:hit-2"], "the second hit has no extra component to roll after its own");
  assert.equal(state.pendingRequests[0].payload.rollRequest.definition.modifierTotal, 3, "the modifier on the second hit's roll too");
  assert.equal(state.input.damage.components[1].amount, 4, "the first hit's rolls are kept while the second's waits");
  state = answer(state, "damage-roll:hit-2", {total: 8});
  assert.equal(state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, JSON.stringify(state.errors));
  assert.deepEqual(damagePlans(state), [["token-orc", 30, 16], ["token-orc", 16, 8]], "14 with the extra, then 8 without it");
});

test("a once-a-turn extra gated on the d20 (natural) is judged on the first ray it rides: a later ray's 20 spends and tags nothing", () => {
  const events = [];
  const services = {reactions: {discover: ({event}) => { events.push(event); return {}; }}};
  const reply = (state, suffix, value) => {
    const request = state.pendingRequests.find(entry => entry.id === `request:${state.id}:${suffix}`);
    assert.ok(request, `${suffix} is asked for (pending: ${pendingIds(state)})`);
    const roll = request.payload.rollRequest;
    return resumeStagedActionResolution({state, services, response: {resolutionId: state.id, requestId: request.id,
      type: RESOLUTION_REQUEST_TYPES.ROLL, value: {requestId: roll.id, resolutionId: state.id, type: roll.type, ...value}}}).state;
  };
  let state = planStagedActionResolution({id: "resolution:rays-natural-once", actorSystem: {resources: {action: {value: 1, max: 1}}, pools: []},
    action: rayAction, source: {actorId: "actor-caster", tokenId: "token-caster"}, services,
    targeting: {required: true, candidates: [armored("orc")]}, attack: {modifierTotal: 0},
    damage: {extraComponents: [{id: "extra:smiting", expression: {type: "constant", value: 7}, damageType: "force", provenance: "additional",
      metadata: {ruleId: "smiting", natural: 20}, once: {key: "smiting", turn: "1.1"}}]},
    durability: {targetSystems: {"token-orc": health(30)}}}).state;
  state = reply(state, "attack-roll", {natural: 15, total: 15});
  state = reply(state, "attack-roll:2", {natural: 16, total: 16});
  state = reply(state, "attack-roll:3", {natural: 20, total: 20});
  state = reply(state, "damage-roll", {total: 10});
  state = reply(state, "damage-roll:hit-2", {total: 8});
  state = reply(state, "damage-roll:hit-3", {total: 14});
  assert.equal(state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, JSON.stringify(state.errors));
  assert.deepEqual(damagePlans(state), [["token-orc", 30, 20], ["token-orc", 20, 12], ["token-orc", 12, 0]],
    "the first ray's 15 drops it; the 20 never had it");
  assert.equal(state.mutationPlans.some(entry => (entry.type === "sourceUpdate") && ("flags.wildpath.onceUsed.smiting" in entry.updates)), false,
    "its once-a-turn use is kept");
  assert.equal(events.find(event => event?.type === "attack.hit")?.tags.includes("extra:smiting"), false, "no extra: tag for damage never dealt");
});

test("an attack's hit or miss and both its damage events carry the same attack facts, and its damage taken the first creature's Hit Points", () => {
  // Rays at one orc, with a d20-gated extra (`smiting`, on a 20), an ungated one (`flame`), a rider's tag already on it and
  // its weapon and a working binding on it (`weaponId`, `enchantments`, actionCombatStatistics'), kept as the input is rebuilt at each stage.
  const run = (id, naturals) => {
    const events = [];
    const services = {reactions: {discover: ({event}) => { events.push(event); return {}; }}};
    const base = createActionResolutionState({id, actorSystem: {resources: {action: {value: 1, max: 1}}, pools: []},
      action: rayAction, source: {actorId: "actor-caster", tokenId: "token-caster"},
      targeting: {required: true, candidates: [armored("orc")]}, attack: {modifierTotal: 0, weaponId: "sword", enchantments: ["slayer"]},
      damage: {extraComponents: [
        {id: "extra:smiting", expression: {type: "constant", value: 7}, damageType: "fire", provenance: "additional", metadata: {ruleId: "smiting", natural: 20}},
        {id: "extra:flame", expression: {type: "constant", value: 2}, damageType: "fire", provenance: "additional", metadata: {ruleId: "flame"}}]},
      durability: {targetSystems: {"token-orc": health(60)}}});
    let state = planStagedActionResolution({state: {...base, input: {...base.input, riderTags: ["brutal-strike"]}}, services}).state;
    // Each attack roll in turn (its d20 its total, against AC 15), then each damage roll a 5.
    const rolls = [...naturals.map(natural => ({natural, die: natural, total: natural}))];
    while ( state.pendingRequests.length ) {
      const request = state.pendingRequests[0];
      const roll = request.payload.rollRequest;
      state = resumeStagedActionResolution({state, services, response: {resolutionId: state.id, requestId: request.id,
        type: RESOLUTION_REQUEST_TYPES.ROLL, value: {requestId: roll.id, resolutionId: state.id, type: roll.type, ...(rolls.shift() ?? {total: 5})}}}).state;
    }
    assert.equal(state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, JSON.stringify(state.errors));
    const of = (type, phase) => events.find(event => (event?.type === type) && (event.phase === phase));
    return {state, events, hit: of("attack.hit", "interrupt"), miss: of("attack.miss", "interrupt"),
      coming: of("damage.applied", "before"), taken: of("damage.applied", "interrupt")};
  };
  const facts = ["ranged", "spell", "hit", "critical", "weapon:sword", "enchanted:slayer", "extra:smiting", "extra:flame", "brutal-strike"];
  const shown = (event, tags) => tags.filter(tag => event.tags.includes(tag));
  // A 20, a 15 and a miss: the 20 is a Critical Hit and shows the gated extra.
  const critical = run("resolution:rays-facts-20", [20, 15, 2]);
  for ( const event of [critical.hit, critical.coming, critical.taken] ) {
    assert.deepEqual(shown(event, facts), facts, `${event.type} ${event.phase}: every fact`);
  }
  assert.ok(critical.coming.tags.includes("damage:fire"), "the damage coming keeps its types");
  // Two hits on the orc: its first plan's from, its last plan's to.
  const plans = damagePlans(critical.state);
  assert.equal(plans.length, 2);
  assert.notEqual(plans[0][2], plans[1][2]);
  assert.deepEqual(critical.taken.data.health, {from: 60, to: plans[1][2], max: 60}, "the Hit Points across both hits");
  assert.equal(evaluatePredicate({atMost: {path: "event.data.health.to", value: plans[1][2]}}, {event: critical.taken}).ok, true);
  assert.equal(evaluatePredicate({atMost: {path: "event.data.health.to", value: plans[1][2] - 1}}, {event: critical.taken}).ok, false);
  assert.equal(critical.coming.data.health, undefined, "nothing is planned before the damage");
  // The kept d20 an attack event already carries (documented, not new): a 20 passes, the 15 of the first hit does not.
  const die = value => ({atLeast: {path: "event.data.attackResults.0.roll.die", value}});
  assert.equal(evaluatePredicate(die(20), {event: critical.hit}).ok, true);
  // A binding's own hit rider names its host weapon (`weapon:{{host}}`), so a second binding sharing its key on another
  // weapon does not answer this hit, as both would through `enchanted:<key>`.
  const ownRider = host => ({tagsAll: ["hit", `weapon:${host}`]});
  assert.equal(evaluatePredicate(ownRider("sword"), {tags: critical.hit.tags}).ok, true);
  assert.equal(evaluatePredicate(ownRider("axe"), {tags: critical.hit.tags}).ok, false);
  // A 15 and a 16: no critical, and the gated extra not shown, on all three.
  const plain = run("resolution:rays-facts-15", [15, 16, 2]);
  const plainFacts = ["ranged", "spell", "hit", "weapon:sword", "enchanted:slayer", "extra:flame", "brutal-strike"];
  for ( const event of [plain.hit, plain.coming, plain.taken] ) assert.deepEqual(shown(event, facts), plainFacts, `${event.type} ${event.phase}`);
  assert.equal(evaluatePredicate(die(20), {event: plain.hit}).ok, false);
  // All three miss: its miss shows its kind, its weapon and binding, the ungated extra and the rider's tag, never hit nor critical.
  const missed = run("resolution:rays-facts-miss", [2, 3, 4]);
  assert.deepEqual(shown(missed.miss, facts), ["ranged", "spell", "weapon:sword", "enchanted:slayer", "extra:flame", "brutal-strike"]);
  assert.equal(missed.events.some(event => event?.type === "damage.applied"), false, "a miss deals no damage");
});

test("damage taken by several creatures gives each its own Hit Points in its relation, the first's also at the top", () => {
  // A dart each at three creatures of 30, 10 and 5 Hit Points: a reactor that is not the first reads its own.
  const events = [];
  const services = {reactions: {discover: ({event}) => { events.push(event); return {}; }}};
  const names = ["orc", "goblin", "kobold"];
  const base = createActionResolutionState({id: "resolution:darts-health", actorSystem: {resources: {action: {value: 1, max: 1}}, pools: []},
    action, source: {actorId: "actor-caster", tokenId: "token-caster"}, targeting: {required: true, candidates: names.map(candidate)},
    durability: {targetSystems: {"token-orc": health(30), "token-goblin": health(10), "token-kobold": health(5)}}});
  const {state} = planStagedActionResolution({state: base, services});
  assert.equal(state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, JSON.stringify(state.errors));
  const taken = events.find(event => (event?.type === "damage.applied") && (event.phase === "interrupt"));
  assert.deepEqual(Object.fromEntries(names.map(name => [name, taken.data.relations[`token-${name}`].health])),
    {orc: {from: 30, to: 27, max: 30}, goblin: {from: 10, to: 7, max: 10}, kobold: {from: 5, to: 2, max: 5}});
  assert.deepEqual(taken.data.health, {from: 30, to: 27, max: 30}, "the first creature's at the top");
  const atMost = (path, value) => evaluatePredicate({atMost: {path, value}}, {event: taken}).ok;
  assert.equal(atMost("event.data.relations.token-goblin.health.to", 7), true, "the goblin reads its own 7");
  assert.equal(atMost("event.data.relations.token-goblin.health.to", 6), false);
  assert.equal(atMost("event.data.health.to", 7), false, "not the orc's 27");
});

test("a further ray's damage of two parts keeps its first roll while its second waits", () => {
  const twoParts = {...rays, damage: [...rays.damage, {id: "smoke", expression: {type: "dice", number: 1, faces: 4}, damageType: "fire"}]};
  let state = planRays("resolution:rays-parts", ["orc"], {definition: twoParts}).state;
  state = answer(state, "attack-roll", {natural: 15, total: 15});
  state = answer(state, "attack-roll:2", {natural: 15, total: 15});
  state = answer(state, "attack-roll:3", {natural: 1, total: 1});
  state = answer(state, "damage-roll", {total: 7});
  state = answer(state, "damage-roll:1", {total: 2});
  state = answer(state, "damage-roll:hit-2", {total: 9});
  assert.deepEqual(pendingIds(state), ["damage-roll:hit-2:1"]);
  assert.deepEqual(state.input.damage.byInstance["1"].components.map(component => component.amount), [9, null], "its first part kept");
  state = answer(state, "damage-roll:hit-2:1", {total: 3});
  assert.equal(state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, JSON.stringify(state.errors));
  assert.deepEqual(damagePlans(state), [["token-orc", 30, 21], ["token-orc", 21, 9]], "9 then 12");
});

test("a reaction answers one dart: its reduction comes off one hit and its redirect moves one hit", () => {
  // Stone's Endurance's 2 off the orc's damage: the first dart deals 1, the other two their 3.
  const reduced = plan("resolution:darts-reduced", ["orc"], {durability: {targetSystems: {"token-orc": health(30)},
    reductionsByTarget: {"token-orc": [{id: "rider:stone", type: "flat", amount: 2}]}}});
  assert.deepEqual(damagePlans(reduced.state), [["token-orc", 30, 29], ["token-orc", 29, 26], ["token-orc", 26, 23]]);
  // Protective Bond's ally takes one dart instead; the orc keeps the other two.
  const redirected = plan("resolution:darts-redirected", ["orc"], {durability: {targetSystems: {"token-orc": health(30),
    "token-ally": health(30)}, redirectsByTarget: {"token-orc": {id: "ally", actorId: "actor-ally", tokenId: "token-ally"}}}});
  assert.deepEqual(damagePlans(redirected.state), [["token-ally", 30, 27], ["token-orc", 30, 27], ["token-orc", 27, 24]]);
});

test("the attack's card says who took a target's damage instead (Arrow-Catching Shield), by name and never the amount", () => {
  const {state} = plan("resolution:card-redirected", ["orc"], {durability: {targetSystems: {"token-orc": health(30), "token-ally": health(30)},
    redirectsByTarget: {"token-orc": {id: "ally", actorId: "actor-ally", tokenId: "token-ally", name: "Catcher"}}}});
  const shown = projectResolutionResultForDisclosure(sanitizeResolutionResultForTransport({state}), "broadcast-safe");
  assert.deepEqual(createResolutionCardViewModel(shown).targets.map(entry => entry.redirected),
    [{label: "WILDPATH.CHAT.Outcome.Redirected", name: "Catcher"}], "on the orc's row: its damage went to the Catcher");
  assert.doesNotMatch(JSON.stringify(shown.outcomes.redirected), /total|components|byDamageType/u, "no amount");
  const plain = projectResolutionResultForDisclosure(sanitizeResolutionResultForTransport({state: plan("resolution:card-plain", ["orc"]).state}),
    "broadcast-safe");
  assert.deepEqual([plain.outcomes.redirected, createResolutionCardViewModel(plain).targets[0].redirected], [undefined, undefined]);
});

test("a one-roll damage bonus is on the first hit's damage roll only; the creature's other damage modifier is on each", () => {
  // 5 in all, 3 of it Empowered Evocation's Intelligence (`modifierOneRoll`): the first ray adds 5, the second 2.
  let state = planRays("resolution:rays-one-roll", ["orc"], {damage: {modifierTotal: 5, modifierOneRoll: 3}}).state;
  state = answer(state, "attack-roll", {natural: 15, total: 15});
  state = answer(state, "attack-roll:2", {natural: 16, total: 16});
  state = answer(state, "attack-roll:3", {natural: 2, total: 2});
  assert.equal(state.pendingRequests[0].payload.rollRequest.definition.modifierTotal, 5);
  state = answer(state, "damage-roll", {total: 10});
  assert.equal(state.pendingRequests[0].payload.rollRequest.definition.modifierTotal, 2, "the second ray's roll without the one-roll part");
  state = answer(state, "damage-roll:hit-2", {total: 6});
  assert.equal(state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, JSON.stringify(state.errors));
  assert.deepEqual(damagePlans(state), [["token-orc", 30, 20], ["token-orc", 20, 14]]);
});

test("a redirect keeping the attack's roll (Cloud Rune) compares the roll of the hit it moves, not a ray that missed first", () => {
  // The orc's first ray misses on 6, its second hits on 19: the bystander (AC 12) takes that 19's damage.
  let state = planRays("resolution:rays-redirect", ["orc"], {durability: {targetSystems: {"token-orc": health(30), "token-ally": health(30)},
    redirectsByTarget: {"token-orc": {id: "ally", actorId: "actor-ally", tokenId: "token-ally", sameRollAgainst: 12}}}}).state;
  state = answer(state, "attack-roll", {natural: 6, total: 6});
  state = answer(state, "attack-roll:2", {natural: 19, total: 19});
  state = answer(state, "attack-roll:3", {natural: 2, total: 2});
  state = answer(state, "damage-roll", {total: 7});
  assert.equal(state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, JSON.stringify(state.errors));
  assert.deepEqual(damagePlans(state), [["token-ally", 30, 23]], "19 hits AC 12: the redirected ray lands");
});

test("a redirect keeping the attack's roll lands a natural 20 whatever the new creature's AC (Q48), and a lower roll still misses it", () => {
  const moved = (id, natural, {attack={}, against=25}={}) => {
    let state = planRays(id, ["orc"], {attack, durability: {targetSystems: {"token-orc": health(30), "token-ally": health(30)},
      redirectsByTarget: {"token-orc": {id: "ally", actorId: "actor-ally", tokenId: "token-ally", sameRollAgainst: against}}}}).state;
    state = answer(state, "attack-roll", {natural, total: natural});
    state = answer(state, "attack-roll:2", {natural: 2, total: 2});
    state = answer(state, "attack-roll:3", {natural: 2, total: 2});
    state = answer(state, "damage-roll", {total: 7});
    assert.equal(state.status, RESOLUTION_STATE_STATUS.READY_TO_COMMIT, JSON.stringify(state.errors));
    return damagePlans(state);
  };
  assert.deepEqual(moved("resolution:rays-redirect-natural", 20), [["token-ally", 30, 23]], "a natural 20 against AC 25: it lands");
  assert.deepEqual(moved("resolution:rays-redirect-nineteen", 19), [["token-ally", 30, 30]], "19 against AC 25: it misses, no damage");
  assert.deepEqual(moved("resolution:rays-redirect-improved", 19, {attack: {policy: {criticalHitThreshold: 19}}}),
    [["token-ally", 30, 23]], "a natural 19 in a 19-20 critical range (Improved Critical) lands too");
  // The orc's Half cover (-2 against it) is its own: the 19 it rolled is 17 against the orc, and 19 again against the ally.
  assert.deepEqual(moved("resolution:rays-redirect-cover", 19, {attack: {bonusByTarget: {"token-orc": -2}}, against: 19}),
    [["token-ally", 30, 23]], "19 against the ally's 19: the first target's cover does not follow the roll");
  // Cover as it arrives now: the orc's Half cover raises its AC (+2), never the roll, so the moved 19 is still 19.
  assert.deepEqual(moved("resolution:rays-redirect-cover-ac", 19, {attack: {defenseBonusByTarget: {"token-orc": 2}}, against: 19}),
    [["token-ally", 30, 23]], "19 against the ally's 19: the orc's raised AC does not lower the moved roll");
});
