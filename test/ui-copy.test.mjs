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
  const strings = {"WILDPATH.CHAT.Roll.Damage": "Damage", "WILDPATH.PROMPT.Confirm": "Confirm",
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
  assert.equal(shown.window.title, "Damage", "the roll is named as the chat card names it");
  assert.equal(shown.ok.label, "Confirm");
  assert.match(shown.content, /Total rolled \(1d8\)/u);
});

test("an offer's prompt asks what the roll came to, its total filled in, above its options; its title does not repeat it", async t => {
  const previous = globalThis.game;
  globalThis.game = {i18n: {localize: key => lookup(key) ?? key,
    format: (key, data) => (lookup(key) ?? key).replace(/\{(\w+)\}/gu, (_, name) => data[name])}};
  t.after(() => { globalThis.game = previous; });
  const {createFoundryV14PromptAdapter} = await import("../module/adapters/foundry-v14-prompt-adapter.mjs");
  const {sanitizePendingRequestForTransport} = await import("../module/helpers/multiplayer-authority.mjs");
  let shown = null;
  const adapter = createFoundryV14PromptAdapter({DialogV2: {input: async options => { shown = options; return {"choice:heroic-inspiration": "keep"}; }}});
  // As the player's client gets it: after the chooser projection.
  await adapter.request(sanitizePendingRequestForTransport({id: "c", resolutionId: "r", type: "choice", expectedResponseType: "choice",
    metadata: {title: "WILDPATH.INSPIRATION.OfferTitle"}, payload: {id: "heroic-inspiration",
      label: "WILDPATH.INSPIRATION.Outcome.attack.Failed", labelData: {name: "Battle Master", total: 17},
      options: [{value: "test-offer:pa", label: "Add Precision Attack (d8)"}, {value: "keep", label: "WILDPATH.INSPIRATION.Keep"}],
      defaultValue: "keep"}}), {isGM: true});
  assert.equal(shown.window.title, "Change the result");
  assert.match(shown.content, /<div class="form-group stacked">\s*<label [^>]*>Battle Master's attack roll of 17 missed\.<\/label>/u,
    "the question full width above its options");
  assert.doesNotMatch(shown.content, /Change the result/u, "the title is not repeated");
});

test("a physical-dice prompt names the roll its request is labelled as, after the chooser projection", async t => {
  const strings = {"WILDPATH.PROMPT.Title.Default": "Choose", "WILDPATH.CHAT.Roll.Concentration": "Concentration save",
    "WILDPATH.CHAT.Roll.TypedDamage": "{type} damage", "WILDPATH.DAMAGE.Fire": "Fire",
    "WILDPATH.PROMPT.Roll.Natural": "Die result ({formula})"};
  const previous = globalThis.game;
  globalThis.game = {i18n: {has: key => key in strings, localize: key => strings[key] ?? key,
    format: (key, data) => (strings[key] ?? key).replace(/\{(\w+)\}/gu, (_, name) => data[name])}};
  t.after(() => { globalThis.game = previous; });
  const {createFoundryV14PromptAdapter} = await import("../module/adapters/foundry-v14-prompt-adapter.mjs");
  const {sanitizePendingRequestForTransport} = await import("../module/helpers/multiplayer-authority.mjs");
  const {createD20RollRequest, createDamageRollRequest} = await import("../module/helpers/rolls.mjs");
  const shown = [];
  const adapter = createFoundryV14PromptAdapter({DialogV2: {input: async options => { shown.push(options); return {natural: 7}; }}});
  // The pipeline's concentration check: a save, named by its own labelKey; the roller gets only the chooser projection.
  const concentration = createD20RollRequest({id: "c", resolutionId: "r", type: "saving-throw", modifier: 3,
    metadata: {rollKind: "concentration", labelKey: "WILDPATH.CHAT.Roll.Concentration"}});
  await adapter.request(sanitizePendingRequestForTransport({id: "c", resolutionId: "r", type: "roll",
    payload: {rollKind: "concentration", rollRequest: concentration}}), {isGM: true});
  assert.equal(shown[0].window.title, "Concentration save");
  assert.match(shown[0].content, /Die result \(1d20 \+ 3\)/u);
  const fire = createDamageRollRequest({id: "f", resolutionId: "r",
    components: [{id: "burn", expression: {type: "dice", number: 2, faces: 6}, damageType: "fire"}]});
  await adapter.request({id: "f", resolutionId: "r", type: "roll", payload: {rollRequest: fire}}, {isGM: true});
  assert.equal(shown[1].window.title, "Fire damage");
  // A prompt with its own title keeps it.
  await adapter.request({id: "c", resolutionId: "r", type: "roll", metadata: {title: "WILDPATH.PROMPT.Title.Default"},
    payload: {rollRequest: concentration}}, {isGM: true});
  assert.equal(shown[2].window.title, "Choose");
});

