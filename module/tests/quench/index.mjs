// Optional development integration: registering this hook does not require Quench to be installed.
import {registerRuntimeSmokeTests} from "./runtime-smoke.mjs";
import {registerDocumentTests} from "./documents.mjs";
import {registerResourceTests} from "./resources.mjs";
import {registerEffectTests} from "./effects.mjs";
import {registerConditionTests} from "./conditions.mjs";
import {registerRuleElementTests} from "./rule-elements.mjs";
import {registerCombatTests} from "./combat.mjs";
import {registerStagedMovementTests} from "./staged-movement.mjs";

Hooks.on("quenchReady", quench => {
  registerRuntimeSmokeTests(quench);
  registerDocumentTests(quench);
  registerResourceTests(quench);
  registerEffectTests(quench);
  registerConditionTests(quench);
  registerRuleElementTests(quench);
  registerCombatTests(quench);
  registerStagedMovementTests(quench);
});
