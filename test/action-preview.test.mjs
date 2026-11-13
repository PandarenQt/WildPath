import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {averageOfFormula, previewAction} from "../module/helpers/action-preview.mjs";
import {applyActionTemplate} from "../module/helpers/action-builder.mjs";

const pack = file => JSON.parse(readFileSync(new URL(`../packs/_source/actions/${file}`, import.meta.url), "utf8")).system.definition;

test("fixed dice: average damage, rounded down per dice term", () => {
  assert.equal(averageOfFormula("2d6 + 3"), 10);
  assert.equal(averageOfFormula("1d8"), 4);
  assert.equal(averageOfFormula("8d6 - 1"), 27);
  assert.equal(averageOfFormula("d4"), 2);
});

test("an attack previews a hit or a miss against the sample AC, and stops before commit", async () => {
  const hit = await previewAction(pack("melee-strike.json"), {d20: 15, target: {ac: 13, health: 30}});
  assert.equal(hit.status, "ready-to-commit", "nothing is committed");
  assert.deepEqual(hit.attacks.map(attack => [attack.total, attack.defense, attack.outcome]), [[15, 13, "hit"]]);
  assert.deepEqual(hit.changes.map(change => [change.type, change.amount, change.from, change.to]), [["damage", 4, 30, 26]]);
  assert.deepEqual(hit.payments.map(payment => payment.resource), ["economy.action"]);

  const miss = await previewAction(pack("melee-strike.json"), {d20: 5, target: {ac: 13}});
  assert.deepEqual(miss.attacks.map(attack => attack.outcome), ["miss"]);
  assert.deepEqual(miss.changes, []);

  const trip = await previewAction(pack("trip.json"), {d20: 15});
  assert.deepEqual(trip.effects.map(effect => effect.effect), ["WILDPATH.CONDITIONS.Prone"], "a condition shows as an effect");
});

test("the Test tab and the Rules Inspector show a roll's kind, mode and method and each outcome in words from lang/en.json", async () => {
  const {inspectResolution} = await import("../module/helpers/resolution-inspection.mjs");
  const lang = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
  const known = key => typeof key.split(".").reduce((node, part) => node?.[part], lang) === "string";
  const hit = await previewAction(pack("melee-strike.json"), {d20: 15, target: {ac: 13, health: 30}});
  const saved = await previewAction(pack("venom-burst.json"), {d20: 12, target: {saveBonus: 1}});
  const labels = [...hit.rolls, ...saved.rolls].flatMap(roll => [roll.kindLabel, roll.modeLabel])
    .concat(hit.attacks.map(attack => attack.outcomeLabel), saved.saves.map(save => save.outcomeLabel));
  assert.deepEqual(hit.attacks.map(attack => attack.outcomeLabel), ["WILDPATH.INSPECTOR.Outcome.hit"]);
  assert.deepEqual(saved.saves.map(save => save.outcomeLabel), ["WILDPATH.INSPECTOR.Outcome.success"]);
  assert.deepEqual(labels.filter(label => !known(label)), [], "every label is a lang key");
  // A request names itself as the chat card does (rollLabel); a reroll with none by its kind's suffix.
  const custom = (rollKind, more={}) => ({type: "custom", metadata: {rollKind, ...more}});
  const rolls = inspectResolution({state: {rollResults: [
    {rollRequest: {...custom("attack-added-die"), rollMode: "advantage"}, rollResult: {total: 3, provenance: {method: "natural"}}},
    {rollRequest: custom("rider-added-die", {labelKey: "WILDPATH.CHAT.Roll.SlotKept"}), rollResult: {total: 4}},
    {rollRequest: {type: "damage", definition: {components: [{damageType: "fire"}]}}, rollResult: {total: 9}},
    {rollRequest: {type: "damage", definition: {components: [{damageType: "fire", metadata: {subtract: true}}]}}, rollResult: {total: 2}},
    {type: "save-set-natural", roll: {total: 20}}, {type: "attack-added", roll: {total: 17}}, {type: "attack-forced-hit", roll: {total: 9}},
    {rollRequest: custom("homebrew"), rollResult: {total: 1, provenance: {method: "digital"}}}]}}).rolls;
  assert.deepEqual(rolls.map(roll => [roll.kindLabel, roll.kindType ?? null, roll.modeLabel, roll.methodLabel]), [
    ["WILDPATH.INSPECTOR.Kind.AddedDie", null, "WILDPATH.INSPECTOR.Mode.advantage", "WILDPATH.INSPECTOR.Method.natural"],
    ["WILDPATH.CHAT.Roll.SlotKept", null, "WILDPATH.INSPECTOR.Mode.normal", null],
    ["WILDPATH.CHAT.Roll.TypedDamage", "WILDPATH.DAMAGE.Fire", "WILDPATH.INSPECTOR.Mode.normal", null],
    ["WILDPATH.CHAT.Roll.LessDamage", null, "WILDPATH.INSPECTOR.Mode.normal", null],
    ["WILDPATH.INSPECTOR.Kind.SetNatural", null, null, null], ["WILDPATH.INSPECTOR.Kind.Added", null, null, null],
    ["WILDPATH.INSPECTOR.Kind.ForcedHit", null, null, null],
    ["homebrew", null, "WILDPATH.INSPECTOR.Mode.normal", "WILDPATH.INSPECTOR.Method.digital"]], "an unknown kind shows as it is");
  assert.ok(rolls.flatMap(roll => [roll.kindLabel, roll.kindType, roll.modeLabel, roll.methodLabel]).filter(label => label?.startsWith("WILDPATH.")).every(known));
});

