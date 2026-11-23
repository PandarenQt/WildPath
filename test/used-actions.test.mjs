import {test} from "node:test";
import assert from "node:assert/strict";
import {actionDefinitionFromItem, normalizeActionDefinition, usedDefinition, validateActionDefinition} from "../module/helpers/action-definitions.mjs";
import {resolveActionConfiguration} from "../module/helpers/action-configuration.mjs";
import {RESOLUTION_REQUEST_TYPES} from "../module/helpers/resolution-state.mjs";
import {rollFormulaForRequest} from "../module/helpers/rolls.mjs";
import {planStagedActionResolution, resumeStagedActionResolution} from "../module/resolvers/action-pipeline-resolver.mjs";

// True Strike, hand-written (use-action-within design): one attack with a weapon picked at the casting, its spellcasting
// ability, extra Radiant damage by level (0 below level 5), and a choice of the weapon's type or Radiant.
const extraRadiant = {type: "table", key: {type: "character-level"}, default: {type: "constant", value: 0},
  rows: {"5": {type: "dice", number: 1, faces: 6}, "11": {type: "dice", number: 2, faces: 6}, "17": {type: "dice", number: 3, faces: 6}}};
const trueStrike = (use={}, optionsFrom={}) => ({schemaVersion: 1, id: "action:true-strike", label: "True Strike", tags: ["spell", "cantrip"],
  costs: {allOf: [{capability: "action", amount: 1}]}, targeting: {type: "none"},
  configuration: [{id: "weapon", type: "select-one", required: true, label: "Weapon", options: [],
    optionsFrom: {type: "weapons", each: "attack", proficient: true, ...optionsFrom}, effects: [{type: "bindChoice"}]}],
  uses: [{action: "{{weapon}}", target: "pick", with: {attack: {ability: "spellcasting"},
    damage: [{id: "true-strike", damageType: "radiant", expression: extraRadiant}],
    configuration: [{id: "damage-type", type: "select-one", required: true, label: "Damage type", options: [
      {id: "weapon", value: "weapon", label: "Weapon"},
      {id: "radiant", value: "radiant", label: "Radiant", effects: [{type: "replace-damage-type", damageType: "radiant"}]}]}]}, ...use}]});
const refusals = definition => validateActionDefinition(definition).errors.map(entry => entry.path);

test("uses: what an Action uses is validated, its parts as an Action's own", () => {
  assert.deepEqual(refusals(trueStrike()), []);
  assert.deepEqual(refusals({...trueStrike(), uses: [{action: "common:unarmed", target: "pick",
    with: {damage: [{expression: {type: "dice", number: 1, faces: 6}}]}}]}), [], "a common action, a part typed by the used Action");
  assert.deepEqual(refusals(trueStrike({action: ""})), ["uses.0.action"]);
  assert.deepEqual(refusals(trueStrike({action: "action:true-strike"})), ["uses.0.action"], "never itself");
  assert.deepEqual(refusals(trueStrike({action: "{{other}}"})), ["uses.0.action"], "a token names a weapons choice of the Action");
  assert.deepEqual(refusals(trueStrike({}, {each: null})), ["uses.0.action"], "one listing each attack, not each weapon");
  const withChoice = change => ({...trueStrike(), configuration: [{...trueStrike().configuration[0], ...change}]});
  assert.deepEqual(refusals(withChoice({effects: []})), ["uses.0.action"], "a choice that never binds the token");
  assert.deepEqual(refusals(withChoice({id: "pick", effects: [{type: "bindChoice", token: "weapon"}]})), [], "bound by its token");
  assert.deepEqual(refusals(trueStrike({target: "all"})), ["uses.0.target"]);
  assert.deepEqual(refusals({...trueStrike(), uses: ["action:bite"]}), ["uses.0"]);
  assert.deepEqual(refusals(trueStrike({with: {healing: []}})), ["uses.0.with.healing"]);
  assert.deepEqual(refusals(trueStrike({with: {attack: {ability: "luck"}}})), ["uses.0.with.attack"]);
  assert.deepEqual(refusals(trueStrike({with: {attack: {ability: "might", bonus: 2}}})), ["uses.0.with.attack"]);
  assert.deepEqual(refusals(trueStrike({with: {damage: [{damageType: "radiant"}]}})), ["uses.0.with.damage.0.expression"]);
  assert.deepEqual(refusals(trueStrike({with: {effects: [{type: "ref", ref: "x"}]}})), ["uses.0.with.effects.0.type"]);
  assert.deepEqual(refusals({...trueStrike(), targetChoice: {from: "creatures", range: 30, notAllied: "yes"}}), ["targetChoice.notAllied"]);
});