test("the batch window lists each creature's save, and empty rows come back empty", async t => {
  const strings = {"WILDPATH.PROMPT.Batch.Title": "Saving throws", "WILDPATH.PROMPT.Batch.RollRest": "Roll the rest",
    "WILDPATH.PROMPT.Roll.Natural": "Die result ({formula})", "WILDPATH.PROMPT.Title.Save": "{name}'s saving throw"};
  const previous = globalThis.game;
  globalThis.game = {i18n: {localize: key => strings[key] ?? key,
    format: (key, data) => (strings[key] ?? key).replace(/\{(\w+)\}/gu, (_, name) => data[name])}};
  t.after(() => { globalThis.game = previous; });
  const {createFoundryV14PromptAdapter} = await import("../module/adapters/foundry-v14-prompt-adapter.mjs");
  const {createD20RollRequest} = await import("../module/helpers/rolls.mjs");
  const save = (id, name) => ({id, resolutionId: "r", type: "roll", payload: {rollKind: "save", targets: [{id, target: {name}}],
    rollRequest: createD20RollRequest({id, resolutionId: "r", type: "saving-throw", modifier: 5})}});
  const shown = [];
  const adapter = createFoundryV14PromptAdapter({DialogV2: {input: async options => {
    shown.push(options);
    return options.ok.label === "Roll the rest" ? {"natural-0": 12, "natural-1": null} : {natural: 7};
  }}});
  const rows = await adapter.requestBatch([save("a", "Goblin"), save("b", "Bandit Captain")], {isGM: true});
  assert.equal(shown[0].window.title, "Saving throws");
  assert.match(shown[0].content, /Goblin[\s\S]*Die result \(1d20 \+ 5\)[\s\S]*Bandit Captain/u);
  assert.deepEqual(rows.map(row => row?.natural ?? null), [12, null]);
  await adapter.request(save("a", "Goblin"), {isGM: true});
  assert.equal(shown[1].window.title, "Goblin's saving throw", "a lone save prompt names whose save it is");
});

/** A game.i18n reading lang/en.json, as Foundry's would: an unknown key comes back as itself. */
function langI18n() {
  const own = key => ((typeof lookup(key) === "string") ? lookup(key) : key);
  return {has: key => typeof lookup(key) === "string", localize: own,
    format: (key, data) => own(key).replace(/\{(\w+)\}/gu, (_, name) => data[name])};
}

