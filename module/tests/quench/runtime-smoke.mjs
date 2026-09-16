import {useQuenchFixtures} from "./fixtures.mjs";

export function registerRuntimeSmokeTests(quench) {
  quench.registerBatch("wildpath.runtime-smoke", context => {
    const {describe,it,assert} = context;
    describe("Foundry V14 runtime", function () {
      it("runs inside Foundry V14 with WildPath active", function () {
        assert.exists(globalThis.foundry,"Foundry namespace should exist");
        assert.exists(globalThis.game,"Foundry game instance should exist");
        assert.instanceOf(game,foundry.Game,"game should be an instance of foundry.Game");
        assert.equal(game.system.id,"wildpath","WildPath should be the active system");
        assert.equal(game.release?.generation,14,"Quench Q1 targets Foundry generation 14");
      });
      it("registers the real WildPath Document classes and Actor/Item DataModels", async function () {
        // Import inside the test: registration itself neither needs Quench globals nor constructs Documents.
        const [actor,item,character,npc,feature,action,gear] = await Promise.all([
          import("../../documents/actor.mjs"),import("../../documents/item.mjs"),
          import("../../data/actor/character.mjs"),import("../../data/actor/npc.mjs"),
          import("../../data/item/feature.mjs"),import("../../data/item/action.mjs"),import("../../data/item/gear.mjs")
        ]);
        assert.strictEqual(CONFIG.Actor.documentClass,actor.default,"Actor registration must use WildPathActor itself");
        assert.strictEqual(CONFIG.Item.documentClass,item.default,"Item registration must use WildPathItem itself");
        assert.strictEqual(CONFIG.Actor.dataModels.character,character.default,"Character DataModel registration mismatch");
        assert.strictEqual(CONFIG.Actor.dataModels.npc,npc.default,"NPC DataModel registration mismatch");
        for (const [type,model] of [["feature",feature],["action",action],["gear",gear]]) {
          assert.strictEqual(CONFIG.Item.dataModels[type],model.default,`${type} Item DataModel registration mismatch`);
        }
      });
    });
    describe("Real Actor persistence (GM)", function () {
      this.timeout(30000);
      const fixtures = useQuenchFixtures(context);
      it("creates, updates, prepares, and deletes a WildPath Actor", async function () {
        const actor = await fixtures.createActor({name:"smoke"});
        const id = actor.id;
        assert.strictEqual(game.actors.get(id),actor,"Created Actor should exist in the world collection");
        assert.instanceOf(actor,foundry.documents.Actor,"Fixture should be a real Foundry Actor Document");
        assert.instanceOf(actor,CONFIG.Actor.documentClass,"Fixture should use the registered WildPath Actor class");
        assert.equal(actor.type,"character","Smoke fixture should be a character Actor");
        assert.equal(actor.system.resources.health.value,10,"Health should receive the schema default");
        assert.equal(actor.system.resources.movement.value,30,"Movement should receive the schema default");
        await actor.update({"system.resources.health.value":7});
        const persisted = game.actors.get(id);
        assert.exists(persisted,"Actor should remain persisted after resource update");
        assert.equal(persisted.toObject(true).system.resources.health.value,7,"Health update should reach source data");
        assert.equal(persisted.system.resources.health.value,7,"Health update should survive preparation");
        await persisted.delete();
        assert.notExists(game.actors.get(id),"Deleted Actor should be removed from the world collection");
      });
    });
  }, {displayName:"WILDPATH: Foundry V14 Runtime Smoke",preSelected:false});
}