test("uses is kept as written, and dropped when empty", () => {
  const typeless = {action: "common:unarmed", with: {damage: [{id: "thunder", expression: {type: "dice", number: 1, faces: 6}}]}};
  assert.deepEqual(normalizeActionDefinition({id: "a", uses: [typeless]}).uses, [typeless], "an untyped part stays untyped");
  assert.equal("uses" in normalizeActionDefinition({id: "a", uses: []}), false);
});

test("usedDefinition: free, its with applied, and a pick within its reach or longest range, not an ally", () => {
  const dagger = {schemaVersion: 1, id: "dagger-attack", label: "Dagger", tags: ["attack"],
    costs: {anyOf: [[{capability: "extra-attack", amount: 1}], [{capability: "action", amount: 1}]]},
    controllerCosts: {allOf: [{capability: "bonus-action", amount: 1}]}, restores: [{resourceId: "extra-attack", amount: 1}, {resourceId: "rage", amount: 1}],
    range: {type: "ranged", normal: {value: 20, unit: "ft"}, long: {value: 60, unit: "ft"}}, targeting: {type: "single", count: 1},
    attack: {type: "ranged", statistic: "weapon", weapon: {base: "dagger", melee: true}},
    damage: [{id: "base", expression: {type: "dice", number: 1, faces: 4}, damageType: "piercing", provenance: "weapon-base"}],
    effects: [{id: "own", type: "condition", conditionId: "prone"}], configuration: [{id: "mastery", type: "boolean", label: "Mastery"}]};
  const before = structuredClone(dagger);
  const used = usedDefinition(dagger, {action: "dagger-attack", target: "pick", with: {attack: {ability: "spellcasting"},
    damage: [{id: "extra", expression: {type: "constant", value: 2}}, {id: "radiant", damageType: "radiant", expression: {type: "constant", value: 1}}],
    effects: [{id: "slow", type: "condition", conditionId: "slowed"}], configuration: [{id: "damage-type", type: "boolean", label: "Type"}]}});
  assert.deepEqual(dagger, before, "its own definition is untouched");
  assert.deepEqual(used.costs, {allOf: []});
  assert.equal("controllerCosts" in used, false);
  assert.deepEqual(used.restores, [{resourceId: "rage", amount: 1}], "Extra Attack's pool, which it could pay from, is not refilled");
  assert.deepEqual(used.attack, {...dagger.attack, ability: "spellcasting"});
  assert.deepEqual(used.damage.map(part => [part.id, part.damageType, part.provenance]),
    [["base", "piercing", "weapon-base"], ["extra", "piercing", "additional"], ["radiant", "radiant", "additional"]]);
  assert.deepEqual(used.effects.map(effect => effect.id), ["own", "slow"]);
  assert.deepEqual(used.configuration.map(choice => choice.id), ["damage-type", "mastery"], "its user's choices first");
  assert.deepEqual(used.targetChoice, {from: "creatures", range: 60, notAllied: true}, "a thrown dagger's long range");
  assert.equal(validateActionDefinition(used).ok, true, JSON.stringify(validateActionDefinition(used).errors));

  // A Multiattack's restore is of a pool it does not pay from, so it stays; "same" sets no pick; no `with`, no change.
  const multiattack = {id: "multiattack", costs: {allOf: [{capability: "action", amount: 1}]}, restores: [{resourceId: "multiattack", amount: 2}],
    damage: [], effects: [], configuration: []};
  const same = usedDefinition(multiattack, {action: "multiattack"});
  assert.deepEqual([same.restores, same.targetChoice, same.attack], [[{resourceId: "multiattack", amount: 2}], undefined, undefined]);
  const reach = distance => usedDefinition({id: "x", range: {type: "reach", ...(distance ? {distance: {value: distance, unit: "ft"}} : {})}},
    {action: "x", target: "pick"}).targetChoice.range;
  assert.deepEqual([reach(null), reach(10)], [5, 10], "a reach is 5 ft unless it says more (a Glaive's 10)");
  assert.equal(usedDefinition({id: "bow", range: {type: "ranged", normal: {value: 150}, long: {value: 600}}}, {action: "bow", target: "pick"})
    .targetChoice.range, 600, "a longbow's long range");
  assert.deepEqual(["self", "none"].map(type => usedDefinition({id: "dodge", targeting: {type}}, {action: "dodge", target: "pick"}).targetChoice),
    [undefined, undefined], "one acting only on its own creature has nobody to pick");

  // Free of its economy only: a limited pool's charge (Hurl Hammer's) is still paid, by each way to pay it.
  const charge = {capability: "hammer", amount: 1};
  const costsOf = (costs, restores) => usedDefinition({id: "x", costs, ...(restores ? {restores} : {})}, {action: "x"}).costs;
  assert.deepEqual(costsOf({allOf: [{capability: "action", amount: 1}, charge]}), {allOf: [charge]});
  assert.deepEqual(costsOf({anyOf: [[{capability: "extra-attack", amount: 1}, charge], [{capability: "action", amount: 1}, charge]]},
    [{resourceId: "extra-attack", amount: 1}]), {anyOf: [[charge], [charge]]}, "with Extra Attack's pool");
  assert.deepEqual(costsOf({anyOf: [[{capability: "multiattack", amount: 1}], [{capability: "action", amount: 1}]]}), {allOf: []},
    "a Multiattack's attack is free: one way pays only its Action");
});