test("every prompt control the view models emit is shown in English: no WILDPATH key is left in the window", async t => {
  const previous = globalThis.game;
  globalThis.game = {i18n: langI18n()};
  t.after(() => { globalThis.game = previous; });
  const {createFoundryV14PromptAdapter} = await import("../module/adapters/foundry-v14-prompt-adapter.mjs");
  const {createD20RollRequest, createDamageRollRequest} = await import("../module/helpers/rolls.mjs");
  const shown = [];
  const adapter = createFoundryV14PromptAdapter({DialogV2: {input: async options => { shown.push(options); return null; }}});
  // Bane on an attack: the d20, then the total with every die (the second field once showed its key).
  const bane = createD20RollRequest({id: "b", resolutionId: "r", modifier: 1, expected: {modifierTotal: null},
    definition: {dice: [{id: "d20", number: 1, faces: 20, purpose: "d20"}, {id: "bane", number: 1, faces: 4, purpose: "bonus", sign: -1}]}});
  const damage = createDamageRollRequest({id: "d", resolutionId: "r", components: [{id: "blade", expression: {type: "dice", number: 1, faces: 8}}]});
  const candidates = [{id: "t1"}, {id: "t2", name: "Goblin"}];
  const requests = [
    {type: "roll", payload: {rollRequest: bane}},
    {type: "roll", payload: {rollRequest: damage}},
    {type: "action-configuration", payload: {requests: [
      {id: "level", type: "select-one", label: "WILDPATH.PROMPT.CastLevel", options: [{id: "none", label: "WILDPATH.PROMPT.NoResource"}]},
      {id: "upcast", type: "select-many", label: "WILDPATH.PROMPT.UpcastDamage", options: [{id: "a", label: "WILDPATH.PROMPT.Yes"}]},
      {id: "flag", type: "boolean"}, {id: "count", type: "number"}, {id: "pay", type: "resource", options: []},
      {id: "type", type: "damage-type", options: [{id: "fire", value: "fire"}]}]}},
    {type: "target-selection", payload: {candidates}},
    {type: "target-refinement", payload: {candidates, targeting: {refinementPolicy: {instances: 3}}}},
    {type: "reaction-choice", metadata: {title: "WILDPATH.PROMPT.Title.ReactionAvailable"}, payload: {label: "WILDPATH.REACTIONS.Event.Hit",
      labelData: {name: "WILDPATH.REACTIONS.Event.Someone"}, options: [{id: "decline", label: "WILDPATH.REACTIONS.Decline", value: {decision: "decline"}}]}},
    {type: "choice", payload: {}}
  ];
  for ( const [index, request] of requests.entries() ) await adapter.request({id: `q${index}`, resolutionId: "r", ...request}, {isGM: true});
  await adapter.requestBatch([{id: "s", resolutionId: "r", type: "roll", payload: {rollKind: "save", targets: [{id: "g", target: {name: "Goblin"}}],
    rollRequest: {...bane, id: "s"}}}], {isGM: true});
  assert.equal(shown.length, requests.length + 1);
  for ( const options of shown ) assert.doesNotMatch(`${options.window.title} ${options.ok.label} ${options.content}`, /WILDPATH\./u,
    options.content);
  assert.match(shown[0].content, /Total, with every die \(1d20 - 1d4 \+ 1\)/u);
  assert.match(shown.at(-1).content, /placeholder="Total, with every die \(1d20 - 1d4 \+ 1\)"/u, "the batch row's total too");
  assert.match(shown[5].content, /A creature's attack hit\./u);
});

test("a reaction prompt says what happened above its options, after the chooser projection, with no generic Choice label", async t => {
  const previous = globalThis.game;
  globalThis.game = {i18n: langI18n()};
  t.after(() => { globalThis.game = previous; });
  const {createFoundryV14PromptAdapter} = await import("../module/adapters/foundry-v14-prompt-adapter.mjs");
  const {sanitizePendingRequestForTransport} = await import("../module/helpers/multiplayer-authority.mjs");
  let shown = null;
  const adapter = createFoundryV14PromptAdapter({DialogV2: {input: async options => { shown = options; return {"choice:choice": "decline"}; }}});
  // Arrow-Catching Shield, as its player's client gets it (the event itself never travels).
  const request = sanitizePendingRequestForTransport({id: "x", resolutionId: "r", type: "reaction-choice", expectedResponseType: "reaction-choice",
    metadata: {title: "WILDPATH.PROMPT.Title.ReactionAvailable"}, payload: {event: {id: "e", data: {secret: true}},
      label: "WILDPATH.REACTIONS.Event.HitTo", labelData: {name: "QA8 Archer", target: "QA8 Ward"},
      options: [{id: "cand", label: "Arrow-Catching Shield", value: {decision: "use", candidateId: "cand"}},
        {id: "decline", label: "WILDPATH.REACTIONS.Decline", value: {decision: "decline"}}]}});
  assert.equal(request.payload.event, undefined);
  const answer = await adapter.request(request, {isGM: true});
  assert.deepEqual(answer.value, {decision: "decline"});
  assert.equal(shown.window.title, "Reaction available");
  assert.match(shown.content, /<div class="form-group stacked">\s*<label [^>]*>QA8 Archer's attack hit QA8 Ward\.<\/label>/u);
  assert.doesNotMatch(shown.content, />Choice</u);
});

test("a Heroic Inspiration option says how many points its payer has, not a cap", async () => {
  const {inspirationOffer} = await import("../module/resolvers/foundry-multiplayer-runtime.mjs");
  const hero = {uuid: "Actor.hero", name: "Hero", hasPlayerOwner: true};
  const offer = inspirationOffer(hero, {pools: [{id: "heroic-inspiration", label: "Heroic Inspiration", value: 1, max: 4}]},
    {i18n: langI18n()}, {chooser: "source-controller"});
  assert.equal(offer.options[0].label, "Reroll, spending a point (Hero has 1)");
});

test("lang/en.json has no duplicate keys (a later one would silently replace the earlier)", async () => {
  const {readFileSync} = await import("node:fs");
  const text = readFileSync("lang/en.json", "utf8");
  const duplicates = [];
  // A key repeated within one object: track the keys of each nesting level.
  const stack = [new Set()];
  // Whole strings are consumed, so braces inside values ("{name}") do not count; only a key is followed by a colon.
  for ( const match of text.matchAll(/"((?:[^"\\]|\\.)*)"(\s*:\s*(\{)?)?|(\})/g) ) {
    if ( match[4] ) { stack.pop(); continue; }
    if ( !match[2] ) continue;
    const keys = stack.at(-1);
    if ( keys.has(match[1]) ) duplicates.push(match[1]);
    keys.add(match[1]);
    if ( match[3] ) stack.push(new Set());
  }
  assert.deepEqual(duplicates, []);
});

