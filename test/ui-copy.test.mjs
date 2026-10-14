import assert from "node:assert/strict";
import {readFileSync, readdirSync} from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const lang = JSON.parse(readFileSync(new URL("lang/en.json", root), "utf8"));
const lookup = key => key.split(".").reduce((node, part) => node?.[part], lang);

function sourceFiles(dir) {
  return readdirSync(new URL(dir, root), {withFileTypes: true}).flatMap(entry => {
    const path = `${dir}${entry.name}`;
    if ( entry.isDirectory() ) return entry.name === "tests" ? [] : sourceFiles(`${path}/`);
    return /\.(mjs|hbs)$/u.test(entry.name) ? [path] : [];
  });
}

test("every WILDPATH.* key the system shows has English copy in lang/en.json", () => {
  const files = ["wildpath.mjs", ...sourceFiles("module/"), ...sourceFiles("templates/")];
  const missing = [];
  for ( const file of files ) {
    const text = readFileSync(new URL(file, root), "utf8");
    // A key followed by `.${...}` or a closing `."` is a prefix the code completes; it must name a group of copy.
    for ( const [key, prefix] of text.matchAll(/WILDPATH\.[A-Z][A-Za-z]*(?:\.[A-Za-z]+)+(\.(?=[$"'`]))?/gu) ) {
      const name = prefix ? key.slice(0, -1) : key;
      if ( typeof lookup(name) !== (prefix ? "object" : "string") ) missing.push(`${file}: ${key}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("the Foundry prompt adapter localizes titles and labels and fills in the formula", async t => {
  const strings = {"WILDPATH.PROMPT.Title.Roll": "Enter your roll", "WILDPATH.PROMPT.Confirm": "Confirm",
    "WILDPATH.PROMPT.Roll.Total": "Total rolled ({formula})"};
  const previous = globalThis.game;
  globalThis.game = {i18n: {localize: key => strings[key] ?? key,
    format: (key, data) => (strings[key] ?? key).replace(/\{(\w+)\}/gu, (_, name) => data[name])}};
  t.after(() => { globalThis.game = previous; });
  const {createFoundryV14PromptAdapter} = await import("../module/adapters/foundry-v14-prompt-adapter.mjs");
  const {createDamageRollRequest} = await import("../module/helpers/rolls.mjs");
  const rollRequest = createDamageRollRequest({id: "d", resolutionId: "r",
    components: [{id: "blade", expression: {type: "dice", number: 1, faces: 8}}]});
  let shown = null;
  const adapter = createFoundryV14PromptAdapter({DialogV2: {input: async options => { shown = options; return {total: 4}; }}});
  await adapter.request({id: "d", resolutionId: "r", type: "roll", payload: {rollRequest}}, {isGM: true});
  assert.equal(shown.window.title, "Enter your roll");
  assert.equal(shown.ok.label, "Confirm");
  assert.match(shown.content, /Total rolled \(1d8\)/u);
});