test("a feature-granted spell's \"spellcasting\" ability is the feature's (Magic Initiate's True Strike)", () => {
  const actor = wielder();
  actor.system.abilities = {intellect: {value: 16}, wits: {value: 10}};
  actor.items.push({id: "feat", type: "feature", flags: {wildpath: {castingAbilities: ["wits", "intellect"]}}});
  const definition = actionDefinitionFromItem({type: "action", actor, flags: {wildpath: {grantedBy: "feat"}},
    system: {definition: trueStrike()}}).definition;
  assert.equal(definition.uses[0].with.attack.ability, "intellect");
  assert.equal(actionDefinitionFromItem({type: "action", actor: wielder(), system: {definition: trueStrike()}}).definition
    .uses[0].with.attack.ability, "spellcasting", "a class's spell keeps the creature's own");
});

test("a using Action's slot dice and chosen type reach the damage it adds (uses[].with.damage)", () => {
  const definition = {schemaVersion: 1, id: "action:searing-edge", tags: ["spell"], costs: {allOf: []}, targeting: {type: "none"},
    uses: [{action: "common:unarmed", with: {damage: [{id: "extra", damageType: "fire", expression: {type: "dice", number: 1, faces: 6}}]}}],
    configuration: [{id: "spell-slot", type: "resource", required: true,
      cost: {anyOf: [[{capability: "spell-slot.3", amount: 1}]]}, levelByResourceId: {"spell-slot.3": 3},
      effects: [{type: "scaleDamage", levelChoiceId: "spell-slot", baseLevel: 1, dice: {number: 1, faces: 6}}]},
    {id: "type", type: "damage-type", label: "Damage type", required: true, allowedDamageTypes: ["fire", "cold"],
      effects: [{type: "replaceDamageType", damageTypeChoiceId: "type"}]}]};
  const result = resolveActionConfiguration({definition, actorSystem: {resources: {}, pools: [{id: "spell-slot.3", value: 1, max: 1}]},
    choices: {"spell-slot": {resourceId: "spell-slot.3"}, type: "cold"}});
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const [extra] = result.configuration.effectiveDefinition.uses[0].with.damage;
  assert.deepEqual([extra.expression, extra.damageType], [{type: "dice", number: 3, faces: 6}, "cold"]);
  assert.equal(definition.uses[0].with.damage[0].expression.number, 1, "the stored definition is untouched");
});

/** A simple-weapon wielder with a Dagger (its melee and thrown attacks), a martial Longsword, and Magic Weapon on the Dagger. */
const wielder = ({magicDagger=false}={}) => {
  const attack = (id, name, grantedBy, attackData) => ({id, name, type: "action", flags: {wildpath: {grantedBy}},
    system: {definition: {schemaVersion: 1, id, label: name, attack: {statistic: "weapon", proficient: true, ...attackData}}}});
  return {system: {training: {weapons: ["simple"]}},
    effects: magicDagger ? [{disabled: false, flags: {wildpath: {conditionEffect: {definition: {magicWeapon: "dagger"}}}}}] : [],
    items: [{id: "dagger", type: "gear", name: "Dagger", system: {}}, {id: "sword", type: "gear", name: "Longsword", system: {}},
      attack("stab", "Dagger", "dagger", {type: "melee", weapon: {category: "simple", base: "dagger"}}),
      attack("toss", "Dagger (Thrown)", "dagger", {type: "ranged", weapon: {category: "simple", base: "dagger", melee: true}}),
      attack("slash", "Longsword", "sword", {type: "melee", weapon: {category: "martial", base: "longsword"}})]};
};
const weaponOptions = (optionsFrom, actor=wielder()) => actionDefinitionFromItem({type: "action", actor,
  system: {definition: {...trueStrike(), configuration: [{...trueStrike().configuration[0], optionsFrom: {type: "weapons", ...optionsFrom}}]}}})
  .definition.configuration[0].options.map(option => [option.value, option.label]);

