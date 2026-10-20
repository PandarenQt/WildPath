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

      it("a RuleElement's own predicate sees the creature's conditions and the roll's tags", async function () {
        const actor = await fixtures.createActor({name:"conditional rules"});
        await fixtures.createItem(actor,{system:{ruleElements:[
          modifierRule({id:"while-prone",value:2,domains:["defense.ac"],predicate:{hasCondition:"prone"}}),
          modifierRule({id:"at-range",value:1,domains:["attack"],predicate:{tagsAny:["ranged"]}})
        ]}});
        assert.equal(actor.getStatistic("defense.ac").totalModifier,0,"not prone");
        await actor.toggleCondition("prone");
        assert.equal(actor.getStatistic("defense.ac").totalModifier,2,"prone: the rule applies");
        assert.equal(actor.getStatistic("attack",{tags:["melee"]}).totalModifier,0);
        assert.equal(actor.getStatistic("attack",{tags:["ranged"]}).totalModifier,1);
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

      it("GrantResistance on a feature and GrantImmunity on an effect form the Actor's damage profile", async function () {
        const actor = await fixtures.createActor({name:"damage profile"});
        assert.isNull(actor.getDamageProfile(),"Nothing granted: no profile");
        const item = await fixtures.createItem(actor,{system:{ruleElements:[{schemaVersion:1,id:"hide",
          type:"GrantResistance",data:{damageTypes:["slashing"]}}]}});
        await fixtures.createEffect(actor,{system:{ruleElements:[{schemaVersion:1,id:"ward",
          type:"GrantImmunity",data:{damageTypes:["poison"]}}]}});
        const profile = actor.getDamageProfile();
        assert.deepEqual(profile.resistances.map(entry => entry.damageTypes),[["slashing"]]);
        assert.deepEqual(profile.immunities.map(entry => entry.damageTypes),[["poison"]]);
        await item.update({"system.active":false});
        assert.deepEqual(actor.getDamageProfile().resistances,[],"An inactive Item grants nothing");
      });

      it("GrantResource gives its creature a pool to spend and recover, and an imported creature has it at once", async function () {
        const grant = {schemaVersion:1,id:"ki",type:"GrantResource",data:{resourceId:"ki",label:"Ki",maximum:2,recovery:"shortRest"}};
        const actor = await fixtures.createActor({name:"granted pool"});
        assert.isNull(actor.getResource("ki"),"No grant: no pool");
        const item = await fixtures.createItem(actor,{system:{ruleElements:[grant]}});
        for (let i = 0; (i < 40) && !actor.getResource("ki"); i++) await new Promise(resolve => setTimeout(resolve,50));
        assert.include(actor.getResource("ki"),{value:2,max:2,recovery:"shortRest"},"The grant's pool is stored full");
        await actor.spendResource("ki",2);
        assert.equal(actor.getResource("ki").value,0);
        await actor.rest("shortRest");
        assert.equal(actor.getResource("ki").value,2,"It recovers on its cadence");
        await item.update({"system.active":false});
        assert.equal(actor.getResource("ki").max,0,"Without its grant the pool holds nothing");
        const imported = await CONFIG.Actor.documentClass.create({name:"[WildPath Quench] granted import",type:"character",
          flags:{wildpath:{quenchFixture:true,quenchRunId:actor.getFlag("wildpath","quenchRunId")}},
          items:[{name:"Ki",type:"feature",system:{ruleElements:[grant]}}]});
        assert.include(imported.getResource("ki"),{value:2,max:2},"Created with the granting Item, the pool exists at once");
      });

      it("AbilityScore raises a score while its Item applies, and the creature's own score is never overwritten", async function () {
        const actor = await fixtures.createActor({name:"belted",system:{abilities:{might:{value:14},fortitude:{value:12}}}});
        const belt = await fixtures.createItem(actor,{name:"Belt of Giant Strength",type:"feature",system:{ruleElements:[
          {schemaVersion:1,id:"belt",type:"AbilityScore",data:{ability:"might",mode:"upgrade",value:21}},
          {schemaVersion:1,id:"stone",type:"AbilityScore",data:{ability:"fortitude",mode:"add",value:2,maximum:20}}]}});
        assert.deepEqual([actor.system.abilities.might.value,actor.system.abilities.might.base],[21,14],"Strength 21 from the Belt, 14 its own");
        assert.equal(actor.system.abilities.fortitude.value,14,"+2 from the stone");
        await actor.update({"system.abilities.fortitude.saveProficient":true});
        actor.prepareData();
        assert.deepEqual([actor.toObject(true).system.abilities.might.value,actor.system.abilities.might.value],[14,21],
          "an update and another preparation keep the stored 14 and apply the Belt once");
        await belt.delete();
        assert.deepEqual([actor.system.abilities.might.value,actor.system.abilities.fortitude.value],[14,12],"without the Item, its own scores");
      });

      it("GrantMovement gives a Speed, and movement stores what was spent so every mode counts it", async function () {
        const actor = await fixtures.createActor({name:"speeds"});
        assert.deepEqual({...actor.system.speeds},{walk:30},"Walking Speed is the movement maximum");
        const wings = await fixtures.createItem(actor,{system:{ruleElements:[{schemaVersion:1,id:"wings",type:"GrantMovement",
          data:{mode:"fly",distance:60}}]}});
        assert.deepEqual({...actor.system.speeds},{walk:30,fly:60});
        // Movement is tracked only in an encounter.
        await fixtures.startEncounter([actor]);
        await actor.update({"system.resources.movement.value":10});
        assert.equal(actor.system.resources.movement.spent,20,"Writing what remains stores what was spent");
        await wings.update({"system.active":false});
        assert.deepEqual({...actor.system.speeds},{walk:30},"An inactive grant gives no Speed");
      });

      it("a rule naming one weapon (Magic Weapon's weapon:<id>) reaches that weapon's attacks only", async function () {
        const actor = await fixtures.createActor({name:"enchanted"});
        const attack = (name,base) => ({name,type:"action",system:{definition:{schemaVersion:1,id:`action:${base}`,label:name,
          costs:{allOf:[]},targeting:{type:"single",required:true,count:1},range:{type:"reach",distance:{value:5,unit:"ft"}},
          attack:{type:"melee",statistic:"weapon",defenseKey:"ac",weapon:{base}},
          damage:[{id:"d",expression:{type:"dice",number:1,faces:8},damageType:"slashing",provenance:"weapon-base"}]}}});
        const [sword,dagger] = await actor.createEmbeddedDocuments("Item",[attack("Longsword","longsword"),attack("Dagger","dagger")]);
        const {actionCombatStatistics} = await import("/systems/wildpath/module/helpers/combat-statistics.mjs");
        const bonus = item => actionCombatStatistics(actor,item.system.definition,{item}).attack.modifierTotal;
        const [plainSword,plainDagger] = [bonus(sword),bonus(dagger)];
        await fixtures.createEffect(actor,{system:{ruleElements:[{schemaVersion:1,id:"magic-weapon",type:"Modifier",
          data:{domains:["attack"],modifierType:"untyped",value:2},predicate:{tagsAny:[`weapon:${sword.id}`]}}]}});
        assert.equal(bonus(sword),plainSword + 2,"the chosen weapon");
        assert.equal(bonus(dagger),plainDagger,"and not another");
      });

      it("Speed factors multiply every Speed (Haste, Slow) or one mode's, after its bonuses", async function () {
        const actor = await fixtures.createActor({name:"speed factors"});
        const factor = (id,domain,value) => ({schemaVersion:1,id,type:"Modifier",data:{domains:[domain],modifierType:"untyped",value}});
        await fixtures.createItem(actor,{system:{ruleElements:[{schemaVersion:1,id:"wings",type:"GrantMovement",data:{mode:"fly",distance:60}}]}});
        const haste = await fixtures.createEffect(actor,{system:{ruleElements:[factor("haste","speed.multiplier",2)]}});
        assert.deepEqual({...actor.system.speeds},{walk:60,fly:120},"Haste doubles every Speed");
        const slow = await fixtures.createEffect(actor,{system:{ruleElements:[factor("slow","speed.multiplier",0.5)]}});
        assert.deepEqual({...actor.system.speeds},{walk:30,fly:60},"and Slow halves them again");
        await haste.delete(); await slow.delete();
        await fixtures.createEffect(actor,{system:{ruleElements:[factor("carpet","speed.fly.multiplier",0.5)]}});
        assert.deepEqual({...actor.system.speeds},{walk:30,fly:30},"a factor on one mode leaves the others");
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
