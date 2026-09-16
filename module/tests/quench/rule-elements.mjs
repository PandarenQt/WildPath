import {useQuenchFixtures} from "./fixtures.mjs";

function modifierRule({id="quench-rule",value=4,domains=["resources.health.max"],predicate=null,
  priority=100,modifierType="untyped",enabled=true,suppressed=false}={}) {
  return {schemaVersion:1,id,type:"Modifier",key:"Modifier",label:`QA ${id}`,predicate,priority,
    enabled,suppressed,source:null,metadata:{suite:"quench-q2",provenance:{fixture:true}},
    data:{domains,modifierType,valueExpression:{type:"constant",value}}};
}

export function registerRuleElementTests(quench) {
  quench.registerBatch("wildpath.rule-elements", context => {
    const {describe,it,assert} = context;
    describe("Real WildPath RuleElements (GM)", function () {
      this.timeout(30000);
      const fixtures = useQuenchFixtures(context);
      function assertHealth(actor,total,boundary) {
        assert.equal(actor.getStatistic("resources.health.max").totalModifier,total,`${boundary}: statistic contribution`);
        assert.equal(actor.getResource("health").max,10+total,`${boundary}: prepared resource maximum`);
      }
      function assertSource(document,expected,boundary) {
        const rules = document.toObject(true).system.ruleElements;
        assert.deepEqual(rules,expected,`${boundary}: complete RuleElement source must persist without runtime fields`);
        assert.deepEqual(JSON.parse(JSON.stringify(rules)),rules,`${boundary}: persisted RuleElements must remain plain JSON data`);
        // The exported source must be detached even at nested RuleElement payloads.
        rules[0].data.valueExpression.value = 999;
        assert.deepEqual(document.toObject(true).system.ruleElements,expected,`${boundary}: editing an exported definition must not mutate source`);
      }

      it("Item Modifier RuleElements prepare once and follow activation and deletion", async function () {
        const actor = await fixtures.createActor({name:"Item RuleElement lifecycle"});
        const rule = modifierRule({id:"quench-item-rule"});
        const resourceSource = actor.toObject(true).system.resources.health;
        assertHealth(actor,0,"Baseline");
        const item = await fixtures.createItem(actor,{system:{ruleElements:[rule]}});
        assertHealth(actor,4,"Persisted Item Modifier RuleElement must contribute exactly once");
        assertSource(item,[rule],"Item creation");
        assert.equal(actor.getStatistic("resources.health.max").applied[0].source.parent.uuid,item.uuid,
          "Runtime modifier provenance must identify its actual embedded Item source");
        await actor.update({"system.status.turnsTaken":1});
        actor.prepareData();
        assertHealth(actor,4,"Repeated Item RuleElement preparation must not accumulate");
        await item.update({"system.active":false});
        assert.isFalse(item.toObject(true).system.active,"Item deactivation must use the persisted active field");
        assertHealth(actor,0,"Inactive Item must stop contributing its RuleElement");
        await item.update({"system.active":true});
        assert.isTrue(item.toObject(true).system.active,"Item activation must persist");
        assertHealth(actor,4,"Reactivated Item must restore its RuleElement");
        assertSource(item,[rule],"Item preparation and activation changes");
        await item.delete();
        assert.notExists(actor.items.get(item.id),"Deleted RuleElement Item must leave the embedded collection");
        assert.isFalse(actor.toObject(true).items.some(entry => entry._id === item.id),"Deleted RuleElement Item must leave Actor source");
        assertHealth(actor,0,"Deleting the Item source must restore the baseline statistic");
        assert.deepEqual(actor.toObject(true).system.resources.health,resourceSource,"Item RuleElement preparation must not pollute resource source");
      });

      it("ActiveEffect Modifier RuleElements follow disable, re-enable, and deletion", async function () {
        const actor = await fixtures.createActor({name:"effect RuleElement lifecycle"});
        const rule = modifierRule({id:"quench-effect-rule"});
        assertHealth(actor,0,"Baseline");
        const effect = await fixtures.createEffect(actor,{system:{ruleElements:[rule]}});
        assertHealth(actor,4,"Persisted ActiveEffect Modifier RuleElement must contribute");
        assertSource(effect,[rule],"ActiveEffect creation");
        assert.equal(actor.getStatistic("resources.health.max").applied[0].source.parent.uuid,effect.uuid,
          "Runtime modifier provenance must identify its actual ActiveEffect source");
        await effect.update({disabled:true});
        assert.isTrue(effect.toObject(true).disabled,"RuleElement source disable must persist");
        assertHealth(actor,0,"Disabled ActiveEffect must stop contributing its RuleElement");
        await effect.update({disabled:false});
        assert.isFalse(effect.toObject(true).disabled,"RuleElement source re-enable must persist");
        assertHealth(actor,4,"Re-enabled ActiveEffect must restore its RuleElement");
        assertSource(effect,[rule],"ActiveEffect enable changes");
        await effect.delete();
        assert.notExists(actor.effects.get(effect.id),"Deleted RuleElement effect must leave the embedded collection");
        assert.isFalse(actor.toObject(true).effects.some(entry => entry._id === effect.id),"Deleted RuleElement effect must leave Actor source");
        assertHealth(actor,0,"Deleting the ActiveEffect source must restore the baseline statistic");
      });

      it("repeated preparation preserves Item and ActiveEffect RuleElement source without accumulation", async function () {
        const actor = await fixtures.createActor({name:"RuleElement source integrity"});
        const predicate = {equals:{path:"actorSystem.details.level",value:1}};
        const itemRule = modifierRule({id:"quench-integrity-item",value:2,predicate,priority:20});
        const effectRule = modifierRule({id:"quench-integrity-effect",value:3,predicate,priority:30});
        const resourceSource = actor.toObject(true).system.resources.health;
        const item = await fixtures.createItem(actor,{system:{ruleElements:[itemRule]}});
        const effect = await fixtures.createEffect(actor,{system:{ruleElements:[effectRule]}});
        assertHealth(actor,5,"Combined persisted Item and ActiveEffect RuleElements");
        // All Documents belong to this disposable world Actor; no Tokens or native effect changes.
        for (const turnsTaken of [1,2]) {
          await actor.update({"system.status.turnsTaken":turnsTaken});
          actor.prepareData();
          actor.prepareData();
          assertHealth(actor,5,"Repeated preparation must not accumulate RuleElement contribution");
          assert.lengthOf(actor.getStatistic("resources.health.max").applied,2,"Each distinct source must contribute once");
          assertSource(item,[itemRule],"Item RuleElement source after preparation");
          assertSource(effect,[effectRule],"ActiveEffect RuleElement source after preparation");
          assert.deepEqual(actor.toObject(true).system.resources.health,resourceSource,
            "Prepared modifierBonus, maxima, and runtime contribution objects must not enter Actor source");
          assert.equal(actor.getResource("health").value,10,"Preparation must not refill current health");
        }
      });

      it("exact RuleElement domains contribute only to the matching Actor statistic", async function () {
        const actor = await fixtures.createActor({name:"RuleElement exact domains"});
        await fixtures.createItem(actor,{system:{ruleElements:[modifierRule({id:"quench-exact-item",value:2})]}});
        await fixtures.createEffect(actor,{system:{ruleElements:[modifierRule({id:"quench-exact-effect",value:3})]}});
        assertHealth(actor,5,"Exact health domain must collect both persisted sources");
        assert.equal(actor.getStatistic("resources.movement.max").totalModifier,0,"Exact health domain must not match movement");
        assert.equal(actor.getResource("movement").max,30,"Exact health RuleElements must not alter unrelated prepared resources");
      });

      it("the all wildcard RuleElement contributes to each requested resource domain", async function () {
        const actor = await fixtures.createActor({name:"RuleElement wildcard domains"});
        const rule = modifierRule({id:"quench-wildcard",value:2,domains:["all"]});
        const effect = await fixtures.createEffect(actor,{system:{ruleElements:[rule]}});
        assertSource(effect,[rule],"Wildcard domain persistence");
        assertHealth(actor,2,"Wildcard health domain");
        assert.equal(actor.getStatistic("resources.movement.max").totalModifier,2,"Supported all wildcard must also match movement");
        assert.equal(actor.getResource("movement").max,32,"Wildcard contribution must reach each prepared resource maximum");
        await effect.delete();
        assertHealth(actor,0,"Wildcard source deletion");
        assert.equal(actor.getResource("movement").max,30,"Deleting wildcard source must restore the other resource baseline");
      });

      it("a persisted RuleElement predicate follows real Actor level updates", async function () {
        const actor = await fixtures.createActor({name:"RuleElement predicate"});
        const rule = modifierRule({id:"quench-level-predicate",predicate:{equals:{path:"actorSystem.details.level",value:2}}});
        const item = await fixtures.createItem(actor,{system:{ruleElements:[rule]}});
        assertHealth(actor,0,"False predicate at level one must reject the contribution");
        await actor.update({"system.details.level":2});
        assert.equal(actor.toObject(true).system.details.level,2,"Predicate input must change through real Actor persistence");
        assertHealth(actor,4,"True predicate after persisted level update must contribute");
        await actor.update({"system.details.level":1});
        assertHealth(actor,0,"Predicate becoming false again must remove the prepared contribution");
        assertSource(item,[rule],"Predicate and metadata source after Actor updates");
      });

      it("persisted RuleElement priority selects the winner of equal typed bonuses", async function () {
        const actor = await fixtures.createActor({name:"RuleElement priority"});
        const rules = [modifierRule({id:"quench-priority-late",value:3,modifierType:"status",priority:200}),
          modifierRule({id:"quench-priority-early",value:3,modifierType:"status",priority:10})];
        const item = await fixtures.createItem(actor,{system:{ruleElements:rules}});
        assertSource(item,rules,"RuleElement priority persistence");
        assertHealth(actor,3,"Equal typed bonuses must not stack");
        assert.deepEqual(actor.getStatistic("resources.health.max").applied.map(entry => entry.id),[rules[1].id],
          "Lower numeric priority must win the existing equal-value typed stacking tie");
        const updated = item.toObject(true).system.ruleElements;
        updated[0].priority = 5;
        await item.update({"system.ruleElements":updated});
        assertSource(item,updated,"Changed RuleElement priority");
        assert.deepEqual(actor.getStatistic("resources.health.max").applied.map(entry => entry.id),[rules[0].id],
          "Persisting a new priority must change the applied source after real preparation");
        assertHealth(actor,3,"Changing the priority winner must preserve the typed total");
      });

      it("persisted RuleElement enabled and suppressed flags control contribution", async function () {
        const actor = await fixtures.createActor({name:"RuleElement flags"});
        let rule = modifierRule({id:"quench-rule-flags",enabled:false});
        const effect = await fixtures.createEffect(actor,{system:{ruleElements:[rule]}});
        assert.isFalse(effect.disabled,"The source effect must stay enabled while its RuleElement flags change");
        assertSource(effect,[rule],"Disabled RuleElement source");
        assertHealth(actor,0,"Disabled RuleElement must not contribute from an enabled effect");
        rule = {...rule,enabled:true,suppressed:true};
        await effect.update({"system.ruleElements":[rule]});
        assertSource(effect,[rule],"Suppressed RuleElement source");
        assertHealth(actor,0,"Suppressed RuleElement must not contribute from an enabled effect");
        rule = {...rule,suppressed:false};
        await effect.update({"system.ruleElements":[rule]});
        assertSource(effect,[rule],"Restored RuleElement source");
        assertHealth(actor,4,"Re-enabled unsuppressed RuleElement must contribute exactly once");
      });
    });
  }, {displayName:"WILDPATH: Real Foundry RuleElements",preSelected:false});
}
