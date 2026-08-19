import {test} from "node:test";
import assert from "node:assert/strict";
import {
  DAMAGE_COMPONENT_PROVENANCE,
  DAMAGE_RESOLVER_CODES,
  DAMAGE_SCALING_CATEGORIES,
  createDamageComponent,
  createDamageDice,
  isWeaponSizeScalable,
  resolveDamageComponents,
  resolveDamageTargets
} from "../module/resolvers/damage-resolver.mjs";

test("DamageResolver totals components and groups damage by type", () => {
  const result = resolveDamageComponents({
    components: [
      createDamageComponent({
        id: "base",
        amount: 8,
        damageType: "slashing",
        provenance: DAMAGE_COMPONENT_PROVENANCE.WEAPON_BASE
      }),
      createDamageComponent({
        id: "fire",
        amount: 3,
        damageType: "fire",
        provenance: DAMAGE_COMPONENT_PROVENANCE.ADDITIONAL
      })
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(result.total, 11);
  assert.deepEqual(result.byDamageType, {slashing: 8, fire: 3});
});

test("DamageResolver preserves structural dice and weapon-size scaling provenance", () => {
  const base = createDamageComponent({
    id: "base",
    amount: 6,
    dice: createDamageDice({number: 1, faces: 8}),
    damageType: "slashing",
    provenance: DAMAGE_COMPONENT_PROVENANCE.WEAPON_BASE,
    scalingCategory: DAMAGE_SCALING_CATEGORIES.WEAPON_SIZE
  });
  const fire = createDamageComponent({
    id: "fire",
    amount: 4,
    dice: createDamageDice({number: 1, faces: 6}),
    damageType: "fire",
    provenance: DAMAGE_COMPONENT_PROVENANCE.ADDITIONAL
  });
  const result = resolveDamageComponents({components: [base, fire]});

  assert.equal(isWeaponSizeScalable(base), true);
  assert.equal(isWeaponSizeScalable(fire), false);
  assert.deepEqual(result.scalableComponents.map(component => component.id), ["base"]);
  assert.deepEqual(result.unscaledComponents.map(component => component.id), ["fire"]);
  assert.deepEqual(result.scalableComponents[0].dice, {
    number: 1,
    faces: 8,
    formula: null,
    metadata: {}
  });
});

test("DamageResolver follows metadata rather than damage type for scalable components", () => {
  const result = resolveDamageComponents({
    components: [
      createDamageComponent({
        id: "weapon-fire",
        amount: 5,
        damageType: "fire",
        provenance: DAMAGE_COMPONENT_PROVENANCE.WEAPON_BASE,
        scalingCategory: DAMAGE_SCALING_CATEGORIES.WEAPON_SIZE
      }),
      createDamageComponent({
        id: "extra-slashing",
        amount: 2,
        damageType: "slashing",
        provenance: DAMAGE_COMPONENT_PROVENANCE.ADDITIONAL
      })
    ]
  });

  assert.deepEqual(result.scalableComponents.map(component => component.id), ["weapon-fire"]);
  assert.deepEqual(result.unscaledComponents.map(component => component.id), ["extra-slashing"]);
});

test("DamageResolver can derive amount from rolled dice plus bonus", () => {
  const result = resolveDamageComponents({
    components: [
      createDamageComponent({
        id: "rolled",
        rolled: 7,
        bonus: 3,
        damageType: "piercing"
      })
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(result.components[0].amount, 10);
  assert.equal(result.total, 10);
});

test("DamageResolver reports missing and invalid component amounts", () => {
  const missing = resolveDamageComponents({components: [createDamageComponent({id: "missing"})]});
  const negative = resolveDamageComponents({components: [createDamageComponent({id: "negative", amount: -1})]});

  assert.equal(missing.ok, false);
  assert.equal(missing.code, DAMAGE_RESOLVER_CODES.MISSING_AMOUNT);
  assert.equal(missing.failures[0].id, "missing");
  assert.equal(negative.ok, false);
  assert.equal(negative.code, DAMAGE_RESOLVER_CODES.INVALID_COMPONENT);
});

test("DamageResolver resolves selected targets and skips excluded targets", () => {
  const result = resolveDamageTargets({
    components: [createDamageComponent({id: "base", amount: 6, damageType: "slashing"})],
    targetContexts: [
      {target: {id: "orc", actorId: "actor-orc"}, selected: true},
      {target: {id: "bystander", actorId: "actor-bystander"}, selected: false, excluded: true}
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, DAMAGE_RESOLVER_CODES.OK);
  assert.deepEqual(result.totals, {orc: 6});
  assert.deepEqual(result.skipped.map(skip => skip.target.id), ["bystander"]);
});

test("DamageResolver can resolve target-specific prepared components", () => {
  const component = createDamageComponent({id: "base", amount: 8, damageType: "fire"});
  const result = resolveDamageTargets({
    components: [component],
    targetContexts: [
      {target: {id: "failed-save"}, selected: true},
      {target: {id: "saved"}, selected: true}
    ],
    componentsForTarget(targetContext, components) {
      if ( targetContext.target.id !== "saved" ) return components;
      return components.map(entry => ({
        ...entry,
        amount: Math.floor(entry.amount / 2),
        metadata: {
          ...entry.metadata,
          adjustedFor: "save-success"
        }
      }));
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.totals, {"failed-save": 8, saved: 4});
  assert.equal(result.results.find(entry => entry.target.id === "saved").components[0].metadata.adjustedFor, "save-success");
  assert.equal(component.amount, 8);
});

test("DamageResolver reports no damageable targets when all targets are skipped", () => {
  const result = resolveDamageTargets({
    components: [createDamageComponent({id: "base", amount: 6})],
    targetContexts: [
      {target: {id: "bystander"}, selected: false, excluded: true}
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, DAMAGE_RESOLVER_CODES.NO_DAMAGEABLE_TARGETS);
  assert.equal(result.skipped.length, 1);
});

test("DamageResolver does not mutate input components or target contexts", () => {
  const component = {
    id: "base",
    amount: 8,
    damageType: "slashing",
    metadata: {nested: {value: 1}}
  };
  const targetContext = {
    target: {id: "orc", actorId: "actor-orc"},
    selected: true,
    results: []
  };
  const result = resolveDamageTargets({
    components: [component],
    targetContexts: [targetContext]
  });

  result.results[0].components[0].metadata.nested.value = 99;
  result.results[0].targetContext.results.push({id: "new"});

  assert.equal(component.metadata.nested.value, 1);
  assert.deepEqual(targetContext.results, []);
});
