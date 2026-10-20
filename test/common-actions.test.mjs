import {test} from "node:test";
import assert from "node:assert/strict";
import {COMMON_ACTION_IDS, commonAction, commonActionId} from "../module/helpers/common-actions.mjs";
import {validateActionDefinition} from "../module/helpers/action-definitions.mjs";
import {actionBarContext} from "../module/helpers/action-bar-context.mjs";

test("every creature's common actions are valid Actions, built fresh from their id", () => {
  assert.deepEqual([...COMMON_ACTION_IDS], ["dash", "disengage", "dodge", "help", "hide", "grapple", "shove", "push", "unarmed", "search",
    "study", "influence", "escape", "utilize", "opportunity"]);
  assert.deepEqual(commonAction({uuid: "Actor.hero"}, "search").system.definition.metadata.test.skills,
    ["insight", "medicine", "perception", "survival"], "2024 Search: the Action, then one of these checks");
  const actor = {uuid: "Actor.hero"};
  for ( const id of COMMON_ACTION_IDS.filter(id => id !== "escape") ) {
    const action = commonAction(actor, id, {localize: key => key.split(".").pop()});
    assert.equal(validateActionDefinition(action.system.definition).ok, true, id);
    assert.deepEqual([action.uuid, action.type, action.actor], [`common:${id}`, "action", actor]);
  }
  assert.equal(commonAction(actor, "dash").system.definition.label, "WILDPATH.COMMON.Dash", "named by its lang key");
  const shove = commonAction(actor, "shove").system.definition;
  assert.deepEqual([shove.save.ability, shove.effects[0].conditionId, shove.effects[0].saveOutcomePolicy], ["might", "prone", "failure"]);
  const push = commonAction(actor, "push").system.definition;
  assert.deepEqual(["shove", "push", "grapple"].map(id => commonAction(actor, id, {bonusShove: true}).system.definition.costs.allOf[0].capability),
    ["bonus-action", "bonus-action", "action"], "Baldur's Gate 3: Shove is a Bonus Action; Grapple is not");
  assert.deepEqual([push.save.ability, push.push, push.effects], ["might", {distance: 5}, undefined], "or pushed 5 feet on a failed save");
  assert.notEqual(commonAction(actor, "dash").system.definition, commonAction(actor, "dash").system.definition, "never shared");
  assert.deepEqual(["common:dash", "common:fly", "Item.dash", "common:Dash", null].map(commonActionId), ["dash", null, null, null, null]);

  const axe = {type: "action", name: "Axe", system: {definition: {schemaVersion: 1, id: "action:axe", label: "Axe", costs: {allOf: [{capability: "action", amount: 1}]},
    targeting: {type: "single", required: true, count: 1}, range: {type: "reach", distance: {value: 5, unit: "ft"}},
    attack: {type: "melee", statistic: "weapon", defenseKey: "ac"}, damage: [{id: "axe", expression: {type: "dice", number: 1, faces: 12},
      damageType: "slashing", provenance: "weapon-base"}]}}};
  const opportunity = commonAction({items: [axe], flags: {wildpath: {commonPolicies: {opportunity: "always"}}}}, "opportunity",
    {localize: () => "Opportunity Attack"});
  assert.equal(opportunity.name, "Opportunity Attack (Axe)");
  assert.deepEqual([opportunity.system.definition.id, opportunity.system.definition.costs], ["action:axe", {allOf: [{capability: "reaction", amount: 1}]}],
    "the creature's own melee weapon, so its modifiers count, for its Reaction");
  assert.equal(opportunity.flags.wildpath.reactionPolicy, "always", "its setting is the creature's");
  assert.equal(commonAction({items: []}, "opportunity").system.definition.id, "common:unarmed", "without a weapon, an Unarmed Strike");
});

test("with Extra Attack, the Unarmed Strike's cost on the bar includes its pool", () => {
  const fighter = {items: [], flags: {}, getExtraAttacks: () => ["extra-attack"], system: {pools: [{id: "extra-attack", value: 1, max: 1}]}};
  assert.deepEqual(commonAction(fighter, "unarmed").activationCost.anyOf?.map(option => option.map(cost => cost.capability)),
    [["extra-attack"], ["action"]]);
  assert.equal(commonAction({items: [], flags: {}}, "unarmed").activationCost.anyOf, undefined);
});

test("the action bar lists the common actions last, in their own group", () => {
  const actor = {name: "Hero", items: [], effects: [], system: {resources: {action: {value: 1, max: 1}, bonus: {value: 1, max: 1},
    reaction: {value: 1, max: 1}, movement: {value: 30, max: 30}}, pools: []}};
  const common = COMMON_ACTION_IDS.map(id => commonAction(actor, id, {localize: key => key.split(".").pop()})).filter(Boolean);
  assert.equal(common.some(action => action.uuid === "common:escape"), false, "nothing to escape, no Escape");
  const groups = actionBarContext({actor, common}).groups;
  assert.equal(groups.at(-1).id, "common");
  assert.deepEqual(groups.at(-1).actions.map(action => [action.label, action.enabled]).slice(0, 3),
    [["Dash", true], ["Disengage", true], ["Dodge", true]]);
  const opportunity = groups.at(-1).actions.at(-1);
  assert.deepEqual([opportunity.label, opportunity.policy?.id], ["OpportunityAttack", "ask"], "a reaction, with its setting");

  actor.system.resources.action.value = 0;
  const spent = actionBarContext({actor, common}).groups.at(-1).actions;
  assert.deepEqual(spent.slice(0, 2).map(action => action.enabled), [false, false], "a spent Action greys them out");
  assert.equal(spent.at(-1).enabled, true, "the Reaction is still there");
});

