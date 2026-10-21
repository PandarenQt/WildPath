import {test} from "node:test";
import assert from "node:assert/strict";
import {COVER_BONUS, coverBetween} from "../module/adapters/foundry-v14-cover.mjs";
import {createResolutionCardViewModel} from "../module/helpers/chat-card-view-model.mjs";

// A square grid of 100 px; walls are segments a line must cross to be blocked.
const scene = (walls=[], extra=[]) => {
  const s = {grid: {getVertices: ({i, j}) => [{x: j * 100, y: i * 100}, {x: j * 100 + 100, y: i * 100}, {x: j * 100 + 100, y: i * 100 + 100},
    {x: j * 100, y: i * 100 + 100}]}, tokens: []};
  s.walls = walls;
  s.tokens.push(...extra.map(([id, i, j]) => token(s, id, i, j)));
  return s;
};
const token = (parent, id, i, j) => ({id, parent, getOccupiedGridSpaceOffsets: () => [{i, j}]});
const cross = (p, q, r, s) => {
  const d = (q.x - p.x) * (s.y - r.y) - (q.y - p.y) * (s.x - r.x);
  if ( !d ) return false;
  const t = ((r.x - p.x) * (s.y - r.y) - (r.y - p.y) * (s.x - r.x)) / d;
  const u = ((r.x - p.x) * (q.y - p.y) - (r.y - p.y) * (q.x - p.x)) / d;
  return (t > 0) && (t < 1) && (u >= 0) && (u <= 1);
};
const collidesIn = s => (a, b) => s.walls.some(([r, q]) => cross(a, b, r, q));
const cover = (walls, extra=[]) => {
  const s = scene(walls, extra);
  const attacker = token(s, "attacker", 0, 0);
  const target = token(s, "target", 0, 4);
  s.tokens.push(attacker, target);
  return coverBetween({source: attacker, target, collides: collidesIn(s)});
};

test("cover from walls: none, Half (at most half the lines), Three-Quarters, Total", () => {
  assert.equal(cover([]), "none");
  // A low wall across the top half of the target's near side: half of the lines to its corners.
  assert.equal(cover([[{x: 350, y: -50}, {x: 350, y: 50}]]), "half");
  // Three of the four lines to each target corner blocked, whichever corner the attacker uses (an arrow slit).
  const s = scene();
  const attacker = token(s, "attacker", 0, 0);
  const slit = token(s, "target", 0, 4);
  s.tokens.push(attacker, slit);
  assert.equal(coverBetween({source: attacker, target: slit, collides: (_a, b) => !((b.x > 450) && (b.y > 50))}), "threeQuarters");
  assert.equal(cover([[{x: 350, y: -500}, {x: 350, y: 600}]]), "total");
  assert.deepEqual([COVER_BONUS.half, COVER_BONUS.threeQuarters], [2, 5]);
});

test("a creature between them gives Half cover; one beside the line does not", () => {
  assert.equal(cover([], [["ally", 0, 2]]), "half");
  assert.equal(cover([], [["bystander", 3, 2]]), "none");
});

test("an area measures cover from its point of origin", () => {
  const s = scene([[{x: 350, y: -500}, {x: 350, y: 600}]]);
  const target = token(s, "target", 0, 4);
  s.tokens.push(target);
  assert.equal(coverBetween({origin: {x: 50, y: 50}, target, collides: collidesIn(s)}), "total");
  assert.equal(coverBetween({origin: {x: 450, y: 250}, target, collides: collidesIn(s)}), "none", "from the same side");
});

test("the card shows each target's cover", () => {
  const orc = {name: "Orc", tokenId: "orc", uuid: "Actor.orc", actorRef: "Actor.orc"};
  const view = createResolutionCardViewModel({targets: [orc], outcomes: {cover: [{target: {...orc}, degree: "half"}]}});
  assert.equal(view.targets[0].cover.label, "WILDPATH.COVER.half");
});

test("a cover condition is its creature's cover wherever it stands, unless the walls give more", async () => {
  const {actionCover} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const target = statuses => ({id: "t", parent: null, actor: {statuses: new Set(statuses)}});
  assert.equal(actionCover({definition: {}, sourceToken: {id: "s"}, targetToken: target(["coverTotal"])}), "total", "swallowed");
  assert.equal(actionCover({definition: {}, sourceToken: {id: "s"}, targetToken: target(["coverHalf"])}), "half");
  assert.equal(actionCover({definition: {}, sourceToken: {id: "s"}, targetToken: target([])}), "none");
  // The worm that swallowed it reaches it: the Total Cover it gave is against everything outside it.
  const worm = {uuid: "Actor.worm", id: "worm"};
  const swallowed = {id: "t", parent: null, actor: {statuses: new Set(["coverTotal"]), effects: [{statuses: new Set(["coverTotal"]),
    flags: {wildpath: {conditionEffect: {sourceRef: "Actor.worm"}}}}]}};
  assert.equal(actionCover({definition: {}, sourceToken: {id: "s", actor: worm}, targetToken: swallowed}), "none");
  assert.equal(actionCover({definition: {}, sourceToken: {id: "s", actor: {uuid: "Actor.other", id: "other"}}, targetToken: swallowed}), "total");
});
