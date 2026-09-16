import {useQuenchFixtures} from "./fixtures.mjs";

export function registerDocumentTests(quench) {
  quench.registerBatch("wildpath.documents", context => {
    const {describe,it,assert} = context;
    describe("Real WildPath Documents (GM)", function () {
      this.timeout(30000);
      const fixtures = useQuenchFixtures(context);
      for (const [type,detail,value] of [["character","level",2],["npc","threat",3]]) {
        it(`persists a ${type} Actor with its real DataModel and schema defaults`, async function () {
          const {default:Model} = await import(`../../data/actor/${type}.mjs`);
          const actor = await fixtures.createActor({name:`${type} lifecycle`,type});
          assert.instanceOf(actor,CONFIG.Actor.documentClass,`${type} must use the real Actor class`);
          assert.instanceOf(actor.system,Model,`${type} must use its actual WildPath DataModel`);
          assert.equal(actor.type,type,"Actor type should survive creation");
          assert.equal(actor.system.details[detail],1,`${type} detail should receive its schema default`);
          assert.equal(actor.system.resources.health.max,10,`${type} health maximum should prepare correctly`);
          assert.equal(actor.system.resources.reaction.value,1,`${type} reaction should receive its schema default`);
          await actor.update({[`system.details.${detail}`]:value});
          const persisted = game.actors.get(actor.id);
          assert.exists(persisted,`${type} Actor should remain persisted after update`);
          assert.instanceOf(persisted.system,Model,"Preparation must retain the correct TypeDataModel");
          assert.equal(persisted.toObject(true).system.details[detail],value,"Actor detail update should persist in source");
          assert.equal(persisted.system.details[detail],value,"Actor detail update should survive preparation");
        });
      }
      for (const type of ["feature","action","gear"]) {
        it(`creates, updates, and deletes an embedded ${type} Item`, async function () {
          const {default:Model} = await import(`../../data/item/${type}.mjs`);
          const actor = await fixtures.createActor({name:`${type} owner`});
          const item = await fixtures.createItem(actor,{name:`${type} lifecycle`,type});
          assert.instanceOf(item,foundry.documents.Item,"Fixture must be a real embedded Item Document");
          assert.instanceOf(item,CONFIG.Item.documentClass,"Item should use WildPathItem");
          assert.instanceOf(item.system,Model,`${type} must use its actual WildPath DataModel`);
          assert.equal(item.type,type,"Embedded Item type should survive creation");
          assert.strictEqual(item.parent,actor,"Embedded Item should retain its Actor parent");
          assert.strictEqual(actor.items.get(item.id),item,"Item should appear in the Actor's embedded collection");
          assert.isTrue(item.system.active,"Embedded Item should receive the active schema default");
          await item.update({name:`${item.name} updated`,"system.active":false});
          const persisted = game.actors.get(actor.id)?.items.get(item.id);
          assert.exists(persisted,"Embedded Item should remain persisted after update");
          assert.strictEqual(persisted.parent,actor,"Item update must preserve the embedded parent");
          assert.include(persisted.toObject(true).name,"updated","Embedded Item name update should persist");
          assert.isFalse(persisted.toObject(true).system.active,"Embedded Item update should reach source data");
          assert.isFalse(persisted.system.active,"Embedded Item update should survive preparation");
          await persisted.delete();
          assert.notExists(actor.items.get(item.id),"Deleted embedded Item should leave the Actor collection");
          assert.isFalse(actor.toObject(true).items.some(source => source._id === item.id),
            "Deleted embedded Item should leave Actor source data");
        });
      }
      it("exports detached plain Actor and embedded Item source data", async function () {
        const actor = await fixtures.createActor({name:"source export"});
        const item = await fixtures.createItem(actor,{name:"source feature"});
        const source = actor.toObject(true), itemSource = item.toObject(true);
        for (const data of [source,itemSource]) {
          assert.strictEqual(Object.getPrototypeOf(data),Object.prototype,"Document source should be an ordinary object");
          assert.strictEqual(Object.getPrototypeOf(data.system),Object.prototype,"System source should not be a live DataModel");
          assert.deepEqual(JSON.parse(JSON.stringify(data)),data,"Source data should survive JSON serialization");
        }
        assert.equal(source.items[0]._id,item.id,"Actor source should include its embedded Item source");
        source.system.resources.health.value = 2;
        itemSource.system.active = false;
        assert.equal(actor.system.resources.health.value,10,"Editing an exported source must not mutate the Actor");
        assert.isTrue(item.system.active,"Editing an exported source must not mutate the embedded Item");
      });
    });
  }, {displayName:"WILDPATH: Real Foundry Documents",preSelected:false});
}
