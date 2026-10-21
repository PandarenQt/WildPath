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
    describe("Every surface in words (GM)", function () {
      this.timeout(60000);
      const fixtures = useQuenchFixtures(context);
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      // Raw keys a reader would see: in text and labels, or a tooltip key with no copy. The JSON editors show stored
      // data as it is, so they are left out.
      function rawKeys(root, where) {
        const copy = root.cloneNode(true);
        copy.querySelectorAll("textarea, .json-editor").forEach(element => element.remove());
        const found = [...(copy.textContent ?? "").matchAll(/\b(?:WILDPATH|TYPES)\.[A-Za-z][\w.]*/gu)].map(match => match[0]);
        for ( const element of copy.querySelectorAll("*") ) {
          for ( const name of ["title","aria-label","placeholder","alt"] ) {
            const value = element.getAttribute(name);
            if ( value && /\b(?:WILDPATH|TYPES)\./u.test(value) ) found.push(`${name}="${value}"`);
          }
          const tooltip = element.getAttribute("data-tooltip");
          if ( tooltip && /^WILDPATH\.[\w.]+$/u.test(tooltip) && !game.i18n.has(tooltip) ) found.push(`data-tooltip="${tooltip}"`);
          if ( (element.tagName === "INPUT") && /\b(?:WILDPATH|TYPES)\./u.test(element.value ?? "") ) found.push(`value="${element.value}"`);
        }
        return found.map(entry => `${where}: ${entry}`);
      }
      async function sheetKeys(document, where) {
        await document.sheet.render({force:true});
        await wait(300);
        const found = rawKeys(document.sheet.element, where);
        await document.sheet.close();
        return found;
      }
      const html = text => { const element = document.createElement("div"); element.innerHTML = text; return element; };

      it("sheets, the bar, the carousel and a resolution card show no raw lang keys", async function () {
        const {renderTemplate} = foundry.applications.handlebars;
        const hero = await fixtures.createActor({name:"surfaces hero"});
        const foe = await fixtures.createActor({name:"surfaces foe",type:"npc"});
        const types = ["feature","action","class","subclass","species","background","gear"];
        const items = await hero.createEmbeddedDocuments("Item",types.map(type => ({name:`surfaces ${type}`,type})));
        const [effect] = await hero.createEmbeddedDocuments("ActiveEffect",[{name:"surfaces effect",type:"effect"}]);
        const condition = await hero.toggleCondition("prone");
        const found = [...await sheetKeys(hero,"character sheet"),...await sheetKeys(foe,"NPC sheet")];
        for ( const item of items ) found.push(...await sheetKeys(item,`${item.type} sheet`));
        found.push(...await sheetKeys(effect,"effect sheet"),...await sheetKeys(condition,"condition sheet"));

        const {WildPathActionBar} = await import("../../applications/action-bar.mjs");
        const bar = new WildPathActionBar();
        Object.defineProperty(bar,"shownActor",{value:hero});
        found.push(...rawKeys(html(await renderTemplate("systems/wildpath/templates/hud/action-bar.hbs",await bar._prepareContext())),"action bar"));

        const combat = await fixtures.startEncounter([hero,foe]);
        const {combatCarouselContext} = await import("../../helpers/combat-carousel-context.mjs");
        found.push(...rawKeys(html(await renderTemplate("systems/wildpath/templates/hud/combat-carousel.hbs",{shown:true,
          ...combatCarouselContext({combat,isGM:true,conditions:Object.values(CONFIG.WILDPATH.CONDITIONS)})})),"carousel"));

        const {createResolutionCardViewModel} = await import("../../helpers/chat-card-view-model.mjs");
        const view = createResolutionCardViewModel({resolutionId:"surfaces",status:"completed",ok:true,
          action:{id:"strike",name:"Strike"},targets:[{id:"g",actorRef:"Actor.g",name:"Goblin"}],rolls:[],
          outcomes:{attack:{results:[{target:{actorRef:"Actor.g"},hit:true,critical:false}]},
            save:{results:[{target:{actorRef:"Actor.g"},success:false}]},damage:{results:[{target:{id:"g"},total:5}]}}});
        found.push(...rawKeys(html(await renderTemplate("systems/wildpath/templates/chat/resolution-card.hbs",
          {...view,actionImg:null,rollHtml:""})),"resolution card"));
        assert.deepEqual(found,[],"every surface shows words, not lang keys");
      });
    });
  }, {displayName:"WILDPATH: Foundry V14 Runtime Smoke",preSelected:false});
}
