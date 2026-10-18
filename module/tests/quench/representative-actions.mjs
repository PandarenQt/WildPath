import {useQuenchFixtures} from "./fixtures.mjs";
import {buildFoundryActionUseIntent} from "../../resolvers/foundry-multiplayer-runtime.mjs";
import {REPRESENTATIVE_ATTACK_MODIFIER, REPRESENTATIVE_DEFINITIONS, SPELL_SLOT_POOLS}
  from "../../../docs/development/representative-live-qa.mjs";

/**
 * The representative mechanic set (CODEX §28: one of each before volume) through the real runtime,
 * real Documents and the real digital RollProvider, on one GM client. Player routing of the same
 * definitions is the Level-5 gate in docs/development/representative-live-qa.md.
 */
export function registerRepresentativeActionTests(quench) {
  quench.registerBatch("wildpath.representative-actions", context => {
    const {describe,it,assert,beforeEach,afterEach} = context;
    describe("Representative Actions through the real runtime (single GM client)", function () {
      this.timeout(30000);
      const fixtures = useQuenchFixtures({beforeEach,afterEach});
      const resolutionIds = [];
      beforeEach(function () { resolutionIds.length = 0; });
      afterEach(async function () {
        const cards = game.messages.filter(message => resolutionIds.includes(message.getFlag("wildpath","resolutionId")));
        if (cards.length) await ChatMessage.deleteDocuments(cards.map(message => message.id));
      });

      async function useAction({definition, ac=1, grid={}, targetCell=[2,1], sourceSystem={}, targetHealth=30,
        configuration=null, prepare=null}) {
        const scene = await fixtures.createScene({name:"Representative",grid});
        const size = scene.grid.size;
        const sourceBase = await fixtures.createActor({name:"Source",system:foundry.utils.mergeObject(
          {resources:{action:{base:1,value:1},bonus:{base:1,value:1}}},structuredClone(sourceSystem))});
        const targetBase = await fixtures.createActor({name:"Target",
          system:{resources:{health:{base:30,value:targetHealth}}}});
        const source = await fixtures.createToken(scene,sourceBase,{name:"Source",x:size,y:size});
        const target = await fixtures.createToken(scene,targetBase,{name:"Target",
          x:targetCell[0] * size,y:targetCell[1] * size});
        await target.actor.update({"system.defenses.ac.value":ac});
        const prepared = prepare ? await prepare({scene,target,size}) : null;
        const [action] = await source.actor.createEmbeddedDocuments("Item",[{name:definition.label,type:"action",
          system:{active:true,modifiers:[structuredClone(REPRESENTATIVE_ATTACK_MODIFIER)],definition}}]);
        const built = buildFoundryActionUseIntent({actor:source.actor,action,game});
        const declared = await game.wildpath.executeActionIntent({...built.intent,
          ...(configuration ? {configuration} : {}),
          targetRefs:[{actorRef:target.actor.uuid,actorId:target.actor.id,tokenId:target.id,sceneId:scene.id}]});
        assert.equal(declared.ok,true,JSON.stringify(declared));
        resolutionIds.push(declared.resolutionId);
        const coordinator = game.wildpath.multiplayer.coordinator;
        // The card is posted after the result is stored; wait for both so cleanup can find the card.
        const card = () => game.messages.find(message => message.getFlag("wildpath","resolutionId") === declared.resolutionId);
        for (let i = 0; i < 150 && !(coordinator.getResult(declared.resolutionId) && card()); i++) {
          await new Promise(resolve => setTimeout(resolve,100));
        }
        const record = coordinator.getRecord(declared.resolutionId);
        const result = coordinator.getResult(declared.resolutionId);
        assert.equal(record?.state?.status,"completed",JSON.stringify(record?.state?.errors ?? coordinator.errors.at(-1)));
        const roll = kind => result.rolls.find(entry => entry.type?.includes(kind))?.rollResult ?? null;
        const conditions = () => target.actor.effects.filter(effect => effect.type === "condition")
          .map(effect => effect.system.type);
        return {record,result,source:source.actor,target:target.actor,roll,conditions,prepared};
      }

      it("a melee attack with dice damage commits exactly the rolled damage", async function () {
        const {source,target,roll} = await useAction({definition:REPRESENTATIVE_DEFINITIONS.meleeDice()});
        const damage = roll("damage");
        assert.exists(damage,"a dice damage component requests a real damage roll");
        assert.isAtLeast(damage.total,1);
        assert.isAtMost(damage.total,8);
        assert.equal(target.system.resources.health.value,30 - damage.total);
        assert.equal(source.system.resources.action.value,0);
      });

      it("a ranged attack resolves its normal and long range bands", async function () {
        const grid = {size:50};
        const near = await useAction({definition:REPRESENTATIVE_DEFINITIONS.ranged(),grid,targetCell:[10,1]});
        assert.equal(near.record.state.results.rangeResolution.checks[0].band,"normal");
        assert.equal(near.record.state.results.rangeResolution.checks[0].distance,45);
        const far = await useAction({definition:REPRESENTATIVE_DEFINITIONS.ranged(),grid,targetCell:[19,1]});
        assert.equal(far.record.state.results.rangeResolution.checks[0].band,"long");
        assert.equal(far.record.state.results.rangeResolution.checks[0].distance,90);
        assert.equal(far.target.system.resources.health.value,25);
      });

      it("a bonus-action strike spends the bonus action and leaves the action", async function () {
        const {source,target} = await useAction({definition:REPRESENTATIVE_DEFINITIONS.bonusStrike()});
        assert.equal(source.system.resources.bonus.value,0);
        assert.equal(source.system.resources.action.value,1);
        assert.equal(target.system.resources.health.value,27);
      });

      it("a trip applies Prone on a hit and nothing on a miss", async function () {
        const hit = await useAction({definition:REPRESENTATIVE_DEFINITIONS.trip(),ac:1});
        assert.deepEqual(hit.conditions(),["prone"]);
        assert.equal(hit.target.system.resources.health.value,30);
        const miss = await useAction({definition:REPRESENTATIVE_DEFINITIONS.trip(),ac:100});
        assert.deepEqual(miss.conditions(),[]);
        assert.equal(miss.source.system.resources.action.value,0,"a miss still pays");
      });

      it("a failed save takes full damage and is Poisoned; a successful save takes half and is not", async function () {
        const failed = await useAction({definition:REPRESENTATIVE_DEFINITIONS.saveForHalf(100)});
        const failedDamage = failed.roll("damage");
        assert.exists(failed.roll("sav"),"the target controller rolls the save");
        assert.equal(failed.target.system.resources.health.value,30 - failedDamage.total);
        assert.deepEqual(failed.conditions(),["poisoned"]);
        const saved = await useAction({definition:REPRESENTATIVE_DEFINITIONS.saveForHalf(-100)});
        const savedDamage = saved.roll("damage");
        assert.equal(saved.target.system.resources.health.value,30 - Math.floor(savedDamage.total / 2));
        assert.deepEqual(saved.conditions(),[]);
      });

      it("healing restores the constant amount", async function () {
        const {target,source} = await useAction({definition:REPRESENTATIVE_DEFINITIONS.healing(),targetHealth:10});
        assert.equal(target.system.resources.health.value,18);
        assert.equal(source.system.resources.action.value,0);
      });

      it("a damaged caster that fails its concentration check ends the effect it sustains", async function () {
        const definition = {...REPRESENTATIVE_DEFINITIONS.meleeDice(),
          damage:[{id:"blast",expression:{type:"constant",value:100},damageType:"force",provenance:"weapon-base"}]};
        const {record,target,prepared} = await useAction({definition,prepare:async ({scene,target,size}) => {
          const base = await fixtures.createActor({name:"Held",system:{resources:{health:{base:30,value:30}}}});
          const victim = await fixtures.createToken(scene,base,{name:"Held",x:5 * size,y:5 * size});
          await victim.actor.createEmbeddedDocuments("ActiveEffect",[{type:"condition",name:"Stunned",statuses:["stunned"],
            system:{type:"stunned"},flags:{wildpath:{conditionEffect:{conditionId:"stunned",
              concentration:{required:true,sourceRef:`token:${target.id}`,breakRemovesEffect:true}}}}}]);
          return {victim};
        }});
        // 100 damage makes the DC 50, which no d20 reaches: the check fails deterministically.
        const check = record.state.rollResults.find(entry => entry.type === "concentration-roll");
        assert.exists(check,"the damaged caster rolled a concentration check");
        assert.equal(record.state.results.concentrationResolution.checks.breakEvents.length,1);
        assert.equal(target.system.resources.health.value,0);
        assert.deepEqual(prepared.victim.actor.effects.filter(effect => effect.type === "condition").map(e => e.system.type),[],
          "the Stun it sustained ended with the damage");
      });

      it("a configuration choice scales the damage dice and spends the chosen slot", async function () {
        const {source,target,roll} = await useAction({definition:REPRESENTATIVE_DEFINITIONS.scaling(),
          sourceSystem:{pools:SPELL_SLOT_POOLS},
          configuration:{choices:{"casting-resource":{resourceId:"spell-slot.2"}}}});
        const damage = roll("damage");
        assert.equal(damage.dice?.reduce((count, die) => count + (die.results?.length ?? die.number ?? 1),0),3,
          "a second-level slot adds one die to 2d6");
        assert.equal(target.system.resources.health.value,30 - damage.total);
        const pools = Object.fromEntries(source.system.pools.filter(pool => pool.id.startsWith("spell-slot")).map(pool => [pool.id,pool.value]));
        assert.deepEqual(pools,{"spell-slot.1":1,"spell-slot.2":0});
      });
    });
  }, {displayName:"WILDPATH: Representative Actions",preSelected:false});
}
