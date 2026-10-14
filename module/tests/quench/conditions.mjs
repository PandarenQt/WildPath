import {useQuenchFixtures} from "./fixtures.mjs";
import {collectRuleElementContributions,serializeRuleElementDefinition} from "../../helpers/rule-elements.mjs";

export function registerConditionTests(quench) {
  quench.registerBatch("wildpath.conditions", context => {
    const {describe,it,assert} = context;
    describe("Real WildPath conditions (GM)", function () {
      this.timeout(30000);
      const fixtures = useQuenchFixtures(context);
      const conditions = (actor,id) => actor.effects.filter(effect => effect.type === "condition" && effect.system.type === id);
      function assertCondition(actor,effect,id) {
        assert.exists(effect,`${id}: production condition API must return a real effect`);
        assert.instanceOf(effect,CONFIG.ActiveEffect.documentClass,`${id}: condition must use the registered ActiveEffect class`);
        assert.strictEqual(game.actors.get(actor.id)?.effects.get(effect.id),effect,`${id}: condition must persist under the fixture Actor`);
        assert.strictEqual(effect.parent,actor,`${id}: condition must retain the correct parent`);
        const source = effect.toObject(true);
        assert.equal(source.type,"condition","Condition status conversion must persist the condition subtype");
        assert.equal(source.system.type,id,"Condition status conversion must persist system.type");
        assert.include(source.statuses,id,`${id}: Foundry status identity must persist`);
        assert.isTrue(actor.statuses.has(id),`${id}: Actor preparation must expose the active status`);
        return source;
      }
      function assertRemoved(actor,effect,id) {
        assert.lengthOf(conditions(actor,id),0,`${id}: removal must leave no condition effect`);
        assert.notExists(actor.effects.get(effect.id),`${id}: removal must leave no embedded orphan`);
        assert.isFalse(actor.toObject(true).effects.some(entry => entry._id === effect.id),`${id}: removal must reach Actor source`);
        assert.isFalse(actor.statuses.has(id),`${id}: removal must clear the prepared Actor status`);
      }

      it("applies and removes prone through the production Actor condition API", async function () {
        const actor = await fixtures.createActor({name:"condition toggle"});
        assert.lengthOf(conditions(actor,"prone"),0,"Fixture must start without prone");
        // The fixture Actor owns cleanup even when status conversion creates unmarked children.
        const effect = await actor.toggleCondition("prone");
        assertCondition(actor,effect,"prone");
        const {default:Model} = await import("../../data/active-effect/condition.mjs");
        assert.instanceOf(effect.system,Model,"Prone must use the real condition TypeDataModel");
        assert.isNull(await actor.toggleCondition("prone",{levels:-1}),"Negative non-stacking delta must remove prone");
        assertRemoved(actor,effect,"prone");
      });

      it("status conversion persists Bleeding RuleElements and their registry contribution", async function () {
        const actor = await fixtures.createActor({name:"condition status conversion"});
        const definition = CONFIG.WILDPATH.CONDITIONS.bleeding;
        assert.isNotEmpty(definition.ruleElements,"Bleeding must supply its existing Trigger RuleElement");
        const expected = definition.ruleElements.map((rule,index) => {
          const result = serializeRuleElementDefinition(rule,{index});
          assert.isTrue(result.ok,"Configured condition RuleElement must serialize successfully");
          return result.definition;
        });
        const effect = await actor.toggleStatusEffect("bleeding",{active:true});
        const source = assertCondition(actor,effect,"bleeding");
        assert.deepEqual(source.system.ruleElements,expected,"Status conversion must persist the complete serialized condition RuleElements");
        const collect = () => collectRuleElementContributions({
          ruleElements:conditions(actor,"bleeding").flatMap(entry => entry.system.ruleElements),
          context:{actor,actorSystem:actor.system}
        });
        const result = collect();
        assert.isTrue(result.ok,"Persisted condition RuleElements must be accepted by the real registry");
        assert.lengthOf(result.contributions.triggers,1,"Bleeding must contribute exactly one trigger after persistence");
        const trigger = result.contributions.triggers[0];
        assert.equal(trigger.id,"condition.bleeding.turn-start-damage","Persisted trigger identity must survive collection");
        assert.equal(trigger.event.type,"turn.started","Persisted Bleeding trigger must retain its event matcher");
        assert.deepEqual(trigger.payload,definition.ruleElements[0].data.payload,"Persisted trigger must retain its mechanical payload");
        assert.equal(actor.getResource("health").value,10,"Bleeding is event-driven and must not deal damage during preparation");
        await actor.toggleCondition("bleeding",{levels:-1});
        assertRemoved(actor,effect,"bleeding");
        assert.lengthOf(collect().contributions.triggers,0,"Removing Bleeding must remove its registry contribution");
        assert.equal(actor.getResource("health").value,10,"Removing Bleeding must not dispatch its turn trigger");
      });

      it("exhaustion stacks, clamps, decreases, and removes persisted levels", async function () {
        const actor = await fixtures.createActor({name:"stacking condition"});
        const maximum = CONFIG.WILDPATH.CONDITIONS.exhaustion.maxLevel;
        assert.equal(maximum,6,"Use the existing six-level Exhaustion definition");
        const effect = await actor.toggleCondition("exhaustion",{levels:1});
        assertCondition(actor,effect,"exhaustion");
        function assertLevel(level) {
          const current = actor.effects.get(effect.id), source = current.toObject(true);
          assert.equal(source.system.level,level,"Exhaustion level must persist at the expected stack");
          assert.equal(current.system.level,level,"Prepared Exhaustion level must match its persisted stack");
          assert.equal(source.name,`${game.i18n.localize(CONFIG.WILDPATH.CONDITIONS.exhaustion.name)} (${level})`,
            "Persisted Exhaustion name must follow the level update");
          assert.lengthOf(conditions(actor,"exhaustion"),1,"Stacking must update the existing effect, not create duplicates");
        }
        assertLevel(1);
        await actor.toggleCondition("exhaustion",{levels:2});
        assertLevel(3);
        await actor.toggleCondition("exhaustion",{levels:100});
        assertLevel(maximum);
        await actor.toggleCondition("exhaustion",{levels:-1});
        assertLevel(maximum-1);
        await actor.toggleCondition("exhaustion",{levels:-maximum});
        assertRemoved(actor,effect,"exhaustion");
      });

      it("reapplying non-stacking prone neither duplicates nor assigns a level", async function () {
        const actor = await fixtures.createActor({name:"non-stacking condition"});
        const effect = await actor.toggleCondition("prone");
        const before = assertCondition(actor,effect,"prone").system;
        const again = await actor.toggleCondition("prone",{levels:5});
        assert.equal(again?.id,effect.id,"Redundant positive non-stacking delta must return the same effect");
        assert.lengthOf(conditions(actor,"prone"),1,"Non-stacking condition must not duplicate");
        assert.isNull(effect.system.level,"Non-stacking condition must not gain a prepared level");
        assert.deepEqual(effect.toObject(true).system,before,"Redundant non-stacking application must not alter persisted condition data");
        await actor.toggleCondition("prone",{levels:-1});
        assert.isNull(await actor.toggleCondition("prone",{levels:-1}),"Removing an absent non-stacking condition must remain a no-op");
        assertRemoved(actor,effect,"prone");
      });

      it("condition removal clears authored modifiers and stale prepared resources", async function () {
        const actor = await fixtures.createActor({name:"condition contribution removal"});
        const baseline = actor.toObject(true).system.resources.health;
        assert.equal(actor.getStatistic("resources.health.max").totalModifier,0,"Fixture statistic must start at baseline");
        const effect = await actor.toggleCondition("prone");
        assertCondition(actor,effect,"prone");
        // Prone has no built-in numeric modifier. Author one on its real effect using the
        // existing inherited modifier schema; do not change the condition configuration.
        await effect.update({"system.modifiers":[{id:"quench-condition-health",label:"QA condition modifier",
          domains:["resources.health.max"],type:"untyped",value:3,enabled:true}]});
        assert.equal(effect.toObject(true).system.modifiers[0].value,3,"Authored condition modifier must persist");
        assert.equal(actor.getStatistic("resources.health.max").totalModifier,3,"Condition effect must contribute its authored modifier");
        assert.equal(actor.getResource("health").max,13,"Condition effect modifier must reach Actor preparation");
        await actor.toggleCondition("prone",{levels:-1});
        assertRemoved(actor,effect,"prone");
        assert.equal(actor.getStatistic("resources.health.max").totalModifier,0,"Removing the condition must remove its modifier contribution");
        assert.equal(actor.getResource("health").max,10,"Removing the condition must clear the stale prepared maximum");
        assert.deepEqual(actor.toObject(true).system.resources.health,baseline,"Condition preparation must not pollute resource source");
      });

      it("2024 conditions persist their advantage and disadvantage and the Actor collects them", async function () {
        const actor = await fixtures.createActor({name:"roll modes"});
        const modes = (domains,context) => actor.getRollModes(domains,{context}).map(entry => entry.mode);
        assert.deepEqual(modes(["attacked"],{attack:{adjacent:true}}),[],"No condition: no roll modes");
        await actor.toggleCondition("prone");
        assert.deepEqual(modes(["attack"]),["disadvantage"]);
        assert.deepEqual(modes(["attacked"],{attack:{adjacent:true}}),["advantage"]);
        assert.deepEqual(modes(["attacked"],{attack:{adjacent:false}}),["disadvantage"]);
        await actor.toggleCondition("restrained");
        assert.deepEqual(modes(["save","save.agility"]),["disadvantage"]);
        await actor.toggleCondition("prone",{levels:-1});
        assert.deepEqual(modes(["attacked"],{attack:{adjacent:false}}),["advantage"],"Restrained alone: attacks against it have advantage");
      });

      it("2024 Stunned leaves no actions, Restrained has Speed 0 everywhere, and Exhaustion scales with its level", async function () {
        const actor = await fixtures.createActor({name:"incapacitated"});
        await fixtures.createItem(actor,{system:{ruleElements:[{schemaVersion:1,id:"wings",type:"GrantMovement",
          data:{mode:"fly",distance:60}}]}});
        await actor.toggleCondition("stunned");
        assert.deepEqual(["action","bonus","reaction"].map(id => actor.getResource(id).max),[0,0,0],"Incapacitated: no actions");
        await actor.toggleCondition("stunned",{levels:-1});
        assert.equal(actor.getResource("action").max,1,"Recovered when the condition ends");
        await actor.toggleCondition("restrained");
        assert.deepEqual({...actor.system.speeds},{walk:0,fly:0},"Speed 0 includes a granted fly Speed");
        await actor.toggleCondition("restrained",{levels:-1});
        await actor.toggleCondition("exhaustion",{levels:3});
        assert.equal(actor.getStatistic(["save.might","save"]).totalModifier,-6,"Three levels: -6 on saves");
        assert.deepEqual({...actor.system.speeds},{walk:15,fly:45},"and -15 ft on every Speed");
      });

      it("2024 dying: 0 health is Unconscious, failed death saves at 0 are death, and Exhaustion 6 kills", async function () {
        const dying = game.wildpath.dying;
        const hero = await fixtures.createActor({name:"dying hero"});
        const has = (actor,id) => actor.effects.some(effect => effect.system?.type === id);
        await hero.update({"system.resources.health.value":0});
        await dying.afterPlans(hero,[{type:"damage",from:4,to:0,max:10,amount:6,overflow:2}]);
        assert.isTrue(has(hero,"unconscious"),"Dropped to 0: Unconscious");
        await dying.afterPlans(hero,[{type:"damage",from:0,to:0,max:10,amount:2}],{critical:true});
        assert.equal(hero.system.deathSaves.failures,2,"A critical hit at 0 is two failed death saves");
        await dying.afterPlans(hero,[{type:"damage",from:0,to:0,max:10,amount:2}]);
        assert.deepEqual([hero.system.deathSaves.failures,hero.system.resources.health.value],[3,0]);
        assert.isTrue(has(hero,"dead"),"Dead is Defeated");
        assert.equal(hero.system.resources.action.max,0,"The dead do not act");
        const tired = await fixtures.createActor({name:"exhausted"});
        await tired.toggleCondition("exhaustion",{levels:6});
        for (let i = 0; (i < 40) && !has(tired,"dead"); i++) await new Promise(resolve => setTimeout(resolve,50));
        assert.isTrue(has(tired,"dead"),"Exhaustion 6 is death");
        assert.equal(tired.system.deathSaves.failures,3);
      });

      it("2024 Paralyzed, Petrified and Grappled, and immunity to a condition", async function () {
        const {commitConditionEffectMutationPlan} = await import("../../resolvers/condition-effect-commit-resolver.mjs");
        const held = await fixtures.createActor({name:"paralyzed"});
        await held.toggleCondition("paralyzed");
        assert.deepEqual(["action","bonus","reaction","movement"].map(id => held.getResource(id).max),[0,0,0,0],"Incapacitated, Speed 0");
        assert.deepEqual(held.getRollModes(["attacked"]).map(entry => entry.mode),["advantage"]);
        assert.deepEqual(held.getRollOutcomes(["attacked"],{context:{attack:{adjacent:true}}}).map(entry => entry.outcome),["critical-on-hit"]);
        assert.lengthOf(held.getRollOutcomes(["attacked"],{context:{attack:{adjacent:false}}}),0,"Critical only within 5 ft");
        assert.deepEqual(held.getRollOutcomes(["save","save.might"]).map(entry => entry.outcome),["automatic-failure"]);

        const statue = await fixtures.createActor({name:"petrified"});
        await statue.toggleCondition("petrified");
        assert.deepEqual(statue.getConditionImmunities(),["poisoned"]);
        assert.deepEqual(statue.getDamageProfile().resistances.map(entry => entry.damageTypes),[[]],"Resistance to all damage");
        const result = await commitConditionEffectMutationPlan(statue,{type:"conditionEffect",conditionId:"poisoned",levels:1});
        assert.isTrue(result.immune,"Immune to Poisoned");
        assert.isFalse(statue.statuses.has("poisoned"));

        const grappled = await fixtures.createActor({name:"grappled"});
        await grappled.toggleCondition("grappled");
        assert.equal(grappled.system.speeds.walk,0);
        assert.deepEqual(grappled.getRollModes(["attack"],{context:{attack:{fromTarget:{}}}}).map(entry => entry.mode),["disadvantage"],
          "Disadvantage on attacks against others");
        assert.lengthOf(grappled.getRollModes(["attack"],{context:{attack:{fromTarget:{grappled:true}}}}),0,"but not against the grappler");
      });
    });
  }, {displayName:"WILDPATH: Real Foundry Conditions",preSelected:false});
}
