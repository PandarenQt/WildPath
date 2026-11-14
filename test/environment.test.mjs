import {test} from "node:test";
import assert from "node:assert/strict";
import {environmentContext} from "../module/adapters/foundry-v14-environment.mjs";

/** A Region over x 1000-1199 whose band is `bottom` to `top` (open when unset), tagged `environment`. */
const region = (environment, {bottom=-Infinity, top=Infinity}={}) => ({flags: {wildpath: {environment}},
  testPoint: ({x, elevation}) => (x >= 1000) && (x < 1200) && (elevation >= bottom) && (elevation <= top)});
/** A Token at `x` (100-px grid, center 50 px in) and `elevation` on a Scene with these flags and Regions. */
const token = ({x=1000, elevation=0, flags={}, regions=[]}={}) => ({x, y: 1000, width: 1, height: 1, elevation,
  parent: {flags, grid: {size: 100}, regions}});

test("environment: a Scene's tags, a tagged Region holding the Token at its elevation, and nothing elsewhere", () => {
  assert.deepEqual(environmentContext(token({flags: {wildpath: {environment: {water: true}}}})), {environment: {water: true}},
    "an underwater Scene");
  assert.deepEqual(environmentContext(token({regions: [region({water: true})]})), {environment: {water: true}}, "a lake");
  assert.deepEqual(environmentContext(token({regions: [region({water: true}, {top: -10})]})), {},
    "a Region whose band is below the Token is not around it");
  assert.deepEqual(environmentContext(token({x: 2000, regions: [region({water: true})]})), {}, "beside every Region");
  assert.deepEqual(environmentContext(token({regions: [region({water: true, runningWater: true})]})),
    {environment: {water: true, runningWater: true}}, "a river: running water is water too");
  assert.deepEqual(environmentContext(token({regions: [region({water: false, runningWater: true})]})),
    {environment: {runningWater: true, water: true}}, "a river with Water unticked is still water");
  assert.deepEqual(environmentContext(token({flags: {wildpath: {environment: {runningWater: true}}}})),
    {environment: {runningWater: true, water: true}}, "a Scene tagged running water alone is water");
  assert.deepEqual(environmentContext(token({flags: {wildpath: {environment: {water: true}}}, regions: [region({water: false, lava: true})]})),
    {environment: {water: true, lava: true}}, "an unticked box does not untag the Scene; any tag works");
  assert.deepEqual(environmentContext(null), {});
});

test("environment: an untagged Region (a lasting area) is never tested", () => {
  let tested = false;
  const area = {flags: {wildpath: {area: {}}}, testPoint: () => (tested = true)};
  assert.deepEqual(environmentContext(token({regions: [area]})), {});
  assert.equal(tested, false);
});

test("environment: a Token mid-move is in the place it was moved to (its source), not where its animation has reached", () => {
  const moving = {...token({x: 2000, regions: [region({water: true})]}), _source: {x: 1000, y: 1000, width: 1, height: 1, elevation: 0}};
  assert.deepEqual(environmentContext(moving), {environment: {water: true}});
});
