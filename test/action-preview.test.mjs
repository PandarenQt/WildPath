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