test("Escape: only while grappled or restrained with an escape DC, its better of Athletics and Acrobatics against it", () => {
  const held = (type, escapeDC, disabled=false) => ({disabled, system: {type}, flags: {wildpath: {conditionEffect: {metadata: {escapeDC}}}}});
  const creature = effects => ({uuid: "Actor.hero", items: [], effects, system: {abilities: {might: {value: 10}, agility: {value: 16}},
    skills: {}, details: {level: 1}}});
  assert.equal(commonAction(creature([]), "escape"), null);
  assert.equal(commonAction(creature([held("grappled", 13, true), held("prone", 15)]), "escape"), null, "disabled, or nothing escapable");
  assert.equal(commonAction(creature([{system: {type: "grappled"}}]), "escape"), null, "a Grappled with no escape DC (Grapple's own is kept)");

  const escape = commonAction(creature([held("restrained", 12), held("grappled", 13), held("grappled", 15)]), "escape").system.definition;
  assert.equal(validateActionDefinition(escape).ok, true);
  assert.deepEqual([escape.check, escape.effects[0].conditionId, escape.effects[0].levels, escape.effects[0].checkOutcomePolicy],
    [{skill: "acrobatics", dc: {value: 15}, escapes: "grappled"}, "grappled", -1, "success"], "Agility 16 beats Might 10; the hardest grapple first");
  const strong = creature([held("restrained", 14)]);
  strong.system.abilities.might.value = 18;
  assert.deepEqual(commonAction(strong, "escape").system.definition.check, {skill: "athletics", dc: {value: 14}, escapes: "restrained"});
  assert.equal(commonAction(strong, "escape").system.definition.effects[0].conditionId, "restrained");

  const grappler = {uuid: "Actor.ogre", items: [], system: {abilities: {might: {value: 19}}, details: {level: 5}}};
  assert.deepEqual(commonAction(grappler, "grapple").system.definition.effects[0].metadata, {escapeDC: 8 + 4 + 3},
    "the grappler's escape DC: 8 + Might modifier + Proficiency Bonus");
});

test("what a common action applies names its creature as the source, so a Grapple's Grappled knows its grappler", async () => {
  const {planConditionEffect} = await import("../module/resolvers/effect-resolver.mjs");
  const {conditionsFrom} = await import("../module/helpers/effect-sources.mjs");
  const captain = {uuid: "Scene.s.Token.cap.Actor.bandit", id: "bandit", items: [], system: {abilities: {might: {value: 14}}, details: {level: 1}}};
  const grapple = commonAction(captain, "grapple").system.definition;
  const plan = planConditionEffect({conditionId: "grappled", actor: {effects: []}, source: grapple.source});
  assert.equal(plan.plan?.sourceRef ?? plan.sourceRef, "uuid:Scene.s.Token.cap.Actor.bandit");
  const held = {effects: [{statuses: ["grappled"], flags: {wildpath: {conditionEffect: {sourceRef: "uuid:Scene.s.Token.cap.Actor.bandit"}}}}]};
  assert.deepEqual(conditionsFrom(held, captain, {scenes: []}), {grappled: true}, "attacks on its grappler have no disadvantage");
  assert.equal(commonAction({uuid: ""}, "grapple").system.definition.source, undefined, "no creature, no source (converted content)");
});

test("Help: the next attack on an enemy beside you has Advantage, and its effect ends once it is attacked", async () => {
  const help = commonAction({}, "help").system.definition;
  assert.equal(validateActionDefinition(help).ok, true);
  assert.deepEqual([help.range.distance.value, help.effects[0].endsWhen, help.effects[0].ruleElements[0].data],
    [5, "attacked", {domains: ["attacked"], mode: "advantage"}]);
  assert.equal(validateActionDefinition({...help, effects: [{...help.effects[0], endsWhen: "moved"}]}).ok, false);

  const {endEffectsWhenAttacked} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const deleted = [];
  const effect = (id, endsWhen) => ({id, flags: {wildpath: {conditionEffect: {definition: endsWhen ? {endsWhen} : {}}}}});
  const enemy = {effects: [effect("distracted", "attacked"), effect("blessed")], deleteEmbeddedDocuments: async (type, ids) => deleted.push(...ids)};
  const scene = {tokens: {get: id => (id === "enemy" ? {actor: enemy} : null)}};
  const state = {source: {tokenRef: "Scene.s.Token.hero"}, results: {attackResolution: {results: [{ok: true, hit: false, target: {tokenId: "enemy"}}]}}};
  await endEffectsWhenAttacked({state}, {fromUuid: async () => ({parent: scene})});
  assert.deepEqual(deleted, ["distracted"], "after the attack, hit or miss; other effects stay");
  assert.deepEqual(await endEffectsWhenAttacked({state: {results: {}}}, {fromUuid: async () => null}), [], "no attack, nothing ends");
});
