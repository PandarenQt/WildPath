import {test} from "node:test";
import assert from "node:assert/strict";
import {COMMON_ACTION_IDS, commonAction, commonActionId} from "../module/helpers/common-actions.mjs";
import {validateActionDefinition} from "../module/helpers/action-definitions.mjs";
import {actionBarContext} from "../module/helpers/action-bar-context.mjs";

test("every creature's common actions are valid Actions, built fresh from their id", () => {
  assert.deepEqual([...COMMON_ACTION_IDS], ["dash", "disengage", "dodge", "hide", "grapple", "shove", "unarmed"]);
  const actor = {uuid: "Actor.hero"};
  for ( const id of COMMON_ACTION_IDS ) {
    const action = commonAction(actor, id, {localize: key => key.split(".").pop()});
    assert.equal(validateActionDefinition(action.system.definition).ok, true, id);
    assert.deepEqual([action.uuid, action.type, action.actor], [`common:${id}`, "action", actor]);
  }
  assert.equal(commonAction(actor, "dash").system.definition.label, "WILDPATH.COMMON.Dash", "named by its lang key");
  const shove = commonAction(actor, "shove").system.definition;
  assert.deepEqual([shove.save.ability, shove.effects[0].conditionId, shove.effects[0].saveOutcomePolicy], ["might", "prone", "failure"]);
  assert.notEqual(commonAction(actor, "dash").system.definition, commonAction(actor, "dash").system.definition, "never shared");
  assert.deepEqual(["common:dash", "common:fly", "Item.dash", "common:Dash", null].map(commonActionId), ["dash", null, null, null, null]);
});

test("the action bar lists the common actions last, in their own group", () => {
  const actor = {name: "Hero", items: [], effects: [], system: {resources: {action: {value: 1, max: 1}, bonus: {value: 1, max: 1},
    reaction: {value: 1, max: 1}, movement: {value: 30, max: 30}}, pools: []}};
  const common = COMMON_ACTION_IDS.map(id => commonAction(actor, id, {localize: key => key.split(".").pop()}));
  const groups = actionBarContext({actor, common}).groups;
  assert.equal(groups.at(-1).id, "common");
  assert.deepEqual(groups.at(-1).actions.map(action => [action.label, action.enabled]).slice(0, 3),
    [["Dash", true], ["Disengage", true], ["Dodge", true]]);
});
