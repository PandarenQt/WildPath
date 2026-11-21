import {test} from "node:test";
import assert from "node:assert/strict";

// Foundry's Combat#nextTurn, recorded: WildPath's override runs the turn-end offers before it.
class FakeFoundryCombat {
  advanced = 0;
  async nextTurn() {
    this.advanced += 1;
    this.turn += 1;
    return this;
  }
}
const asked = [];
let answer = true;
globalThis.foundry = {documents: {Combat: FakeFoundryCombat}, applications: {api: {DialogV2: {confirm: async options => {
  asked.push(options.content);
  return typeof answer === "function" ? answer() : answer;
}}}}};
globalThis.game = {i18n: {localize: key => key, format: (key, data) => `${key} ${data.name} ${data.creature}`}};
const notices = [];
globalThis.ui = {notifications: {info: message => notices.push(message)}};

const {default: WildPathCombat} = await import("../module/documents/combat.mjs");
const {resolveActorResourcePayment} = await import("../module/resolvers/resource-resolver.mjs");

/**
 * A sidekick with a Bonus Action Assist offered as its turn ends, beside an unflagged Bonus Action. Its use only declares
 * the Action, as Item#use does: the Bonus Action is spent later, by the authority.
 */
function sidekick({bonus=1, isOwner=true, offered=true, active=true, policy}={}) {
  const used = [];
  const action = (id, flags) => ({id, type: "action", name: id, flags: {wildpath: flags}, system: {active,
    getActivationCost: () => ({allOf: [{capability: "bonus-action", amount: 1}]})},
  use: async () => { used.push(id); return true; }});
  const actor = {name: "Aide", isOwner, effects: [], used,
    // Actor#canUseAction, as Actor#resolveActionPayment plans it.
    canUseAction: (item, {policies}={}) => resolveActorResourcePayment({actorSystem: actor.system, cost: item.system.getActivationCost(),
      action: {tags: []}, policies}).ok,
    items: [action("Jab", {}), action("Ready Hand (Assist)", offered ? {turnEndOffer: true, reactionPolicy: policy} : {})],
    system: {resources: {action: {value: 1, max: 1}, bonus: {value: bonus, max: 1}, reaction: {value: 1, max: 1},
      movement: {value: 30, max: 30}}, pools: []}};
  return actor;
}
function combatOf(actor, {started=true}={}) {
  const combat = new WildPathCombat();
  Object.assign(combat, {round: 1, turn: 0, started, combatant: {actor}});
  return combat;
}

test("a turn-end offer: the owner ending the turn is asked, a yes uses the Action and holds the turn until it is ended again", async () => {
  asked.length = 0;
  notices.length = 0;
  answer = true;
  const actor = sidekick();
  const combat = combatOf(actor);
  await combat.nextTurn();
  assert.deepEqual([asked, actor.used, combat.advanced, notices],
    [["<p>WILDPATH.COMBAT.TurnEndOffer Ready Hand (Assist) Aide</p>"], ["Ready Hand (Assist)"], 0,
      ["WILDPATH.COMBAT.TurnEndOfferUsed Ready Hand (Assist) Aide"]], "only the flagged Action; its targets and cost come after use returns");
  // Resolved meanwhile, its Bonus Action spent: ending the turn again advances it without asking.
  actor.system.resources.bonus.value = 0;
  await combat.nextTurn();
  assert.deepEqual([asked.length, actor.used.length, combat.advanced], [1, 1, 1]);
  // Refused or cancelled meanwhile, its Bonus Action unspent: offered again.
  const again = sidekick();
  const second = combatOf(again);
  await second.nextTurn();
  answer = false;
  await second.nextTurn();
  assert.deepEqual([again.used.length, second.advanced], [1, 1]);
});

test("a turn-end offer follows its Always / Ask / Never setting, and a use refused before it is declared advances the turn", async () => {
  asked.length = 0;
  answer = true;
  const never = sidekick({policy: "never"});
  const skipped = combatOf(never);
  await skipped.nextTurn();
  assert.deepEqual([asked.length, never.used, skipped.advanced], [0, [], 1], "Never: not offered");
  const always = sidekick({policy: "always"});
  const automatic = combatOf(always);
  await automatic.nextTurn();
  assert.deepEqual([asked.length, always.used, automatic.advanced], [0, ["Ready Hand (Assist)"], 0], "Always: used without asking");
  const refused = sidekick();
  refused.items[1].use = async () => false;
  const declined = combatOf(refused);
  await declined.nextTurn();
  assert.deepEqual([asked.length, declined.advanced], [1, 1], "Item#use refused it (a choice cancelled): the turn advances");
});

test("a turn-end offer is not asked when its cost is spent, its Action inactive, the user not its owner, or outside a started combat", async () => {
  answer = true;
  // A spent Bonus Action: not offered, though the unspent Action could stand in for it (the project's rule).
  for ( const [actor, options] of [[sidekick({bonus: 0}), {}],[sidekick({active: false}), {}], [sidekick({isOwner: false}), {}],
    [sidekick({offered: false}), {}], [sidekick(), {started: false}]] ) {
    asked.length = 0;
    const combat = combatOf(actor, options);
    await combat.nextTurn();
    assert.deepEqual([asked.length, actor.used, combat.advanced], [0, [], 1], "nothing asked, the turn still advances");
  }
});

test("a declined or failed turn-end offer still advances once; a second click while asking does not advance twice", async () => {
  asked.length = 0;
  answer = false;
  const declined = combatOf(sidekick());
  await declined.nextTurn();
  assert.deepEqual([asked.length, declined.advanced], [1, 1]);
  // Failed: the turn advances all the same.
  const broken = sidekick();
  broken.items[1].use = async () => { throw new Error("no target"); };
  answer = true;
  const failing = combatOf(broken);
  const warn = console.warn;
  console.warn = () => {};
  try { await failing.nextTurn(); } finally { console.warn = warn; }
  assert.equal(failing.advanced, 1);
  // Two clicks while the first one's question is open: one advance.
  let release;
  answer = () => new Promise(resolve => { release = resolve; });
  const combat = combatOf(sidekick());
  const first = combat.nextTurn();
  await new Promise(resolve => setImmediate(resolve));
  await combat.nextTurn();
  release(false);
  await first;
  assert.equal(combat.advanced, 1);
  // Advanced meanwhile (another GM): not advanced again.
  answer = () => { moved.turn += 1; return false; };
  const moved = combatOf(sidekick());
  await moved.nextTurn();
  assert.deepEqual([moved.advanced, moved.turn], [0, 1]);
});