test("a weapons choice lists each attack by its own Action (each), only the proficient ones (proficient)", () => {
  assert.deepEqual(weaponOptions({}), [["dagger", "Dagger"], ["sword", "Longsword"]], "one per weapon, as before");
  assert.deepEqual(weaponOptions({each: "attack"}), [["stab", "Dagger"], ["toss", "Dagger (Thrown)"], ["slash", "Longsword"]]);
  assert.deepEqual(weaponOptions({each: "attack", proficient: true}), [["stab", "Dagger"], ["toss", "Dagger (Thrown)"]],
    "a simple-weapon wielder is not proficient with a Longsword");
  assert.deepEqual(weaponOptions({each: "attack", magical: false}, wielder({magicDagger: true})), [["slash", "Longsword"]],
    "an attack is magical by its weapon: Magic Weapon on the Dagger leaves out both of its attacks");
});

test("the chosen attack is bound into uses, and an attack not among the options is refused", () => {
  const definition = actionDefinitionFromItem({type: "action", actor: wielder(), system: {definition: trueStrike()}}).definition;
  const actorSystem = {resources: {action: {value: 1, max: 1}}, pools: []};
  const chosen = resolveActionConfiguration({definition, actorSystem, choices: {weapon: "toss"}});
  assert.equal(chosen.ok, true, JSON.stringify(chosen.errors));
  assert.equal(chosen.configuration.effectiveDefinition.uses[0].action, "toss");
  assert.equal(resolveActionConfiguration({definition, actorSystem, choices: {weapon: "slash"}}).ok, false, "not proficient: not an option");
  assert.equal(resolveActionConfiguration({definition, actorSystem, choices: {weapon: "forged"}}).ok, false);
});

test("True Strike's extra Radiant is 0 below level 5, rolling nothing, and 1d6 from level 5 (its table's default)", () => {
  const used = usedDefinition({schemaVersion: 1, id: "stab", costs: {allOf: []}, targeting: {type: "single", count: 1},
    attack: {type: "melee", statistic: "weapon"},
    damage: [{id: "base", expression: {type: "dice", number: 1, faces: 4}, damageType: "piercing", provenance: "weapon-base"}]},
  {action: "stab", with: {damage: trueStrike().uses[0].with.damage}});
  const resolve = level => {
    // No attack roll: only its damage is looked at.
    let plan = planStagedActionResolution({id: `resolution:true-strike-${level}`, source: {actorId: "actor-source"},
      actorSystem: {resources: {action: {value: 1, max: 1}}, pools: [], details: {level}},
      action: {id: "stab", type: "action", name: "Dagger", system: {definition: {...used, attack: null}}},
      targets: [{id: "orc", actorId: "actor-orc", tokenId: "token-orc", disposition: "enemy"}]});
    const formulas = [];
    while ( plan.state.pendingRequests?.length ) {
      const {id, payload: {rollRequest}} = plan.state.pendingRequests[0];
      formulas.push(rollFormulaForRequest(rollRequest).formula);
      plan = resumeStagedActionResolution({state: plan.state, response: {resolutionId: plan.state.id, requestId: id,
        type: RESOLUTION_REQUEST_TYPES.ROLL, value: {requestId: rollRequest.id, resolutionId: plan.state.id, type: rollRequest.type, total: 3}}});
    }
    return {formulas, amounts: plan.state.input.damage.components.map(part => [part.id, part.amount])};
  };
  assert.deepEqual(resolve(1), {formulas: ["1d4"], amounts: [["base", 3], ["true-strike", 0]]});
  assert.deepEqual(resolve(5), {formulas: ["1d4", "1d6"], amounts: [["base", 3], ["true-strike", 3]]});
});
