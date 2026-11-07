import {test} from "node:test";
import assert from "node:assert/strict";
import {createFoundryTokenSize, resizedSquares} from "../module/adapters/foundry-v14-token-size.mjs";

test("a size larger or smaller is its squares on the size ladder", () => {
  assert.equal(resizedSquares(1, 1), 2, "Medium enlarged: Large");
  assert.equal(resizedSquares(1, 1, "small"), 1, "Small enlarged: Medium, still 1 square");
  assert.equal(resizedSquares(2, -1), 1, "Large reduced: Medium");
  assert.equal(resizedSquares(1, -2), 0.5, "Medium reduced twice: Tiny");
  assert.equal(resizedSquares(4, 1), 4, "nothing past Gargantuan");
});

test("Enlarge grows its creature's Tokens, on a Scene the GM is not viewing too, and they get their own size back when it ends", async () => {
  let steps = 1;
  const token = {id: "t1", width: 1, height: 1, flags: {}, async update(data) {
    Object.assign(this, {width: data.width, height: data.height});
    this.flags = {wildpath: {ownSize: data["flags.wildpath.ownSize"]}};
  }};
  // The GM's canvas shows another Scene (getActiveTokens finds none); its Token is on its own.
  const actor = {items: [], getStatistic: () => ({totalModifier: steps}), getActiveTokens: () => [], getDependentTokens: () => [token]};
  const size = createFoundryTokenSize({game: {user: {id: "gm"}, users: {activeGM: {id: "gm"}}}});
  await size.onEffectChanged({parent: actor});
  assert.deepEqual([token.width, token.height, token.flags.wildpath.ownSize], [2, 2, {width: 1, height: 1}]);
  steps = 0;
  await size.onEffectChanged({parent: actor});
  assert.deepEqual([token.width, token.height, token.flags.wildpath.ownSize], [1, 1, null]);
});
