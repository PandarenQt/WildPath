// Optional development integration, imported by wildpath.mjs only when Quench is ready.
import {registerRuntimeSmokeTests} from "./runtime-smoke.mjs";
import {registerDocumentTests} from "./documents.mjs";
import {registerResourceTests} from "./resources.mjs";
import {registerEffectTests} from "./effects.mjs";
import {registerConditionTests} from "./conditions.mjs";
import {registerRuleElementTests} from "./rule-elements.mjs";
import {registerCombatTests} from "./combat.mjs";
import {registerStagedMovementTests} from "./staged-movement.mjs";
import {registerMultiplayerDisclosureTests} from "./multiplayer-disclosure.mjs";
import {registerActionResultTests} from "./action-results.mjs";
import {registerRepresentativeActionTests} from "./representative-actions.mjs";
import {registerAreaTests} from "./areas.mjs";
import {registerLanguageTests} from "./languages.mjs";

export function registerQuenchTests(quench) {
  registerRuntimeSmokeTests(quench);
  registerDocumentTests(quench);
  registerResourceTests(quench);
  registerEffectTests(quench);
  registerConditionTests(quench);
  registerRuleElementTests(quench);
  registerCombatTests(quench);
  registerStagedMovementTests(quench);
  registerMultiplayerDisclosureTests(quench);
  registerActionResultTests(quench);
  registerRepresentativeActionTests(quench);
  registerAreaTests(quench);
  registerLanguageTests(quench);
}