test("every document type in system.json has its TYPES name", () => {
  const system = JSON.parse(readFileSync(new URL("system.json", root), "utf8"));
  const missing = Object.entries(system.documentTypes ?? {}).flatMap(([documentName, types]) => Object.keys(types)
    .filter(type => typeof lookup(`TYPES.${documentName}.${type}`) !== "string").map(type => `${documentName}.${type}`));
  assert.deepEqual(missing, []);
});

test("every WILDPATH key in lang/en.json is shown somewhere", () => {
  // The converter's labels are shown too, from the packs it writes.
  const text = ["wildpath.mjs", "system.json", "scripts/content/dnd5e-to-wildpath.mjs", ...sourceFiles("module/"), ...sourceFiles("templates/")]
    .map(file => readFileSync(new URL(file, root), "utf8")).join("\n");
  // A prefix the code completes (`WILDPATH.X.${id}`, "WILDPATH.X." + id) covers every key under it.
  const prefixes = new Set([...text.matchAll(/(WILDPATH(?:\.[A-Za-z0-9]+)+\.)(?=[$"'`])/gu)].map(match => match[1]));
  const keys = [];
  const walk = (node, path) => Object.entries(node).forEach(([key, value]) =>
    (typeof value === "string") ? keys.push(`${path}.${key}`) : walk(value, `${path}.${key}`));
  walk(lang.WILDPATH, "WILDPATH");
  const unused = keys.filter(key => !text.includes(key) && ![...prefixes].some(prefix => key.startsWith(prefix)));
  assert.deepEqual(unused, []);
});

test("a select showing lang keys localizes them", () => {
  // These lists are labels already (Challenge Ratings, die sizes, localized domain names, recharge rows and the shared
  // Bastions to join, named by their members).
  const ready = new Set(["challengeOptions", "progression.hitDice", "row.appliesToChoices", "../ctx.recharge", "bastionInfo.join"]);
  const bare = sourceFiles("templates/").flatMap(file => [...readFileSync(new URL(file, root), "utf8")
    .matchAll(/\{\{selectOptions\s+([^\s}]+)([^}]*)\}\}/gu)]
    .filter(([, list, rest]) => !/localize=true/u.test(rest) && !ready.has(list)).map(([call]) => `${file}: ${call}`));
  assert.deepEqual(bare, []);
});

test("templates show no English of their own: text and labels come from lang keys", () => {
  const found = sourceFiles("templates/").flatMap(file => {
    const text = readFileSync(new URL(file, root), "utf8").replace(/\{\{!--[\s\S]*?--\}\}/gu, "").replace(/\{\{[\s\S]*?\}\}/gu, " ");
    // Labels a reader sees; a tooltip may be a lang key (Foundry localizes it). A placeholder may show syntax:
    // slugs, formulas, a compendium reference.
    const attributes = [...text.matchAll(/\b(title|aria-label|alt|data-tooltip|placeholder)="([^"]*)"/gu)]
      .filter(([, name, value]) => {
        const shown = value.replace(/<[^>]*>/gu, "");
        if ( !/[A-Za-z]{2,}/u.test(shown) ) return false;
        if ( (name === "data-tooltip") && /^WILDPATH\.[\w.]+$/u.test(value) ) return false;
        return !((name === "placeholder") && (/^[a-z0-9.,+*\-\s]*$/u.test(value) || value.startsWith("Compendium.")));
      }).map(([attribute]) => attribute);
    // Text between tags, the tags read with their quoted attributes (a tooltip may hold markup).
    const words = text.replace(/<!--[\s\S]*?-->/gu, "").replace(/<[a-zA-Z/!](?:[^>"']|"[^"]*"|'[^']*')*>/gu, "\n").split("\n")
      .map(line => line.trim()).filter(line => /[A-Za-z]{2,}/u.test(line));
    return [...attributes, ...words].map(entry => `${file}: ${entry}`);
  });
  assert.deepEqual(found, []);
});

test("notifications are lang keys, not English typed into the code", () => {
  const found = sourceFiles("module/").filter(file => file.endsWith(".mjs")).flatMap(file =>
    [...readFileSync(new URL(file, root), "utf8").matchAll(/notifications\??\.(?:warn|info|error)\??\.?\(\s*(["'`])([A-Za-z][^"'`]*)\1/gu)]
      .filter(([, , message]) => !message.startsWith("WILDPATH.")).map(([call]) => `${file}: ${call}`));
  assert.deepEqual(found, []);
});
