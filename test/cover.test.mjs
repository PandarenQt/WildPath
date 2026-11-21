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

test("a creature on another plane than the target's gives no cover; one on its plane does", () => {
  const s = scene([], [["ghost", 0, 2]]);
  s.tokens[0].actor = {statuses: new Set(["ethereal"])};
  const [attacker, target] = [token(s, "attacker", 0, 0), token(s, "target", 0, 4)];
  s.tokens.push(attacker, target);
  assert.equal(coverBetween({source: attacker, target, collides: collidesIn(s)}), "none");
  target.actor = {statuses: new Set(["ethereal"])};
  assert.equal(coverBetween({source: attacker, target, collides: collidesIn(s)}), "half", "an ethereal target behind an ethereal creature");
});

test("an area measures cover from its point of origin", () => {
  const s = scene([[{x: 350, y: -500}, {x: 350, y: 600}]]);
  const target = token(s, "target", 0, 4);
  s.tokens.push(target);
  assert.equal(coverBetween({origin: {x: 50, y: 50}, target, collides: collidesIn(s)}), "total");
  assert.equal(coverBetween({origin: {x: 450, y: 250}, target, collides: collidesIn(s)}), "none", "from the same side");
});

test("the creature an area's origin is the centre of gives no cover; a creature between still does", () => {
  // A guardian at (0,2) carrying the area; the target at (0,4).
  const covered = extra => {
    const s = scene([], [["guardian", 0, 2], ...extra]);
    const target = token(s, "target", 0, 4);
    s.tokens.push(target);
    return coverBetween({origin: {x: 250, y: 50, tokenId: "guardian"}, target, collides: collidesIn(s)});
  };
  assert.equal(covered([]), "none");
  assert.equal(covered([["ally", 0, 3]]), "half");
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

test("an attacker's rules may ignore cover: the Wand of the War Mage's spell attacks ignore Half Cover, nothing more", async () => {
  const fs = await import("node:fs");
  const {actionCover} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const {evaluatePredicate} = await import("../module/helpers/predicates.mjs");
  const [rule] = JSON.parse(fs.readFileSync("packs/_source/srd-items/wand-of-the-war-mage-1-2-or-3-dmg1WandOfTheWar.json", "utf8"))
    .system.definition.enchant.effects[0].ruleElements.filter(entry => entry.id === "war-mage-cover");
  // The attacker's statistic: its rule counts when the Action's tags meet its predicate.
  const caster = {id: "s", actor: {getStatistic: (domain, {tags}) => ({totalModifier: ((domain === "cover.ignored")
    && evaluatePredicate(rule.predicate, {tags}).ok) ? rule.data.value : 0})}};
  const target = statuses => ({id: "t", parent: null, actor: {statuses: new Set(statuses)}});
  const bolt = {tags: ["spell"], attack: {type: "ranged"}};
  assert.deepEqual([actionCover({definition: bolt, sourceToken: caster, targetToken: target(["coverHalf"])}),
    actionCover({definition: bolt, sourceToken: caster, targetToken: target(["coverThreeQuarters"])}),
    actionCover({definition: {tags: ["spell"], save: {ability: "agility"}}, sourceToken: caster, targetToken: target(["coverHalf"])}),
    actionCover({definition: {attack: {type: "ranged"}}, sourceToken: caster, targetToken: target(["coverHalf"])})],
  ["none", "threeQuarters", "half", "half"], "a spell attack only; Three-Quarters Cover stays; a save and a weapon attack keep Half Cover");
});

test("Sharpshooter's ranged weapon attacks ignore Half and Three-Quarters Cover; its melee attacks don't", async () => {
  const {actionCover} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const {evaluatePredicate} = await import("../module/helpers/predicates.mjs");
  const rule = {predicate: {tagsAll: ["weapon", "ranged"]}, data: {value: 2}};
  const archer = {id: "s", actor: {getStatistic: (domain, {tags}) => ({totalModifier: evaluatePredicate(rule.predicate, {tags}).ok ? 2 : 0})}};
  const target = statuses => ({id: "t", parent: null, actor: {statuses: new Set(statuses)}});
  const bow = {attack: {type: "ranged", statistic: "weapon"}};
  const sword = {attack: {type: "melee", statistic: "weapon"}};
  assert.deepEqual([actionCover({definition: bow, sourceToken: archer, targetToken: target(["coverThreeQuarters"])}),
    actionCover({definition: bow, sourceToken: archer, targetToken: target(["coverTotal"])}),
    actionCover({definition: sword, sourceToken: archer, targetToken: target(["coverHalf"])})], ["none", "total", "half"]);
});

test("the least cover a creature has from its foes: walls between each foe and it, never an ally, a dead or a GM-hidden foe", async () => {
  const {coverFromFoes, placeContext} = await import("../module/adapters/foundry-v14-senses.mjs");
  const {commonAction} = await import("../module/helpers/common-actions.mjs");
  const {evaluatePredicate} = await import("../module/helpers/predicates.mjs");
  // A wall document blocking sight between columns 0 and 1 (the hider stands at column 4, past it).
  const wall = {c: [350, -500, 350, 600], sight: 20};
  const world = (walls, others) => {
    const s = {grid: {size: 100, getVertices: ({i, j}) => [{x: j * 100, y: i * 100}, {x: j * 100 + 100, y: i * 100},
      {x: j * 100 + 100, y: i * 100 + 100}, {x: j * 100, y: i * 100 + 100}]}, tokenVision: false, walls, tokens: []};
    const placed = (id, i, j, disposition, extra={}) => ({id, parent: s, x: j * 100, y: i * 100, width: 1, height: 1, disposition,
      actor: {statuses: new Set(extra.statuses ?? [])}, hidden: extra.hidden ?? false, getOccupiedGridSpaceOffsets: () => [{i, j}]});
    const hider = placed("hider", 0, 4, 1);
    s.tokens.push(hider, ...others.map(([id, i, j, disposition, extra]) => placed(id, i, j, disposition, extra)));
    return hider;
  };
  assert.equal(coverFromFoes(world([], [["ally", 0, 0, 1]])), null, "no foe on the Scene");
  assert.equal(coverFromFoes(world([], [["foe", 0, 0, -1]])), "none");
  assert.equal(coverFromFoes(world([wall], [["foe", 0, 0, -1]])), "total");
  assert.equal(coverFromFoes(world([wall], [["foe", 0, 0, -1], ["flanker", 3, 4, -1]])), "none", "the foe that sees it best decides");
  assert.equal(coverFromFoes(world([wall], [["foe", 0, 0, -1], ["corpse", 3, 4, -1, {statuses: ["dead"]}], ["lurker", 3, 4, -1, {hidden: true}]])),
    "total", "a dead foe and one the GM hides are left out");
  // The cover condition it holds counts as an attack from each foe counts it (an arrow slit the GM marks); walls if better.
  const slit = world([], [["foe", 0, 0, -1]]);
  slit.actor.statuses.add("coverThreeQuarters");
  assert.equal(coverFromFoes(slit), "threeQuarters");
  const walledSlit = world([wall], [["foe", 0, 0, -1]]);
  walledSlit.actor.statuses.add("coverHalf");
  assert.equal(coverFromFoes(walledSlit), "total", "the walls' Total Cover beats a held Half");
  // 2024 Hide's place requirement reads it, and Heavily Obscured beside it.
  const hide = commonAction({}, "hide").system.definition.requires;
  const hides = hider => evaluatePredicate(hide, placeContext(hider)).ok;
  assert.deepEqual([hides(world([], [["foe", 0, 0, -1]])), hides(world([wall], [["foe", 0, 0, -1]])), hides(world([], [])), hides(slit)],
    [false, true, true, true]);
  const dark = world([], [["foe", 0, 0, -1]]);
  dark.parent.tokenVision = true;
  assert.deepEqual([placeContext(dark).obscured, hides(dark)], ["heavily", true], "in darkness");
});
