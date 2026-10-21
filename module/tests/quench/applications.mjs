import {useQuenchFixtures} from "./fixtures.mjs";

/**
 * The applications a player or GM works with, in the real client: the ability-score dialog, Heroic Inspiration's
 * reroll button, the Rules Inspector, the Token ruler's warnings and the effect sheet's rules tab.
 */
export function registerApplicationTests(quench) {
  quench.registerBatch("wildpath.applications", context => {
    const {describe,it,assert} = context;
    describe("WildPath applications (GM)", function () {
      this.timeout(30000);
      const fixtures = useQuenchFixtures(context);
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      async function until(find, what) {
        for ( let tries = 0; tries < 40; tries++ ) {
          const found = find();
          if ( found ) return found;
          await wait(100);
        }
        throw new Error(`${what} did not appear`);
      }
      const set = (element, value) => {
        element.value = String(value);
        element.dispatchEvent(new Event("change", {bubbles:true}));
      };

      it("ability scores: OK only for a legal set, and the scores chosen are stored", async function () {
        const actor = await fixtures.createActor({name:"scores"});
        const {chooseAbilityScores} = await import("../../applications/ability-scores.mjs");
        const chosen = chooseAbilityScores(actor);
        const form = await until(() => document.querySelector(".application.dialog .ability-scores")?.closest("form"), "The dialog");
        const ok = form.querySelector('button[data-action="ok"]');
        assert.isFalse(ok.disabled,"the standard array, in order, is a legal set at once");
        set(form.querySelector('select[name="method"]'),"pointBuy");
        const buys = [...form.querySelectorAll("input[data-buy]")];
        [15,15,15,8,8,8].forEach((value, index) => set(buys[index], value));
        assert.isFalse(ok.disabled,"27 points");
        set(buys[3],9);
        assert.isTrue(ok.disabled,"28 points is over the budget");
        set(buys[3],8);
        ok.click();
        assert.isTrue(await chosen);
        assert.deepEqual(Object.keys(CONFIG.WILDPATH.ABILITIES).map(ability => actor.system.abilities[ability].value),[15,15,15,8,8,8]);
      });

      it("Heroic Inspiration: a sheet roll's reroll spends the point and marks the card used", async function () {
        const player = game.users.find(user => !user.isGM);
        if ( !player ) this.skip();
        const actor = await fixtures.createActor({name:"inspired"});
        await actor.update({ownership:{[player.id]:CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER}});
        const pools = actor.toObject(true).system.pools.map(pool => pool.id === "heroic-inspiration" ? {...pool,value:1} : pool);
        await actor.update({"system.pools":pools});
        const before = new Set(game.messages.map(message => message.id));
        try {
          const message = await ChatMessage.create({content:"roll",flags:{wildpath:{rollTest:{actorUuid:actor.uuid,ability:"might"}}}});
          const html = await message.renderHTML();
          const button = html.querySelector(".wildpath-inspiration-reroll");
          assert.exists(button,"a fresh sheet roll by a character with a point offers the reroll");
          button.click();
          await until(() => message.flags.wildpath.rollTest.rerolled, "The reroll");
          assert.equal(actor.system.pools.find(pool => pool.id === "heroic-inspiration").value,0,"the point is spent");
          await until(() => game.messages.some(entry => !before.has(entry.id) && (entry.id !== message.id)), "The new roll");
          assert.notExists((await message.renderHTML()).querySelector(".wildpath-inspiration-reroll"),"a used card offers no more");
        } finally {
          await ChatMessage.deleteDocuments(game.messages.filter(message => !before.has(message.id)).map(message => message.id));
        }
      });

      it("Rules Inspector: a resolution it no longer holds is said to be gone; a new one appears by itself", async function () {
        const records = game.wildpath?.multiplayer?.coordinator?.records;
        assert.exists(records,"the GM's coordinator keeps its records");
        const inspector = game.wildpath.inspect("quench-gone");
        try {
          await until(() => inspector.rendered && inspector.element.querySelector(".inspector-detail.hint"), "The unavailable note");
          records.set("quench-new",{resolutionId:"quench-new",state:{id:"quench-new",status:"completed",
            actionDefinition:{label:"Quench Strike"}}});
          inspector.selectedId = null;
          await until(() => [...inspector.element.querySelectorAll(".inspector-entry")].some(entry => entry.textContent.includes("Quench Strike")),
            "The new resolution");
        } finally {
          records.delete("quench-new");
          await inspector.close();
        }
      });

      it("Token ruler: leaving a hostile creature's reach warns of its Opportunity Attack while it has its Reaction", async function () {
        const scene = await fixtures.createScene({name:"ruler"});
        const hero = await fixtures.createActor({name:"ruler hero"});
        const foe = await fixtures.createActor({name:"ruler foe",type:"npc"});
        const mover = await fixtures.createToken(scene,hero,{name:"mover",x:500,y:500});
        const guard = await fixtures.createToken(scene,foe,{name:"guard",x:600,y:500});
        await mover.update({disposition:CONST.TOKEN_DISPOSITIONS.FRIENDLY});
        await guard.update({disposition:CONST.TOKEN_DISPOSITIONS.HOSTILE});
        const combat = await fixtures.createCombat(scene,[mover,guard]);
        await combat.startCombat();
        const ruler = Object.create(CONFIG.Token.rulerClass.prototype);
        Object.defineProperty(ruler,"token",{value:{document:mover,actor:mover.actor,getSnappedPosition:position => position}});
        const core = foundry.canvas.placeables.tokens.TokenRuler.prototype;
        const original = core._getWaypointLabelContext;
        core._getWaypointLabelContext = () => ({});
        try {
          const start = {x:500,y:500,previous:null,measurement:{cost:0}};
          const end = {x:100,y:500,previous:start,next:null,measurement:{cost:20}};
          const threats = () => ruler._getWaypointLabelContext(end,{}).wildpath.threats;
          assert.equal(threats().length,1,"the guard's Opportunity Attack");
          assert.include(threats()[0],guard.name);
          await guard.actor.update({"system.resources.reaction.value":0});
          assert.deepEqual(threats(),[],"no Reaction left, no warning");
        } finally {
          core._getWaypointLabelContext = original;
        }
      });

      it("effect sheet: rules with a problem are not saved, and stay on the tab with the problem in words", async function () {
        const actor = await fixtures.createActor({name:"effect sheet"});
        const [effect] = await actor.createEmbeddedDocuments("ActiveEffect",[{name:"blessing",type:"effect"}]);
        await effect.sheet.render({force:true});
        try {
          const json = await until(() => effect.sheet.element?.querySelector('textarea[name="wildpath.ruleElementsJson"]'), "The JSON editor");
          json.value = JSON.stringify([{schemaVersion:1,id:"nope",type:"Nope"}]);
          await effect.sheet.submit().catch(() => null);
          const issues = await until(() => {
            const shown = [...effect.sheet.element.querySelectorAll(".builder-issues li")].map(item => item.textContent);
            return shown.length ? shown : null;
          }, "The problems");
          assert.include(issues.join(" "),"Nope");
          assert.include(effect.sheet.element.querySelector('textarea[name="wildpath.ruleElementsJson"]').value,"Nope","what was typed stays");
          assert.lengthOf(effect.toObject(true).system.ruleElements,0,"nothing was saved");
        } finally {
          await effect.sheet.close();
        }
      });
    });
  }, {displayName:"WILDPATH: Applications",preSelected:false});
}
