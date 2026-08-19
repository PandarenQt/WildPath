import {test} from "node:test";
import assert from "node:assert/strict";
import {createActorSheetViewModel} from "../module/helpers/character-sheet-view-models.mjs";

function system({action=1, focus=2}={}) {
  return {
    abilities: {
      might: {value: 18},
      wits: {value: 12}
    },
    resources: {
      health: {value: 8, max: 10},
      action: {value: action, max: 1},
      bonus: {value: 1, max: 1},
      reaction: {value: 1, max: 1},
      movement: {value: 30, max: 30}
    },
    pools: [
      {id: "focus", label: "Focus", value: focus, max: 3, recovery: "shortRest"}
    ],
    biography: ""
  };
}

test("actor sheet view model groups sheet content for navigation", () => {
  const model = createActorSheetViewModel({
    actor: {id: "actor-a", name: "Rook", type: "character", img: "rook.webp", system: system()},
    items: [
      {id: "sword", type: "gear", name: "Sword"},
      {id: "second-wind", type: "feature", name: "Second Wind"},
      {id: "strike", type: "action", name: "Strike", activationCost: {allOf: []}},
      {id: "note", type: "lore", name: "Old Note"}
    ],
    effects: [{id: "haste", name: "Haste"}],
    statuses: new Set(["poisoned"]),
    abilityLabels: {might: {label: "Might"}, wits: {label: "Wits"}},
    conditionDefinitions: [
      {id: "poisoned", name: "Poisoned"},
      {id: "prone", name: "Prone"}
    ]
  });

  assert.equal(model.actor.ref, "actor:actor-a");
  assert.equal(model.header.health.value, 8);
  assert.equal(model.abilities.find(ability => ability.key === "might").modifier, 4);
  assert.deepEqual(model.actionItems.map(item => item.id), ["strike"]);
  assert.deepEqual(model.featureItems.map(item => item.id), ["second-wind"]);
  assert.deepEqual(model.gearItems.map(item => item.id), ["sword"]);
  assert.deepEqual(model.otherItems.map(item => item.id), ["note"]);
  assert.equal(model.conditions.find(condition => condition.id === "poisoned").active, true);
  assert.equal(model.summary.effectCount, 1);
  assert.deepEqual(model.sections.map(section => section.id), ["overview", "actions", "inventory", "effects", "biography"]);
});

test("actor sheet view model exposes action availability without sheet rules", () => {
  const model = createActorSheetViewModel({
    actor: {id: "actor-a", system: system({action: 0})},
    items: [
      {id: "strike", type: "action", name: "Strike", activationCost: {allOf: [{capability: "action", amount: 1}]}}
    ]
  });

  assert.equal(model.actionItems[0].availability.enabled, false);
  assert.equal(model.actionItems[0].availability.code, "INSUFFICIENT_RESOURCE");
  assert.equal(model.actionItems[0].availability.reason, "Insufficient Resource");
});

test("actor sheet view model renders custom resources without hardcoded slots", () => {
  const model = createActorSheetViewModel({
    actor: {id: "actor-a", system: system({focus: 1})},
    items: [
      {id: "focus-burst", type: "action", name: "Focus Burst", activationCost: {allOf: [{capability: "focus", amount: 1}]}}
    ]
  });

  assert.deepEqual(model.pools.map(pool => pool.id), ["focus"]);
  assert.equal(model.pools[0].label, "Focus");
  assert.equal(model.actionItems[0].availability.enabled, true);
  assert.equal(model.actionItems[0].availability.defaultPaymentOptionId, "payment-1");
});
