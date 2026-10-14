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
      it("saving an Action's definition from its sheet replaces it whole, so a removed nested key is gone", async function () {
        const actor = await fixtures.createActor({name:"definition replace"});
        const definition = {schemaVersion:1,id:"action:quench-dagger",label:"Dagger",costs:{allOf:[{capability:"action",amount:1}]},
          attack:{type:"melee",statistic:"weapon",defenseKey:"ac",properties:["finesse"]},range:{type:"ranged",normal:{value:20},long:{value:60}}};
        const item = await fixtures.createItem(actor,{name:"Dagger",type:"action",system:{definition}});
        await item.sheet.render(true);
        try {
          const area = item.sheet.element.querySelector("textarea[name='wildpath.definitionJson']");
          const {properties:_finesse,...attack} = definition.attack;
          area.value = JSON.stringify({...definition,attack,range:{type:"reach",distance:{value:5}}});
          area.dispatchEvent(new Event("change",{bubbles:true}));
          for (let i = 0; (i < 40) && item.system.definition.attack?.properties; i++) await new Promise(r => setTimeout(r,50));
          const stored = item.toObject(true).system.definition;
          assert.notProperty(stored.attack,"properties","finesse was removed");
          assert.deepEqual(stored.range,{type:"reach",distance:{value:5}},"the old long range is gone");
        } finally { await item.sheet.close(); }
      });
      it("the Builder tab saves a changed field into the definition, and keeps a bad formula as a draft", async function () {
        const actor = await fixtures.createActor({name:"builder edit"});
        const definition = {schemaVersion:1,id:"action:quench-club",label:"Club",costs:{allOf:[{capability:"action",amount:1}]},
          targeting:{type:"single",required:true,count:1},range:{type:"reach",distance:{value:5,unit:"ft"}},
          attack:{type:"melee",statistic:"weapon",defenseKey:"ac"},
          damage:[{id:"club",expression:{type:"dice",number:1,faces:4},damageType:"bludgeoning",provenance:"weapon-base",metadata:{kept:true}}]};
        const item = await fixtures.createItem(actor,{name:"Club",type:"action",system:{definition}});
        await item.sheet.render(true);
        const wait = async test => { for (let i = 0; (i < 40) && !test(); i++) await new Promise(r => setTimeout(r,50)); };
        const input = () => item.sheet.element.querySelector("input[name='wildpath.builder.damage.0.formula']");
        try {
          assert.notInclude(item.sheet.element.textContent,"WILDPATH.","every label is localized");
          input().value = "1d6 + 1";
          input().dispatchEvent(new Event("change",{bubbles:true}));
          await wait(() => item.system.definition.damage[0].expression.type === "add");
          const stored = item.toObject(true).system.definition;
          assert.deepEqual(stored.damage[0].expression,{type:"add",terms:[{type:"dice",number:1,faces:6},{type:"constant",value:1}]});
          assert.deepEqual(stored.damage[0].metadata,{kept:true},"what the builder does not show survives");
          assert.deepEqual(stored.attack,definition.attack,"an untouched section is left alone");
          input().value = "1d6 + bananas";
          input().dispatchEvent(new Event("change",{bubbles:true}));
          await wait(() => input()?.getAttribute("aria-invalid") === "true");
          assert.equal(input().getAttribute("aria-invalid"),"true","the bad formula is marked");
          assert.equal(input().value,"1d6 + bananas","the draft is kept for fixing");
          assert.equal(item.system.definition.damage[0].expression.type,"add","nothing was saved");
        } finally { await item.sheet.close(); }
      });
      it("a blank Action takes a template from the Builder and gets an id", async function () {
        const actor = await fixtures.createActor({name:"builder template"});
        const item = await fixtures.createItem(actor,{name:"Flame Burst",type:"action"});
        await item.sheet.render(true);
        try {
          const element = item.sheet.element;
          element.querySelector(".template-choice").value = "areaSave";
          element.querySelector("[data-action='builderTemplate']").click();
          for (let i = 0; (i < 40) && !item.system.definition.save; i++) await new Promise(r => setTimeout(r,50));
          const stored = item.toObject(true).system.definition;
          assert.equal(stored.id,`action:${item.id}`,"a blank Action gets a stable id");
          assert.equal(stored.area.shape,"radial");
          assert.isTrue(item.system.getActionDefinition().ok,"the templated definition is valid");
        } finally { await item.sheet.close(); }
      });
      it("the Rules tab adds a rule as a row, and the row's amount changes the owner's AC", async function () {
        const actor = await fixtures.createActor({name:"rule rows"});
        const item = await fixtures.createItem(actor,{name:"Ring of Warding",type:"feature"});
        await item.sheet.render(true);
        const wait = async test => { for (let i = 0; (i < 40) && !test(); i++) await new Promise(r => setTimeout(r,50)); };
        try {
          assert.equal(item.sheet.tabGroups.sheet,"rules","a feature opens on its Rules tab");
          item.sheet.element.querySelector("[data-action='ruleAdd'][data-list='item']").click();
          await wait(() => item.system.ruleElements.length === 1);
          assert.equal(actor.getStatistic("defense.ac").totalModifier,1,"the new row is +1 AC");
          await wait(() => item.sheet.element.querySelector("input[name='wildpath.rules.0.amount']"));
          const amount = item.sheet.element.querySelector("input[name='wildpath.rules.0.amount']");
          amount.value = "2";
          amount.dispatchEvent(new Event("change",{bubbles:true}));
          await wait(() => actor.getStatistic("defense.ac").totalModifier === 2);
          assert.equal(actor.getStatistic("defense.ac").totalModifier,2,"the edited amount applies");
          assert.notInclude(item.sheet.element.textContent,"WILDPATH.","every label is localized");
        } finally { await item.sheet.close(); }
      });
      it("an effect's sheet edits its rules as rows and saves them", async function () {
        const actor = await fixtures.createActor({name:"effect rule rows"});
        const effect = await fixtures.createEffect(actor,{name:"Blessing"});
        await effect.sheet.render(true);
        const wait = async test => { for (let i = 0; (i < 40) && !test(); i++) await new Promise(r => setTimeout(r,50)); };
        try {
          effect.sheet.changeTab("ruleElements","sheet");
          effect.sheet.element.querySelector("[data-action='ruleAdd']").click();
          await wait(() => effect.system.ruleElements?.length === 1);
          assert.equal(effect.system.ruleElements[0].type,"Modifier","a row adds a valid rule");
          await wait(() => effect.sheet.element?.querySelector("select[name='wildpath.rules.0.appliesTo']"));
          effect.sheet.element.querySelector("select[name='wildpath.rules.0.appliesTo']").value = "save";
          await effect.sheet.submit();
          await wait(() => effect.system.ruleElements[0].data.domains[0] === "save");
          assert.deepEqual(effect.system.ruleElements[0].data.domains,["save"],"Save writes the changed row");
          assert.equal(actor.getStatistic("save").totalModifier,1,"the rule applies to saves");
        } finally { await effect.sheet.close(); }
      });
      it("the built-in Actions pack loads, and each of its Actions imports onto an Actor with a valid definition", async function () {
        const pack = game.packs.get("wildpath.actions");
        if (!pack) this.skip(); // The world loads a new pack only when it is launched again.
        const documents = await pack.getDocuments();
        assert.isAtLeast(documents.length,9,"The pack holds the built-in Actions");
        const actor = await fixtures.createActor({name:"pack import"});
        const imported = await actor.createEmbeddedDocuments("Item",documents.map(document => document.toObject()));
        for (const item of imported) {
          const definition = item.system.getActionDefinition();
          assert.isTrue(definition.ok,`${item.name}: ${JSON.stringify(definition.errors)}`);
          assert.equal(definition.definition.label,item.name);
        }
      });
    });
  }, {displayName:"WILDPATH: Real Foundry Documents",preSelected:false});
}