test("the Rules Inspector names a change type, an economy resource, a pool and each payer in words, not by their ids", async () => {
  const {inspectResolution} = await import("../module/helpers/resolution-inspection.mjs");
  const lang = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
  const known = key => typeof key.split(".").reduce((node, part) => node?.[part], lang) === "string";
  const ranger = {actorRef: "Actor.ranger", actorSystem: {pools: [{id: "favored-foe", label: "Favored Foe"}]}};
  const inspected = inspectResolution({state: {source: {actorRef: "Actor.wolf"}, targets: [{actorRef: "Actor.dragon", name: "Dragon"}],
    input: {actorSystem: {pools: [{id: "haste-extra-action", label: "Haste's extra Action"}]}, controller: ranger},
    mutationPlans: [
      {type: "durabilityDamage", target: {name: "Goblin"}, plan: {amount: 4, from: 7, to: 3}},
      {type: "durabilityAbsorption", target: {name: "Goblin"}, plan: {amount: 2, from: 3, to: 5}},
      {type: "conditionEffect", target: {name: "Goblin"}, conditionId: "prone", action: "create"},
      {type: "resourcePayment", plan: {payments: [{resourceId: "economy.action", from: 1, to: 0},
        {resourceId: "haste-extra-action", from: 1, to: 0}]}},
      {type: "resourcePayment", payerRef: "Actor.ranger", plan: {payments: [{resourceId: "favored-foe", from: 2, to: 1}]}},
      {type: "resourcePayment", payerRef: "Actor.dragon", plan: {payments: [{resourceId: "economy.reaction", from: 1, to: 0}]}},
      {type: "resourcePayment", payerRef: "Actor.stranger", plan: {payments: [{resourceId: "homebrew-points", from: 1, to: 0}]}},
      // The acting creature paying with its own ref (its own Heroic Inspiration for a reroll).
      {type: "resourcePayment", payerRef: "Actor.wolf", plan: {payments: [{resourceId: "heroic-inspiration", from: 1, to: 0}]}}]}});
  assert.deepEqual(inspected.changes.map(change => change.typeLabel), ["WILDPATH.INSPECTOR.Change.damage", "WILDPATH.INSPECTOR.Change.absorption"]);
  assert.deepEqual(inspected.effects.map(effect => effect.actionLabel), ["WILDPATH.INSPECTOR.EffectAction.create"]);
  assert.deepEqual(inspected.payments.map(payment => [payment.payerLabel, payment.resourceLabel]), [
    ["WILDPATH.INSPECTOR.Payer.Source", "WILDPATH.RESOURCES.Action"], ["WILDPATH.INSPECTOR.Payer.Source", "Haste's extra Action"],
    ["WILDPATH.INSPECTOR.Payer.Other", "Favored Foe"], ["Dragon", "WILDPATH.RESOURCES.Reaction"],
    ["WILDPATH.INSPECTOR.Payer.Other", "homebrew-points"], ["WILDPATH.INSPECTOR.Payer.Source", "heroic-inspiration"]],
    "a named creature by its name; the acting creature by its own ref too; an unknown pool as it is");
  const keys = [...inspected.changes.map(change => change.typeLabel), ...inspected.effects.map(effect => effect.actionLabel),
    ...inspected.payments.flatMap(payment => [payment.payerLabel, payment.resourceLabel])].filter(label => label.startsWith("WILDPATH."));
  assert.deepEqual(keys.filter(key => !known(key)), [], "every label is a lang key");
});

