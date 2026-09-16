import {useQuenchFixtures} from "./fixtures.mjs";
import {TURN_RECOVERY_CODES, getCombatTurnStartLifecycleEvents} from "../../helpers/combat.mjs";

const TURN_EVENT_TIMEOUT = 20000;

/**
 * On the active GM, Combat#_manageTurnEvents awaits the whole turn-event workflow, including
 * WildPathCombat#_onStartTurn and everything it awaits, before calling `combatTurnChange`. That
 * hook is therefore the completion signal for a real transition. Register it before advancing.
 */
function turnEventsSettled(combat) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      Hooks.off("combatTurnChange", id);
      reject(new Error(`combatTurnChange did not fire for Combat ${combat.id} within ${TURN_EVENT_TIMEOUT}ms`));
    }, TURN_EVENT_TIMEOUT);
    const id = Hooks.on("combatTurnChange", (changed, prior, current) => {
      if (changed.id !== combat.id) return;
      clearTimeout(timer);
      Hooks.off("combatTurnChange", id);
      resolve({prior, current});
    });
  });
}

async function transition(combat, advance) {
  const settled = turnEventsSettled(combat);
  await advance();
  return settled;
}

export function registerCombatTests(quench) {
  quench.registerBatch("wildpath.combat", context => {
    const {describe,it,assert} = context;
    describe("Real WildPath managed Combat turn start on an unlinked Token (GM)", function () {
      this.timeout(60000);
      const fixtures = useQuenchFixtures(context);

      async function encounter({name="combat", baseSystem={}}={}) {
        const base = await fixtures.createActor({name:`${name} base`,system:baseSystem});
        const scene = await fixtures.createScene({name});
        const token = await fixtures.createToken(scene, base, {name});
        const combat = await fixtures.createCombat(scene, [token]);
        const combatant = combat.combatants.find(entry => entry.tokenId === token.id);
        assert.exists(combatant,"Combat fixture must embed the Token's Combatant");
        return {base, scene, token, actor:token.actor, combat, combatant};
      }
      function liveToken({scene, token}) {
        const document = game.scenes.get(scene.id)?.tokens.get(token.id);
        assert.exists(document,"Fixture Token must remain persisted in its Scene");
        assert.exists(document.actor,"Persisted unlinked Token must still expose its synthetic Actor");
        return document;
      }
      function baseSource({base}) {
        const document = game.actors.get(base.id);
        assert.exists(document,"Base world Actor must remain persisted");
        return document.toObject(true).system;
      }
      const deltaSource = token => token.delta.toObject(true);
      const deltaValue = (token, path) => foundry.utils.getProperty(deltaSource(token), path);
      /**
       * startCombat is itself a real transition into round 1, turn 0 and already invokes
       * _onStartTurn once. Cases set their degraded pre-state afterwards so the recovery under
       * test is the one driven by Combat#nextTurn.
       */
      async function begin(enc) {
        const change = await transition(enc.combat, () => enc.combat.startCombat());
        assert.equal(enc.combat.round,1,"startCombat must reach round 1");
        assert.equal(enc.combat.turn,0,"startCombat must reach turn 0");
        assert.strictEqual(enc.combat.combatant,enc.combatant,"The fixture Combatant must hold the current turn");
        return change;
      }
      async function advance(enc) {
        const change = await transition(enc.combat, () => enc.combat.nextTurn());
        assert.equal(change.current.round,enc.combat.round,"combatTurnChange must report the committed round");
        assert.equal(enc.combat.round,2,"A single-Combatant nextTurn must wrap into round 2");
        assert.equal(enc.combat.turn,0,"The wrapped turn must return to the fixture Combatant");
        assert.strictEqual(enc.combat.combatant,enc.combatant,"The fixture Combatant must be the incoming Combatant");
        return change;
      }

      it("builds an unlinked Token whose synthetic Actor persists through ActorDelta independently of its base Actor", async function () {
        const enc = await encounter({name:"fixture"});
        const {base, token, actor, combat, combatant} = enc;
        assert.isFalse(token.actorLink,"Fixture Token must be unlinked");
        assert.isTrue(actor.isToken,"Synthetic Actor must report isToken");
        assert.notStrictEqual(actor,base,"Synthetic Actor must not be the base world Actor instance");
        assert.strictEqual(actor.parent,token,"Synthetic Actor parent must be its TokenDocument");
        assert.instanceOf(actor,CONFIG.Actor.documentClass,"Synthetic Actor must use WildPathActor");
        assert.instanceOf(token.delta,foundry.documents.ActorDelta,"Unlinked Token must own an ActorDelta");
        assert.equal(actor.id,base.id,"V14 synthetic Actors share the base Actor id");
        assert.notEqual(actor.uuid,base.uuid,"Synthetic and base Actors must have distinct UUIDs");
        assert.match(actor.uuid,/^Scene\..+\.Token\..+\.Actor\./u,"Synthetic UUID must be Token-scoped");
        assert.instanceOf(combat,CONFIG.Combat.documentClass,"Combat must use WildPathCombat");
        assert.lengthOf(combat.turns,1,"Combat fixture must contain exactly one turn");
        assert.strictEqual(combatant.token,token,"Combatant must resolve the fixture Token");
        assert.strictEqual(combatant.actor,actor,"Combatant must resolve the synthetic Actor, not the base Actor");
        assert.equal(combatant.actorId,base.id,"Combatant actorId must reference the base Actor id");
        assert.equal(actor.getResource("health").value,10,"Synthetic Actor must inherit the base schema default");
        const baseBefore = baseSource(enc).resources.health;
        await actor.update({"system.resources.health.value":7});
        const live = liveToken(enc);
        assert.equal(live.actor.toObject(true).system.resources.health.value,7,"Synthetic source must reflect the update");
        assert.equal(live.actor.getResource("health").value,7,"Synthetic update must survive preparation");
        assert.equal(deltaValue(live,"system.resources.health.value"),7,"The override must persist in the ActorDelta source");
        assert.deepEqual(baseSource(enc).resources.health,baseBefore,"Synthetic updates must not reach the base world Actor");
      });

      it("Combat#nextTurn restores built-in turn resources on the synthetic Actor through WildPathCombat#_onStartTurn", async function () {
        const enc = await encounter({name:"turn recovery",baseSystem:{resources:{action:{value:0},movement:{value:20}}}});
        await begin(enc);
        await enc.actor.update({"system.resources.action.value":0,"system.resources.bonus.value":0,
          "system.resources.reaction.value":0,"system.resources.movement.value":5});
        const pre = liveToken(enc).actor.toObject(true).system.resources;
        assert.deepEqual([pre.action.value,pre.bonus.value,pre.reaction.value,pre.movement.value],[0,0,0,5],
          "Degraded pre-state must persist on the synthetic Actor before the transition");
        assert.equal(baseSource(enc).resources.movement.value,20,"Base Actor keeps its own movement before the transition");
        await advance(enc);
        const live = liveToken(enc);
        for (const [id,maximum] of [["action",1],["bonus",1],["reaction",1],["movement",30]]) {
          assert.equal(live.actor.toObject(true).system.resources[id].value,maximum,`${id} must persist restored in synthetic source`);
          assert.equal(live.actor.getResource(id).value,maximum,`${id} must survive preparation`);
          assert.equal(live.actor.getResource(id).max,maximum,`${id} maximum must be unchanged by recovery`);
          assert.equal(deltaValue(live,`system.resources.${id}.value`),maximum,`${id} recovery must persist in the ActorDelta`);
        }
        const base = baseSource(enc).resources;
        assert.equal(base.movement.value,20,"Unlinked Token recovery must not mutate the base world Actor's movement");
        assert.equal(base.action.value,0,"Unlinked Token recovery must not mutate the base world Actor's action");
      });

      it("Combat#nextTurn restores a custom turn pool through the synthetic Actor's ActorDelta without disturbing its neighbor", async function () {
        const enc = await encounter({name:"custom pools"});
        await begin(enc);
        await enc.actor.update({"system.pools":[
          {id:"quench-neighbor",label:"QA neighbor",base:2,bonus:0,value:2,recovery:"none"},
          {id:"quench-turn",label:"QA turn pool",base:6,bonus:1,value:1,recovery:"turn"}
        ]});
        const before = liveToken(enc).actor.toObject(true).system.pools;
        assert.lengthOf(before,2,"Both custom pools must persist on the synthetic Actor");
        assert.equal(before[1].value,1,"Target pool must start below its maximum");
        assert.equal(enc.actor.getResource("quench-turn").max,7,"Target pool maximum must prepare from base and bonus");
        await advance(enc);
        const live = liveToken(enc);
        const after = live.actor.toObject(true).system.pools;
        assert.lengthOf(after,2,"Turn recovery must retain the full pool array");
        assert.deepEqual(after.map(pool => pool.id),before.map(pool => pool.id),"Turn recovery must preserve pool ordering");
        assert.deepEqual(after[0],before[0],"Neighboring non-turn pool must be untouched");
        assert.deepEqual(after[1],{...before[1],value:7},"Only the target pool value may change, without prepared fields");
        assert.equal(live.actor.getResource("quench-turn").value,7,"Restored pool value must survive preparation");
        assert.equal(live.actor.getResource("quench-turn").max,7,"Recovery must not inflate the pool maximum");
        const delta = deltaValue(live,"system.pools");
        assert.isArray(delta,"ActorDelta must carry the whole replaced pool array");
        assert.lengthOf(delta,2,"ActorDelta pool array must keep both entries");
        assert.equal(delta[0].id,"quench-neighbor","ActorDelta must preserve the neighbor at index 0");
        assert.equal(delta[1].value,7,"ActorDelta must persist the restored target value");
        assert.notProperty(delta[1],"modifierBonus","Prepared modifierBonus must never enter ActorDelta source");
        assert.deepEqual(baseSource(enc).pools,[],"Base world Actor must not receive the synthetic pools");
      });

      it("Combat#nextTurn leaves non-turn resources and pools unchanged", async function () {
        const enc = await encounter({name:"non-turn"});
        await begin(enc);
        await enc.actor.update({"system.resources.health.value":4,"system.resources.reaction.value":0,
          "system.pools":[{id:"quench-rest",label:"QA rest pool",base:3,bonus:0,value:0,recovery:"shortRest"}]});
        const before = liveToken(enc).actor.toObject(true).system;
        assert.equal(before.resources.health.value,4,"Health pre-state must persist");
        await advance(enc);
        const live = liveToken(enc);
        const after = live.actor.toObject(true).system;
        assert.equal(after.resources.health.value,4,"health (recovery none) must not be restored at turn start");
        assert.equal(live.actor.getResource("health").value,4,"Prepared health must match unchanged source");
        assert.deepEqual(after.pools,before.pools,"A shortRest pool must be untouched by turn recovery");
        assert.equal(live.actor.getResource("quench-rest").value,0,"Prepared shortRest pool must remain empty");
        assert.equal(after.resources.reaction.value,1,"reaction (recovery turn) must restore in the same transition");
      });

      it("Combat#nextTurn dispatches the persisted Bleeding turn-start Trigger exactly once on the synthetic Actor", async function () {
        const definition = CONFIG.WILDPATH.CONDITIONS.bleeding;
        const trigger = definition?.ruleElements?.find(rule => rule.type === "Trigger" && rule.data?.event === "turn.started");
        assert.exists(trigger,"Bleeding must currently define a turn.started Trigger RuleElement");
        const payload = trigger.data.payload;
        assert.equal(payload.type,"durabilityChange","Bleeding must currently use a durabilityChange payload");
        assert.equal(payload.changeType,"damage","Bleeding must currently deal damage");
        assert.equal(payload.resourceId,"health","Bleeding must currently target health");
        assert.equal(payload.amount?.type,"constant","This case reads the configured constant amount rather than hardcoding it");
        const damage = payload.amount.value;
        assert.isAbove(damage,0,"Configured Bleeding damage must be positive for this case to observe it");

        const enc = await encounter({name:"bleeding"});
        await begin(enc); // Round 1 starts without Bleeding, so the only dispatch under test is the nextTurn one.
        const effect = await enc.actor.toggleCondition("bleeding");
        assert.exists(effect,"Production condition API must apply Bleeding to the synthetic Actor");
        assert.strictEqual(effect.parent,enc.actor,"Bleeding effect must embed in the synthetic Actor");
        assert.lengthOf(effect.toObject(true).system.ruleElements,1,"Status conversion must persist the Bleeding Trigger");
        const health = liveToken(enc).actor.toObject(true).system.resources.health.value;
        assert.equal(liveToken(enc).actor.getResource("health").value,health,"Applying Bleeding must not itself deal damage");

        const observed = [];
        const hookId = Hooks.on("updateActor",(updated,changed) => {
          if (updated.uuid === enc.actor.uuid) observed.push(foundry.utils.deepClone(changed));
        });
        try {
          await advance(enc);
        } finally {
          Hooks.off("updateActor",hookId);
        }
        const live = liveToken(enc);
        const diagnostics = `synthetic Actor updates observed during the transition: ${JSON.stringify(observed)}`;
        assert.equal(live.actor.toObject(true).system.resources.health.value,health-damage,
          `Bleeding must deal exactly ${damage} once at turn start (not zero, not twice); ${diagnostics}`);
        assert.equal(live.actor.getResource("health").value,health-damage,"Prepared health must match the single dispatch");
        assert.equal(deltaValue(live,"system.resources.health.value"),health-damage,"The consequence must persist in the ActorDelta");
        assert.equal(baseSource(enc).resources.health.value,10,"Bleeding on the synthetic Actor must not damage the base world Actor");
        const persistedEffect = live.actor.effects.get(effect.id);
        assert.exists(persistedEffect,"Bleeding has no duration and must survive its own turn-start dispatch");
        assert.equal(persistedEffect.system.type,"bleeding","Surviving effect must still be the Bleeding condition");
        assert.equal(live.actor.getResource("action").value,1,"Recovery and trigger dispatch must occur in the same managed turn start");
      });

      it("Actor#startTurn rejects a stale turn context and a non-incoming Actor without mutating resources", async function () {
        const enc = await encounter({name:"guard",baseSystem:{resources:{action:{value:0}}}});
        await begin(enc);
        await enc.actor.update({"system.resources.action.value":0,"system.resources.movement.value":5});
        const live0 = liveToken(enc);
        const syntheticBefore = live0.actor.toObject(true).system.resources;
        const deltaBefore = deltaSource(live0);
        const baseBefore = baseSource(enc).resources;
        const {combat, combatant} = enc;
        const context = {round:combat.round,turn:combat.turn,skipped:false};
        const events = getCombatTurnStartLifecycleEvents(combat, combatant, context);

        const stale = await enc.actor.startTurn({combat,combatant,context:{...context,turn:context.turn+1},events});
        assert.equal(stale.ok,false,"A turn context that does not match the committed Combat must be rejected");
        assert.equal(stale.code,TURN_RECOVERY_CODES.INVALID_LIFECYCLE,"Stale context must report the production lifecycle code");

        const wrong = await enc.base.startTurn({combat,combatant,context,events});
        assert.equal(wrong.ok,false,"The base world Actor is not the incoming synthetic Combatant Actor");
        assert.equal(wrong.code,TURN_RECOVERY_CODES.ACTOR_NOT_INCOMING_COMBATANT,"Wrong Actor must report the production mismatch code");

        const live = liveToken(enc);
        assert.deepEqual(live.actor.toObject(true).system.resources,syntheticBefore,"Rejected recovery must not mutate synthetic source");
        assert.deepEqual(deltaSource(live),deltaBefore,"Rejected recovery must not write to the ActorDelta");
        assert.deepEqual(baseSource(enc).resources,baseBefore,"Rejected recovery must not mutate the base world Actor");
        assert.equal(live.actor.getResource("action").value,0,"Prepared action must remain degraded after rejection");
      });
    });
  }, {displayName:"WILDPATH: Real Foundry Combat",preSelected:false});
}
