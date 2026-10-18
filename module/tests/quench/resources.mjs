import {useQuenchFixtures} from "./fixtures.mjs";

export function registerResourceTests(quench) {
  quench.registerBatch("wildpath.resources", context => {
    const {describe,it,assert} = context;
    describe("Real WildPath resources and preparation (GM)", function () {
      this.timeout(30000);
      const fixtures = useQuenchFixtures(context);
      function persistedActor(actor) {
        const persisted = game.actors.get(actor.id);
        assert.exists(persisted,"Actor should remain persisted after resource update");
        return persisted;
      }
      function assertBuiltin(actor,id,value) {
        const persisted = persistedActor(actor);
        assert.equal(persisted.toObject(true).system.resources[id].value,value,`${id} value should persist in Actor source`);
        assert.equal(persisted.getResource(id).value,value,`${id} value should survive Foundry preparation`);
      }

      it("looks up built-in resources and checks affordability without mutation", async function () {
        const actor = await fixtures.createActor({name:"resource lookup"});
        const before = actor.toObject(true);
        for (const [id,maximum] of [["health",10],["action",1],["bonus",1],["reaction",1],["movement",30]]) {
          const resource = actor.getResource(id);
          assert.exists(resource,`${id} should be available through the Actor API`);
          assert.equal(resource.max,maximum,`${id} should have its prepared default maximum`);
          assert.equal(resource.value,maximum,`${id} should have its default current value`);
        }
        assert.isNull(actor.getResource("quench-missing"),"Unknown resource lookup should return null");
        assert.isTrue(actor.canAfford({movement:30,reaction:1}),"Default resources should cover an affordable cost map");
        assert.isFalse(actor.canAfford({reaction:2}),"Affordability must reject insufficient resources");
        assert.isFalse(actor.canAfford({"quench-missing":1}),"Affordability must reject unknown resources");
        assert.deepEqual(actor.toObject(true),before,"Resource lookup and affordability must not persist mutations");
      });

      it("persists movement spending from 30 to 25", async function () {
        const actor = await fixtures.createActor({name:"movement resource"});
        assert.isTrue(await actor.spendResource("movement",5),"Affordable movement spend should succeed");
        assertBuiltin(actor,"movement",25);
        assert.equal(persistedActor(actor).getResource("movement").max,30,"Spending must not reduce the prepared maximum");
      });

      it("rejects an insufficient reaction spend without changing source or prepared value", async function () {
        const actor = await fixtures.createActor({name:"insufficient reaction"});
        const before = actor.toObject(true).system.resources;
        assert.isFalse(await actor.spendResource("reaction",2),"Spending two reactions from one must return false");
        assertBuiltin(actor,"reaction",1);
        assert.deepEqual(persistedActor(actor).toObject(true).system.resources,before,
          "Rejected reaction spend must leave every resource unchanged");
      });

      it("restores health with a negative spend and clamps to its prepared maximum", async function () {
        const actor = await fixtures.createActor({name:"restore clamp",
          system:{resources:{health:{base:12,bonus:3,value:5}}}});
        assert.equal(actor.getResource("health").max,15,"Prepared maximum should include the persisted manual bonus");
        assert.isTrue(await actor.spendResource("health",-100),"Negative spend should restore health");
        assertBuiltin(actor,"health",15);
        assert.equal(persistedActor(actor).getResource("health").max,15,"Restore must not inflate the maximum");
        // Source max is a schema field; preparation derives effective max from base/bonus.
        // This case asserts the supported spend API, not automatic persistence of derived max.
      });

      it("persists an affordable action and bonus spend together", async function () {
        const actor = await fixtures.createActor({name:"multi-resource success"});
        assert.isTrue(await actor.spendResources({action:1,bonus:1}),"Affordable multi-resource spending should succeed");
        assertBuiltin(actor,"action",0);
        assertBuiltin(actor,"bonus",0);
        assertBuiltin(actor,"reaction",1);
      });

      it("rejects an unaffordable multi-resource request without partial spending", async function () {
        const actor = await fixtures.createActor({name:"multi-resource rejection"});
        const before = actor.toObject(true).system.resources;
        assert.isFalse(await actor.spendResources({action:1,bonus:2,reaction:1}),
          "An unaffordable member must reject the entire multi-resource request");
        assertBuiltin(actor,"action",1);
        assertBuiltin(actor,"bonus",1);
        assertBuiltin(actor,"reaction",1);
        assert.deepEqual(persistedActor(actor).toObject(true).system.resources,before,
          "Unaffordable spend must not partially mutate any resource");
      });

      it("persists a custom pool spend at a nonzero array index without changing its neighbor", async function () {
        // A creature with no Heroic Inspiration pool (characters keep one), so only these two pools exist.
        const actor = await fixtures.createActor({name:"custom pools",type:"npc",system:{pools:[
          {id:"quench-reserve",label:"QA reserve",base:2,value:2,recovery:"none"},
          {id:"quench-focus",label:"QA focus",base:6,bonus:1,value:6,recovery:"shortRest"}
        ]}});
        const before = actor.toObject(true).system.pools;
        const preparedBefore = foundry.utils.deepClone(actor.system.pools);
        try {
          assert.lengthOf(before,2,"Both custom pools should persist in the ArrayField");
          assert.equal(actor.getResource("quench-focus").max,7,"Custom pool maximum should prepare from base and bonus");
          assert.isTrue(await actor.spendResource("quench-focus",2),"Custom pool spend should use the normal Actor API");
          const persisted = persistedActor(actor), pools = persisted.toObject(true).system.pools;
          assert.lengthOf(pools,2,"Custom spend must retain the full pool array");
          assert.deepEqual(pools[0],before[0],"Custom spend must not mutate the neighboring pool");
          assert.deepEqual(pools[1],{...before[1],value:4},"Custom spend must persist only the target pool value");
          assert.equal(persisted.getResource("quench-focus").value,4,"Custom pool value must survive preparation");
          assert.equal(persisted.getResource("quench-focus").max,7,"Spending must preserve the custom pool maximum");
        } catch (error) {
          const persisted = game.actors.get(actor.id) ?? actor;
          const after = persisted.toObject(true).system.pools;
          error.message += `\nCustom pool snapshot: ${JSON.stringify({before,after,preparedBefore,
            preparedAfter:persisted.system.pools,targetIndex:1,expectedTargetValue:4,
            expectedNeighbor:before[0],actualTarget:after?.[1],actualNeighbor:after?.[0]})}`;
          throw error;
        }
      });

      it("Action counters store what was spent, so an effect raising the available count is usable at once", async function () {
        const actor = await fixtures.createActor({name:"action counters"});
        await actor.update({"system.resources.action.value":0});
        assert.equal(actor.toObject(true).system.resources.action.spent,1,"spending the one Action stores spent 1");
        assert.equal(actor.getResource("action").value,0);
        const extra = await fixtures.createEffect(actor,{system:{modifiers:[{id:"quench-extra-action",
          domains:["resources.action.max"],label:"QA extra action",type:"untyped",value:1,enabled:true}]}});
        assert.deepEqual([actor.getResource("action").max,actor.getResource("action").value],[2,1],
          "available 2, spent 1: one Action remains immediately");
        await extra.delete();
        const slowed = await fixtures.createEffect(actor,{system:{modifiers:[{id:"quench-fewer-actions",
          domains:["resources.action.max"],label:"QA fewer actions",type:"untyped",value:-1,enabled:true}]}});
        assert.deepEqual([actor.getResource("action").max,actor.getResource("action").value],[0,0],"never below zero");
        await slowed.delete();
        await actor.update({"system.resources.action.value":actor.getResource("action").max});
        assert.deepEqual([actor.toObject(true).system.resources.action.spent,actor.getResource("action").value],[0,1],
          "turn recovery writes the maximum, which clears spent");
      });

      it("class records derive the level, original class and spell slots, creating the slot pools a caster needs", async function () {
        const wizard = {id:"wizard",name:"Wizard",level:3,original:true,subclasses:[],spellcasting:{progression:"full",ability:"int"}};
        const paladin = {id:"paladin",name:"Paladin",level:3,subclasses:["oath-a","oath-b"],spellcasting:{progression:"half",ability:"cha"}};
        const actor = await fixtures.createActor({name:"multiclass caster",system:{classes:[wizard,paladin]}});
        assert.equal(actor.system.details.level,6,"total level is the sum of class levels");
        assert.equal(actor.system.originalClass.id,"wizard");
        assert.deepEqual(actor.system.classes[1].subclasses,["oath-a","oath-b"],"a class keeps several subclasses");
        assert.equal(actor.system.spellcasting.casterLevel,5,"Wizard 3 + Paladin 3 (half, rounded up) = caster 5");
        const slots = id => actor.getResource(id);
        assert.deepEqual(["spell-slot.1","spell-slot.2","spell-slot.3"].map(id => [slots(id)?.max,slots(id)?.value]),
          [[4,4],[3,3],[2,2]],"slot pools were created full, with maxima from the 2024 table");
        assert.isNull(slots("spell-slot.4"),"no pool for a spell level the caster does not reach");
        await actor.update({"system.classes":[wizard,{...paladin,level:5},{id:"cleric",name:"Cleric",level:1,
          subclasses:[],spellcasting:{progression:"full",ability:"wis"}}]});
        assert.equal(actor.system.spellcasting.casterLevel,7,"3 + ceil(5/2) + 1 = 7");
        assert.deepEqual([slots("spell-slot.4")?.max,slots("spell-slot.4")?.value],[1,1],"levelling up adds the new slot pool");
        assert.equal(slots("spell-slot.3").max,3);
      });

      it("a transformation takes the form's physical abilities, AC and speed and its Actions, keeping the creature's own features", async function () {
        const creature = await fixtures.createActor({name:"shapeshifter",system:{abilities:{might:{value:8},intellect:{value:15}},
          defenses:{ac:{value:12}},resources:{movement:{base:30,value:30}}}});
        await fixtures.createItem(creature,{name:"warding feat",type:"feature",system:{active:true,modifiers:[{id:"qa-ward",
          domains:["defense.ac"],label:"QA ward",type:"untyped",value:1,enabled:true}]}});
        const beast = await fixtures.createActor({name:"bear form",system:{abilities:{might:{value:18},intellect:{value:2}},
          defenses:{ac:{value:13}},resources:{movement:{base:40,value:40}}}});
        await fixtures.createItem(beast,{name:"Bite",type:"action",system:{active:true,definition:{schemaVersion:1,id:"action:qa-bite",
          label:"Bite",costs:{allOf:[]},targeting:{type:"single",required:true,count:1},
          damage:[{id:"bite",expression:{type:"constant",value:5},damageType:"piercing"}]}}});
        const effect = await creature.transform(beast);
        assert.deepEqual([creature.system.abilities.might.value,creature.system.abilities.intellect.value],[18,15],
          "the form's Might, the creature's own Intellect");
        assert.deepEqual([creature.system.defenses.ac.value,creature.getStatistic("defense.ac").totalModifier],[13,1],
          "the form's Armor Class, plus the creature's own warding feat");
        assert.equal(creature.getResource("movement").max,40,"the form's speed");
        const bite = item => item.system.definition?.id === "action:qa-bite";
        assert.isTrue(creature.items.some(item => bite(item) && item.flags.wildpath?.transformedBy === effect.id),
          "the form's Bite is usable");
        await creature.revertTransformation();
        assert.deepEqual([creature.system.abilities.might.value,creature.system.defenses.ac.value,creature.getResource("movement").max],
          [8,12,30],"reverting restores the creature's own statistics");
        assert.isFalse(creature.items.some(bite),"and removes the form's Actions");
        assert.isNull(creature.transformation);
      });

      it("a companion's control follows its controllers: their Players own it, and lose it with their controller", async function () {
        const player = game.users.find(user => !user.isGM);
        if (!player) this.skip();
        const summoner = await fixtures.createActor({name:"summoner"});
        await summoner.update({[`ownership.${player.id}`]:3});
        const wolf = await fixtures.createActor({name:"wolf",type:"npc"});
        const owns = () => wolf.testUserPermission(player,"OWNER");
        assert.isFalse(owns());
        await wolf.setCompanion({controllers:[summoner],kind:"summon"});
        assert.deepEqual(wolf.system.companion.toObject?.() ?? {...wolf.system.companion},{kind:"summon",controllers:[summoner.uuid]});
        assert.isTrue(owns(),"The summoner's Player controls the summon");
        await wolf.setCompanion({controllers:[]});
        assert.isFalse(owns(),"Freed from its controller, the summon returns to the default ownership");
        const controllerCosts = {allOf:[{capability:"bonus-action",amount:1},{capability:"movement",amount:10}]};
        const bite = await fixtures.createItem(wolf,{name:"bite",type:"action",system:{definition:{schemaVersion:1,
          id:"action:qa-bite",label:"Bite",costs:{allOf:[]},controllerCosts}}});
        assert.deepEqual(bite.system.definition.controllerCosts,controllerCosts,"An Action Item stores its controller costs");
      });

      it("applies an Item maximum modifier once across repeated preparation and removes it on deletion", async function () {
        const actor = await fixtures.createActor({name:"modifier preparation",
          system:{resources:{health:{base:10,bonus:2,value:10}}}});
        const baseline = actor.getResource("health").max;
        assert.equal(baseline,12,"Baseline maximum should include the manual bonus");
        const sourceBefore = actor.toObject(true).system.resources.health;
        const item = await fixtures.createItem(actor,{name:"health maximum +4",type:"feature",system:{
          active:true,modifiers:[{id:"quench-health-max",domains:["resources.health.max"],
            label:"QA health maximum",type:"untyped",value:4,enabled:true}]
        }});
        assert.equal(actor.getStatistic("resources.health.max").totalModifier,4,"Embedded Item should contribute to the Actor statistic");
        assert.equal(actor.getResource("health").max,baseline+4,"Item creation should trigger the real Actor preparation cycle");
        // These harmless persisted updates exercise Foundry's normal reinitialization path.
        // Also repeat the public prepareData() on the same fixture to catch accumulation without
        // a source reset. This disposable world Actor has no Tokens or ActiveEffects to refresh.
        for (const turnsTaken of [1,2]) {
          await actor.update({"system.status.turnsTaken":turnsTaken});
          actor.prepareData();
          actor.prepareData();
          assert.equal(persistedActor(actor).getResource("health").max,baseline+4,
            "Repeated preparation must not accumulate modifierBonus or inflate the health maximum");
          assert.equal(actor.getResource("health").value,10,"Preparation must not refill the current resource value");
          assert.equal(actor.getResource("health").bonus,2,"Item modifiers must not accumulate into the manual bonus");
          assert.deepEqual(actor.toObject(true).system.resources.health,sourceBefore,
            "Derived modifier contributions must not leak into persisted resource source");
        }
        await item.delete();
        assert.equal(persistedActor(actor).getResource("health").max,baseline,"Deleting the modifier Item should restore the baseline maximum");
        assert.equal(actor.getStatistic("resources.health.max").totalModifier,0,"Deleted Item should leave the Actor statistic");
      });
    });
  }, {displayName:"WILDPATH: Real Foundry Resources",preSelected:false});
}