test("the Rules Inspector names a homebrew damage type in words, as the chat card does, and a known one by its lang key", async t => {
  const {inspectResolution} = await import("../module/helpers/resolution-inspection.mjs");
  const lang = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
  const find = key => key.split(".").reduce((node, part) => node?.[part], lang);
  globalThis.game = {i18n: {has: key => typeof find(key) === "string", localize: key => find(key) ?? key}};
  t.after(() => { delete globalThis.game; });
  const damage = damageType => ({rollRequest: {type: "damage", definition: {components: [{damageType}]}}, rollResult: {total: 5}});
  const rolls = inspectResolution({state: {rollResults: [damage("eldritch-fire"), damage("fire")]}}).rolls;
  assert.deepEqual(rolls.map(roll => roll.kindType), ["Eldritch Fire", "WILDPATH.DAMAGE.Fire"]);
});

test("a save previews half damage on a success, and full damage and its effect on a failure", async () => {
  const saved = await previewAction(pack("venom-burst.json"), {d20: 12, target: {saveBonus: 1}});
  assert.deepEqual(saved.saves.map(save => [save.total, save.dc, save.outcome]), [[13, 13, "success"]]);
  assert.deepEqual(saved.changes.map(change => change.amount), [3]);
  assert.deepEqual(saved.effects, []);
  const failed = await previewAction(pack("venom-burst.json"), {d20: 2});
  assert.deepEqual(failed.changes.map(change => change.amount), [7]);
  assert.deepEqual(failed.effects.map(effect => effect.effect), ["WILDPATH.CONDITIONS.Poisoned"]);
});

test("a builder-made Action previews: a required slot takes its first option, an area catches the target", async () => {
  const scaling = await previewAction(pack("scaling-bolt.json"));
  assert.deepEqual(scaling.payments.map(payment => payment.resource), ["spell-slot.1"]);
  assert.deepEqual(scaling.changes.map(change => change.amount), [7]);

  const burst = applyActionTemplate({}, "areaSave", {fallbackId: "action:burst"});
  const result = await previewAction(burst, {d20: 1, target: {health: 40}});
  assert.equal(result.status, "ready-to-commit");
  assert.deepEqual(result.changes.map(change => [change.amount, change.to]), [[28, 12]], "8d6 averages 28 on a failed save");
  const shield = await previewAction(applyActionTemplate({}, "reaction", {fallbackId: "action:shield"}));
  assert.deepEqual(shield.effects.map(effect => effect.effect), ["Shield"]);
  assert.deepEqual(shield.payments.map(payment => payment.resource), ["economy.reaction"]);
});
