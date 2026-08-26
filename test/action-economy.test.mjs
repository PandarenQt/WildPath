import {test} from "node:test";
import assert from "node:assert/strict";
import {
  ECONOMY_AVAILABILITY,
  ECONOMY_CAPABILITIES,
  ECONOMY_REFRESH,
  ECONOMY_UNITS,
  commitPaymentPlan,
  createBuiltinEconomyResource,
  createEconomyResource,
  economyResourcesFromActorResources,
  refreshResources,
  resolvePaymentOptions,
  selectDefaultPaymentOption
} from "../module/helpers/action-economy.mjs";

const actionCost = (capability, amount=1, unit=null) => ({capability, amount, ...(unit ? {unit} : {})});

test("base Action payment is discovered and committed without mutating discovery inputs", () => {
  const resources = [createBuiltinEconomyResource("economy.action", {current: 1, maximum: 1})];
  const result = resolvePaymentOptions({resources, cost: actionCost(ECONOMY_CAPABILITIES.ACTION)});
  assert.equal(result.code, ECONOMY_AVAILABILITY.AVAILABLE);
  assert.equal(result.options.length, 1);
  assert.equal(resources[0].current, 1);

  const committed = commitPaymentPlan(resources, selectDefaultPaymentOption(result.options));
  assert.equal(committed.ok, true);
  assert.equal(committed.resources[0].current, 0);
  assert.equal(resources[0].current, 1);
});

test("Bonus Action activities consume Bonus Action resources by default", () => {
  const resources = [
    createBuiltinEconomyResource("economy.action", {current: 1, maximum: 1}),
    createBuiltinEconomyResource("economy.bonus-action", {current: 1, maximum: 1})
  ];
  const result = resolvePaymentOptions({resources, cost: actionCost(ECONOMY_CAPABILITIES.BONUS_ACTION)});
  const selected = selectDefaultPaymentOption(result.options);
  assert.equal(selected.resources[0].resourceId, "economy.bonus-action");
});

