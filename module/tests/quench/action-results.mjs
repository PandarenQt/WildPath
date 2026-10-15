import {useQuenchFixtures} from "./fixtures.mjs";
import {qaActionData} from "../../../docs/development/action-runtime-live-qa.mjs";
import {buildFoundryActionUseIntent} from "../../resolvers/foundry-multiplayer-runtime.mjs";

/**
 * Real-Foundry proof that a completed Action posts exactly one chat card, authored and whispered per the
 * initiator's `core.messageMode`, with public rolls attached. A single GM client is initiator and
 * authority; cross-client visibility is the Level-5 Action gate in docs/development/action-runtime-live-qa.md.
 */
export function registerActionResultTests(quench) {
  quench.registerBatch("wildpath.action-results", context => {
    const {describe,it,assert,beforeEach,afterEach} = context;
    describe("Action result chat cards in real Foundry V14 (single GM client)", function () {
      this.timeout(20000);
      const fixtures = useQuenchFixtures({beforeEach,afterEach});
      let savedMode = null;
      const resolutionIds = [];
      beforeEach(function () {
        savedMode = game.settings.get("core","messageMode");
        resolutionIds.length = 0;
      });
      afterEach(async function () {
        if (savedMode !== null) await game.settings.set("core","messageMode",savedMode);
        const cards = game.messages.filter(message => resolutionIds.includes(message.getFlag("wildpath","resolutionId")));
        // Core 14.369 logs "Cannot set properties of null (setting 'hidden')" from ChatLog#postNotification on any
        // message deletion while the chat sidebar is collapsed; plain core messages reproduce it. Not a test failure.
        if (cards.length) await ChatMessage.deleteDocuments(cards.map(message => message.id));
      });

      /** Declare the persisted QA melee Action against one adjacent unlinked target and return its cards. */
      async function useAction({mode, ac=1}) {
        await game.settings.set("core","messageMode",mode);
        const scene = await fixtures.createScene({name:"Action results"});
        const sourceBase = await fixtures.createActor({name:"Source",system:{resources:{action:{base:1,value:1}}}});
        const targetBase = await fixtures.createActor({name:"Concealed base name",
          system:{resources:{health:{base:30,value:30}}}});
        const source = await fixtures.createToken(scene,sourceBase,{name:"Source",x:100,y:100});
        const target = await fixtures.createToken(scene,targetBase,{name:"Masked target",x:200,y:100});
        await target.actor.update({"system.defenses.ac.value":ac});
        const [action] = await source.actor.createEmbeddedDocuments("Item",[qaActionData(foundry.utils.randomID())]);
        const built = buildFoundryActionUseIntent({actor:source.actor,action,game});
        assert.equal(built.ok,true);
        assert.equal(built.intent.messageMode,mode,"the intent carries the initiator's real core.messageMode");
        const declared = await game.wildpath.executeActionIntent({...built.intent,
          targetRefs:[{actorRef:target.actor.uuid,actorId:target.actor.id,tokenId:target.id,sceneId:scene.id}]});
        assert.equal(declared.ok,true,JSON.stringify(declared));
        resolutionIds.push(declared.resolutionId);
        const cards = () => game.messages.filter(message => message.getFlag("wildpath","resolutionId") === declared.resolutionId);
        for (let i = 0; i < 80 && !cards().length; i++) await new Promise(resolve => setTimeout(resolve,100));
        await new Promise(resolve => setTimeout(resolve,300)); // a duplicate card would arrive in this window
        const result = game.wildpath.multiplayer.coordinator.getResult(declared.resolutionId);
        return {cards:cards(),result,target};
      }

      const gmIds = () => game.users.filter(user => user.isGM).map(user => user.id).sort();

      it("a public Action posts one card authored by the initiator with the attack roll attached", async function () {
        const {cards,result} = await useAction({mode:"public"});
        assert.equal(cards.length,1,"exactly one card per completed Action");
        const [card] = cards;
        assert.equal(result?.status,"completed");
        assert.equal(card.author?.id,game.user.id);
        assert.deepEqual(card.whisper,[]);
        assert.equal(card.blind,false);
        assert.equal(card.rolls.length,1,"the public attack roll is attached for dice animation");
        const attack = result.rolls.find(roll => roll.type === "attack-roll");
        assert.equal(card.rolls[0].total,attack?.rollResult?.total,"the attached Roll is the validated attack roll");
        assert.include(card.content,"Masked target","targets are named by their Token");
        assert.notInclude(card.content,"Concealed base name","never by the base Actor behind the Token");
        assert.include(card.content,game.i18n.localize("WILDPATH.CHAT.Outcome.Hit"));
      });

      it("a gm-mode Action whispers its card to the GMs without rolls", async function () {
        const {cards} = await useAction({mode:"gm",ac:100});
        assert.equal(cards.length,1);
        assert.deepEqual([...cards[0].whisper].sort(),gmIds());
        assert.equal(cards[0].blind,false);
        assert.equal(cards[0].rolls.length,0,"a gm-only roll is never attached to the card");
        assert.include(cards[0].content,game.i18n.localize("WILDPATH.CHAT.Outcome.Miss"));
      });

      it("a blind Action posts a blind card to the GMs without rolls", async function () {
        const {cards} = await useAction({mode:"blind"});
        assert.equal(cards.length,1);
        assert.deepEqual([...cards[0].whisper].sort(),gmIds());
        assert.equal(cards[0].blind,true);
        assert.equal(cards[0].rolls.length,0);
      });
    });
  }, {displayName:"WILDPATH: Action Results",preSelected:false});
}
