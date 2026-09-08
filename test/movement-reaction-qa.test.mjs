import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import {createTokenGridFootprint} from "../module/helpers/grid-footprints.mjs";

const guide = readFileSync(new URL("../docs/development/movement-reaction-qa.md", import.meta.url), "utf8");
const starts = [...guide.matchAll(/```js\r?\n([\s\S]*?)```/g)].map(match => match[1])
  .filter(block => block.includes("const grid = canvas.grid"));

function routeFromBlock(block, grid, origin) {
  const start = block.indexOf("  const grid = canvas.grid");
  const end = block.indexOf("  qa.id =", start);
  return runInNewContext(`${block.slice(start, end)}; ({route, offset})`, {
    d: {toObject: () => origin}, canvas: {grid},
    qa: {require(value, reason) { if (!value) throw new Error(`STOP QA: ${reason}`); }}
  });
}

test("all fresh QA case blocks travel left deterministically with adjacent Large hex footprints", () => {
  assert.equal(starts.length, 3, "Decline, Accept, and Terminate each supply a complete fresh start");
  const hexSteps = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
  for ( const columns of [false, true] ) for ( const row of [0, 1] ) {
    const initial = {i: 4, j: row};
    const selected = [];
    const grid = {
      getOffset: () => initial,
      getCenterPoint: ({i: q, j: r}) => columns
        ? {x: 75 * q, y: 100 * (r + q / 2)} : {x: 100 * (q + r / 2), y: 75 * r},
      getAdjacentOffsets(offset) {
        selected.push(offset);
        return hexSteps.map(([q, r]) => ({i: offset.i + q, j: offset.j + r}));
      }
    };
    const origin = grid.getCenterPoint(initial);
    for ( const block of starts ) {
      selected.length = 0;
      const result = routeFromBlock(block, grid, origin);
      assert.ok(origin.x > result.route[0].x && result.route[0].x > result.route[1].x);
      const anchors = [...selected, result.offset];
      const footprints = anchors.map(({i: q, j: r}) => createTokenGridFootprint({topology: "hex", size: "large", anchor: {q, r}}));
      for ( let i = 1; i < anchors.length; i++ ) {
        assert.ok(hexSteps.some(([q, r]) => anchors[i].i - anchors[i - 1].i === q && anchors[i].j - anchors[i - 1].j === r));
        const from = footprints[i - 1].fieldKeys, to = footprints[i].fieldKeys;
        assert.equal(from.length, 3);
        assert.equal(to.length, 3);
        assert.equal(from.filter(key => !to.includes(key)).length, 2);
        assert.equal(to.filter(key => !from.includes(key)).length, 2);
        assert.equal(from.filter(key => to.includes(key)).length, 1);
      }
      const reversed = {...grid, getAdjacentOffsets: offset => grid.getAdjacentOffsets(offset).reverse()};
      assert.equal(JSON.stringify(routeFromBlock(block, reversed, origin).route), JSON.stringify(result.route));
    }
  }
});

test("QA square routes decrease X and stop explicitly if no leftward adjacency exists", () => {
  const grid = {getOffset: () => ({i: 4, j: 2}), getCenterPoint: ({i, j}) => ({x: i * 50, y: j * 50}),
    getAdjacentOffsets: ({i, j}) => [{i: i + 1, j}, {i: i - 1, j}, {i, j: j - 1}, {i, j: j + 1}]};
  for ( const block of starts ) {
    const {route} = routeFromBlock(block, grid, {x: 200, y: 100});
    assert.equal(JSON.stringify(route), JSON.stringify([{x: 150, y: 100}, {x: 100, y: 100}]));
    assert.throws(() => routeFromBlock(block, {...grid, getAdjacentOffsets: () => []}, {x: 200, y: 100}), /STOP QA/);
  }
});