test("Bonus Action fallback to Action is unavailable when disabled", () => {
  const resources = [
    createBuiltinEconomyResource("economy.action", {current: 1, maximum: 1}),
    createBuiltinEconomyResource("economy.bonus-action", {current: 0, maximum: 1})
  ];
  const result = resolvePaymentOptions({
    resources,
    cost: actionCost(ECONOMY_CAPABILITIES.BONUS_ACTION),
    policies: {allowActionForSpentBonusAction: false}
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.code, ECONOMY_AVAILABILITY.INSUFFICIENT_RESOURCE);
});

test("Bonus Action fallback to Action is enabled by default after Bonus Actions are depleted", () => {
  const resources = [
    createBuiltinEconomyResource("economy.action", {current: 1, maximum: 1}),
    createBuiltinEconomyResource("economy.bonus-action", {current: 0, maximum: 1})
  ];
  const result = resolvePaymentOptions({
    resources,
    cost: actionCost(ECONOMY_CAPABILITIES.BONUS_ACTION)
  });
  const selected = selectDefaultPaymentOption(result.options);

  assert.equal(result.status, "available");
  assert.equal(selected.mode, "alternative");
  assert.equal(selected.resources[0].resourceId, "economy.action");
  assert.equal(selected.resources[0].policy, "action-for-spent-bonus-action");
});

test("Bonus Action fallback to Action is offered only after Bonus Action is unavailable", () => {
  const resources = [
    createBuiltinEconomyResource("economy.action", {current: 1, maximum: 1}),
    createBuiltinEconomyResource("economy.bonus-action", {current: 0, maximum: 1})
  ];
  const result = resolvePaymentOptions({
    resources,
    cost: actionCost(ECONOMY_CAPABILITIES.BONUS_ACTION),
    policies: {allowActionForSpentBonusAction: true}
  });
  const selected = selectDefaultPaymentOption(result.options);
  assert.equal(selected.mode, "alternative");
  assert.equal(selected.resources[0].resourceId, "economy.action");
  assert.equal(selected.resources[0].policy, "action-for-spent-bonus-action");
});

test("Bonus Action fallback waits until every eligible Bonus Action resource is depleted", () => {
  const resources = [
    createBuiltinEconomyResource("economy.action", {current: 1, maximum: 1}),
    createBuiltinEconomyResource("economy.bonus-action", {current: 0, maximum: 1}),
    createEconomyResource({
      id: "feature.quickened-bonus",
      category: "bonus-action",
      current: 1,
      maximum: 1,
      paymentCapabilities: [ECONOMY_CAPABILITIES.BONUS_ACTION],
      source: {type: "feature", slug: "quickened-bonus"}
    })
  ];
  const result = resolvePaymentOptions({
    resources,
    cost: actionCost(ECONOMY_CAPABILITIES.BONUS_ACTION)
  });
  const selected = selectDefaultPaymentOption(result.options);

  assert.equal(result.status, "available");
  assert.equal(selected.mode, "direct");
  assert.equal(selected.resources[0].resourceId, "feature.quickened-bonus");
});

test("Bonus Action fallback is unavailable when no usable Bonus Action resource exists", () => {
  const resources = [
    createBuiltinEconomyResource("economy.action", {current: 1, maximum: 1}),
    createEconomyResource({
      id: "feature.weapon-bonus",
      category: "bonus-action",
      current: 1,
      maximum: 1,
      paymentCapabilities: [ECONOMY_CAPABILITIES.BONUS_ACTION],
      predicate: {tagsAny: ["weapon-attack"]}
    })
  ];
  const result = resolvePaymentOptions({
    resources,
    cost: actionCost(ECONOMY_CAPABILITIES.BONUS_ACTION),
    action: {tags: ["spell"]}
  });

  assert.equal(result.status, "unavailable");
  assert.equal(result.code, ECONOMY_AVAILABILITY.RESOURCE_RESTRICTION_FAILED);
});

test("additional unrestricted Action can pay when the base Action is spent", () => {
  const resources = [
    createBuiltinEconomyResource("economy.action", {current: 0, maximum: 1}),
    createEconomyResource({
      id: "feature.extra-action",
      category: "action",
      current: 1,
      maximum: 1,
      paymentCapabilities: [ECONOMY_CAPABILITIES.ACTION],
      source: {type: "feature", slug: "surge"}
    })
  ];
  const result = resolvePaymentOptions({resources, cost: actionCost(ECONOMY_CAPABILITIES.ACTION)});
  assert.equal(result.status, "available");
  assert.equal(result.options[0].resources[0].resourceId, "feature.extra-action");
});

test("restricted extra Actions use predicates rather than feature-name branches", () => {
  const resources = [
    createEconomyResource({
      id: "effect.haste-action",
      category: "action",
      current: 1,
      maximum: 1,
      paymentCapabilities: [ECONOMY_CAPABILITIES.ACTION],
      predicate: {tagsAny: ["weapon-attack"]},
      source: {type: "effect", slug: "haste"}
    })
  ];
  const allowed = resolvePaymentOptions({
    resources,
    cost: actionCost(ECONOMY_CAPABILITIES.ACTION),
    action: {tags: ["weapon-attack"]}
  });
  const disallowed = resolvePaymentOptions({
    resources,
    cost: actionCost(ECONOMY_CAPABILITIES.ACTION),
    action: {tags: ["spell"]}
  });

  assert.equal(allowed.status, "available");
  assert.equal(disallowed.status, "unavailable");
  assert.equal(disallowed.code, ECONOMY_AVAILABILITY.RESOURCE_RESTRICTION_FAILED);
});

test("Action Economy uses the shared structured Predicate evaluator", () => {
  const resources = [
    createEconomyResource({
      id: "effect.special-action",
      category: "action",
      current: 1,
      maximum: 1,
      paymentCapabilities: [ECONOMY_CAPABILITIES.ACTION],
      predicate: {equals: {path: "action.metadata.delivery", value: "weapon"}}
    })
  ];
  const allowed = resolvePaymentOptions({
    resources,
    cost: actionCost(ECONOMY_CAPABILITIES.ACTION),
    action: {metadata: {delivery: "weapon"}}
  });
  const disallowed = resolvePaymentOptions({
    resources,
    cost: actionCost(ECONOMY_CAPABILITIES.ACTION),
    action: {metadata: {delivery: "spell"}}
  });

  assert.equal(allowed.status, "available");
  assert.equal(disallowed.status, "unavailable");
  assert.equal(disallowed.failures[0].reason, "action.metadata.delivery did not equal weapon");
});

test("Action Economy rejects arbitrary function predicates as non-serializable rules", () => {
  const resources = [
    createEconomyResource({
      id: "effect.scripted-action",
      category: "action",
      current: 1,
      maximum: 1,
      paymentCapabilities: [ECONOMY_CAPABILITIES.ACTION],
      predicate: () => true
    })
  ];
  const result = resolvePaymentOptions({
    resources,
    cost: actionCost(ECONOMY_CAPABILITIES.ACTION),
    action: {tags: ["weapon-attack"]}
  });

  assert.equal(result.status, "unavailable");
  assert.equal(result.code, ECONOMY_AVAILABILITY.RESOURCE_RESTRICTION_FAILED);
  assert.match(result.failures[0].reason, /structured object/);
});

test("multiple eligible Action resources are returned as explicit options", () => {
  const resources = [
    createBuiltinEconomyResource("economy.action", {current: 1, maximum: 1}),
    createEconomyResource({
      id: "feature.extra-action",
      category: "action",
      current: 1,
      maximum: 1,
      paymentCapabilities: [ECONOMY_CAPABILITIES.ACTION],
      priority: 20
    })
  ];
  const result = resolvePaymentOptions({resources, cost: actionCost(ECONOMY_CAPABILITIES.ACTION)});
  assert.equal(result.options.length, 2);
  assert.equal(selectDefaultPaymentOption(result.options).resources[0].resourceId, "economy.action");
});

test("Reaction resources are independent and refresh on turn start", () => {
  const resources = [createBuiltinEconomyResource("economy.reaction", {current: 1, maximum: 1})];
  const result = resolvePaymentOptions({resources, cost: actionCost(ECONOMY_CAPABILITIES.REACTION)});
  const committed = commitPaymentPlan(resources, selectDefaultPaymentOption(result.options));
  assert.equal(committed.resources[0].current, 0);

  const refreshed = refreshResources(committed.resources, ECONOMY_REFRESH.TURN_START);
  assert.equal(refreshed[0].current, 1);
});

test("additional Reactions preserve provenance and consume independently", () => {
  const resources = [
    createBuiltinEconomyResource("economy.reaction", {current: 1, maximum: 1}),
    createEconomyResource({
      id: "feature.sentinel-reaction",
      category: "reaction",
      current: 1,
      maximum: 1,
      paymentCapabilities: [ECONOMY_CAPABILITIES.REACTION],
      source: {type: "feature", slug: "sentinel"},
      priority: 20
    })
  ];
  const result = resolvePaymentOptions({resources, cost: actionCost(ECONOMY_CAPABILITIES.REACTION)});
  assert.equal(result.options.length, 2);

  const committed = commitPaymentPlan(resources, result.options.find(o => o.resources[0].resourceId === "feature.sentinel-reaction"));
  assert.equal(committed.resources.find(r => r.id === "economy.reaction").current, 1);
  assert.equal(committed.resources.find(r => r.id === "feature.sentinel-reaction").current, 0);
  assert.deepEqual(committed.resources.find(r => r.id === "feature.sentinel-reaction").source, {
    type: "feature",
    slug: "sentinel"
  });
});

test("Legendary Action points support point costs and refresh", () => {
  const resources = [createBuiltinEconomyResource("economy.legendary-action", {current: 3, maximum: 3})];
  const first = resolvePaymentOptions({
    resources,
    cost: actionCost(ECONOMY_CAPABILITIES.LEGENDARY_ACTION, 2, ECONOMY_UNITS.POINTS)
  });
  const afterFirst = commitPaymentPlan(resources, selectDefaultPaymentOption(first.options)).resources;
  assert.equal(afterFirst[0].current, 1);

  const second = resolvePaymentOptions({
    resources: afterFirst,
    cost: actionCost(ECONOMY_CAPABILITIES.LEGENDARY_ACTION, 2, ECONOMY_UNITS.POINTS)
  });
  assert.equal(second.code, ECONOMY_AVAILABILITY.INSUFFICIENT_RESOURCE);
  assert.equal(refreshResources(afterFirst, ECONOMY_REFRESH.TURN_START)[0].current, 3);
});

test("Lair Action availability remains distinct from timing eligibility", () => {
  const resources = [createBuiltinEconomyResource("economy.lair-action", {current: 1, maximum: 1})];
  const result = resolvePaymentOptions({
    resources,
    cost: actionCost(ECONOMY_CAPABILITIES.LAIR_ACTION),
    action: {timingEligible: false}
  });
  assert.equal(result.status, "available");
});

test("composite costs can require multiple different resources", () => {
  const resources = [
    createBuiltinEconomyResource("economy.action", {current: 1, maximum: 1}),
    createEconomyResource({id: "ki", current: 2, maximum: 2, paymentCapabilities: ["ki"]})
  ];
  const result = resolvePaymentOptions({
    resources,
    cost: {allOf: [actionCost(ECONOMY_CAPABILITIES.ACTION), actionCost("ki", 2)]}
  });
  const committed = commitPaymentPlan(resources, selectDefaultPaymentOption(result.options));
  assert.equal(committed.resources.find(r => r.id === "economy.action").current, 0);
  assert.equal(committed.resources.find(r => r.id === "ki").current, 0);
});

test("zero-cost requirements normalize to a no-resource payment option", () => {
  const resources = [createBuiltinEconomyResource("economy.action", {current: 1, maximum: 1})];
  const result = resolvePaymentOptions({
    resources,
    cost: actionCost(ECONOMY_CAPABILITIES.ACTION, 0)
  });
  assert.equal(result.status, "available");
  assert.deepEqual(result.options[0].resources, []);
});

test("custom Actor pools adapt into custom economy resources", () => {
  const resources = economyResourcesFromActorResources({
    resources: {action: {value: 1, max: 1}},
    pools: [{id: "ki", label: "Ki", value: 2, max: 3, recovery: "shortRest"}]
  });

  assert.equal(resources.find(r => r.id === "economy.action").paymentCapabilities[0], ECONOMY_CAPABILITIES.ACTION);
  assert.equal(resources.find(r => r.id === "ki").paymentCapabilities[0], "ki");
  assert.equal(resources.find(r => r.id === "ki").refreshPolicies[0].event, ECONOMY_REFRESH.SHORT_REST);
});

test("refresh policies support turn start, round start, manual, and none", () => {
  const resources = [
    createEconomyResource({id: "turn", current: 0, maximum: 1, refreshPolicies: [ECONOMY_REFRESH.TURN_START]}),
    createEconomyResource({id: "round", current: 0, maximum: 1, refreshPolicies: [ECONOMY_REFRESH.ROUND_START]}),
    createEconomyResource({id: "manual", current: 0, maximum: 1, refreshPolicies: [ECONOMY_REFRESH.MANUAL]}),
    createEconomyResource({id: "none", current: 0, maximum: 1, refreshPolicies: [ECONOMY_REFRESH.NONE]})
  ];

  assert.equal(refreshResources(resources, ECONOMY_REFRESH.TURN_START).find(r => r.id === "turn").current, 1);
  assert.equal(refreshResources(resources, ECONOMY_REFRESH.ROUND_START).find(r => r.id === "round").current, 1);
  assert.equal(refreshResources(resources, ECONOMY_REFRESH.MANUAL).find(r => r.id === "manual").current, 1);
  assert.equal(refreshResources(resources, ECONOMY_REFRESH.TURN_START).find(r => r.id === "none").current, 0);
});
