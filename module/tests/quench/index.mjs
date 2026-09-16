// Optional development integration: registering this hook does not require Quench to be installed.
import {registerRuntimeSmokeTests} from "./runtime-smoke.mjs";
import {registerDocumentTests} from "./documents.mjs";
import {registerResourceTests} from "./resources.mjs";

Hooks.on("quenchReady", quench => {
  registerRuntimeSmokeTests(quench);
  registerDocumentTests(quench);
  registerResourceTests(quench);
});
