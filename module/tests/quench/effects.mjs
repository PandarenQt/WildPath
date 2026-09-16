import {useQuenchFixtures} from "./fixtures.mjs";

export function registerEffectTests(quench) {
  quench.registerBatch("wildpath.effects", context => {
    const {describe,it,assert} = context;
    describe("Real WildPath ActiveEffects (GM)", function () {
      this.timeout(30000);
      const fixtures = useQuenchFixtures(context);
      const modifier = () => ({id:"quench-effect-health",label:"QA effect health",type:"untyped",
        domains:["resources.health.max"],value:4,enabled:true});
      function assertHealth(actor,total,boundary) {
        assert.equal(actor.getStatistic("resources.health.max").totalModifier,total,`${boundary}: Actor statistic contribution`);
        assert.equal(actor.getResource("health").max,10+total,`${boundary}: prepared health maximum`);
      }
      function persisted(actor,effect) {
        const document = game.actors.get(actor.id)?.effects.get(effect.id);
        assert.exists(document,"ActiveEffect must remain in the persisted Actor collection");
        return document;
      }

      it("creates, updates, and deletes a generic WildPath ActiveEffect", async function () {
        const [{default:Effect},{default:Model}] = await Promise.all([
          import("../../documents/active-effect.mjs"),import("../../data/active-effect/base.mjs")
        ]);
        const actor = await fixtures.createActor({name:"effect lifecycle"});
        const effect = await fixtures.createEffect(actor,{name:"generic lifecycle"});
        assert.strictEqual(CONFIG.ActiveEffect.documentClass,Effect,"ActiveEffect registration must use WildPathActiveEffect");
        assert.instanceOf(effect,foundry.documents.ActiveEffect,"Fixture must be a real ActiveEffect Document");
        assert.instanceOf(effect,Effect,"Generic effect must use the WildPath ActiveEffect class");
        assert.instanceOf(effect.system,Model,"Generic effect must use WildPathBaseEffect");
        assert.equal(effect.type,"effect","Generic effect must retain its non-reserved subtype");
        assert.strictEqual(effect.parent,actor,"ActiveEffect must retain its Actor parent");
        assert.strictEqual(persisted(actor,effect),effect,"ActiveEffect must belong to the Actor embedded collection");
        await effect.update({name:`${effect.name} updated`,disabled:true});
        const source = persisted(actor,effect).toObject(true);
        assert.include(source.name,"updated","ActiveEffect name update must persist");
        assert.isTrue(source.disabled,"ActiveEffect disabled update must persist");
        assert.deepEqual(actor.toObject(true).effects.find(entry => entry._id === effect.id),source,
          "Actor source must include the updated embedded ActiveEffect");
        await effect.delete();
        assert.notExists(actor.effects.get(effect.id),"Deleted ActiveEffect must leave the Actor collection");
        assert.isFalse(actor.toObject(true).effects.some(entry => entry._id === effect.id),
          "Deleted ActiveEffect must leave persisted Actor source");
      });

      it("disabling and re-enabling an ActiveEffect removes and restores its modifier", async function () {
        const actor = await fixtures.createActor({name:"effect enabled state"});
        assertHealth(actor,0,"Baseline");
        const effect = await fixtures.createEffect(actor,{system:{modifiers:[modifier()]}});
        const source = effect.toObject(true).system.modifiers;
        assertHealth(actor,4,"Enabled ActiveEffect");
        await effect.update({disabled:true});
        assert.isTrue(persisted(actor,effect).toObject(true).disabled,"Disabling must persist on the effect");
        assertHealth(actor,0,"Disabled ActiveEffect must stop contributing");
        await effect.update({disabled:false});
        assert.isFalse(persisted(actor,effect).toObject(true).disabled,"Re-enabling must persist on the effect");
        assertHealth(actor,4,"Re-enabled ActiveEffect must contribute exactly once");
        assert.deepEqual(effect.toObject(true).system.modifiers,source,"Enable changes must preserve clean modifier source");
      });

      it("an expired ActiveEffect is suppressed without contributing to Actor preparation", async function () {
        const actor = await fixtures.createActor({name:"effect suppression"});
        // V14's persisted duration.expired drives isSuppressed. Use an already-ended seconds
        // duration, without changing world time, invoking Combat, or overriding a runtime getter.
        const effect = await fixtures.createEffect(actor,{system:{modifiers:[modifier()]},
          start:{time:Math.floor(game.time.worldTime)-60},
          duration:{value:1,units:"seconds",expiry:null,expired:true}});
        assert.isTrue(persisted(actor,effect).toObject(true).duration.expired,"Expired status must persist in native duration data");
        assert.isFalse(effect.disabled,"Suppression case must not depend on the disabled flag");
        assert.isTrue(effect.isSuppressed,"V14 must suppress an explicitly expired finite effect");
        assertHealth(actor,0,"Suppressed ActiveEffect must not contribute");
        await effect.update({"duration.value":null,"duration.expired":false});
        assert.isFalse(effect.isSuppressed,"Clearing expiry with an indefinite duration must remove suppression");
        assertHealth(actor,4,"Unsuppressed ActiveEffect must restore its contribution");
      });

      it("deleting a modifier ActiveEffect restores the prepared resource baseline", async function () {
        const actor = await fixtures.createActor({name:"effect removal"});
        const source = actor.toObject(true).system.resources.health;
        assertHealth(actor,0,"Baseline");
        const effect = await fixtures.createEffect(actor,{system:{modifiers:[modifier()]}});
        assertHealth(actor,4,"Persisted modifier effect");
        await effect.delete();
        assert.notExists(actor.effects.get(effect.id),"Deleted modifier effect must leave no embedded orphan");
        assert.isFalse(actor.toObject(true).effects.some(entry => entry._id === effect.id),"Deleted modifier effect must leave Actor source");
        assertHealth(actor,0,"Deleting the ActiveEffect source must restore the baseline");
        assert.deepEqual(actor.toObject(true).system.resources.health,source,"Prepared modifier values must not leak into resource source");
      });
    });
  }, {displayName:"WILDPATH: Real Foundry ActiveEffects",preSelected:false});
}
