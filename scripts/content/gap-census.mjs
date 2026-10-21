import {existsSync, readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";

/**
 * Count what converted content is not automated, by reason: the SRD packs (packs/_source/srd-*) and the local book
 * packages (their conversion-notes.json). Each reason is counted once per document. Prints a table, one column per
 * source, to rank the engine's gaps by how much content each one holds back.
 *
 *   node scripts/content/gap-census.mjs [--data <Foundry Data folder>]
 */
const data = process.argv.includes("--data") ? process.argv[process.argv.indexOf("--data") + 1]
  : join(process.env.LOCALAPPDATA ?? "", "FoundryVTT", "Data");

const RULES = [
  [/^Multiattack: not automated/, () => "Multiattack"],
  [/^Multiattack: any of its attacks/, () => "shortcut: Multiattack's named attacks not enforced"],
  [/^Multiattack: its other parts/, () => "Multiattack: a replacement or an ability it uses (by hand)"],
  [/effect: (\w+) is not a WildPath condition/, match => `condition: ${match[1]}`],
  [/effect: ".*" marks its creature \(narrative\)/, () => "narrative marker (a reminder, nothing to automate)"],
  [/effect: ".*" marks its creature only/, () => "effect marker only (its rules by hand)"],
  // A change of its token's image is how it looks, nothing to automate.
  [/effect: ".*" change img \(\w+\) not converted/, () => "effect image (how it looks)"],
  [/effect: ".*" change (\S+) \((\w+)\) not converted/, match => `effect change: ${match[1].replace(/\.(str|dex|con|int|wis|cha)\./, ".<ability>.")
    .replace(/skills\.\w+\./, "skills.<skill>.").replace(/movement\.\w+/, "movement.<mode>")} (${match[2]})`],
  [/cantrip damage growing/, () => "cantrip scaling by level"],
  [/more healing at higher levels/, () => "healing upcast"],
  [/versatile/, () => "versatile damage"],
  [/Recharge/, () => "recharge"],
  [/temporary Hit Points/, () => "temporary Hit Points"],
  [/targets: count/, () => "target count from a formula (upcast targets)"],
  [/area: .*-ft (\w+) is not supported/, match => `area shape: ${match[1]}`],
  [/a cylinder's height/, () => "area shape: cylinder height"],
  [/is passive or triggered \(narrative\)/, () => "passive trait (its text is its rule)"],
  [/is passive or triggered/, () => "passive or triggered ability"],
  [/concentration: nothing it sustains/, () => "concentration effect not converted"],
  [/summon: what it gains with the spell's level/, () => "summon: what it gains with the spell's level (not added)"],
  [/summon: a creature chosen by Challenge Rating/, () => "summon: a creature chosen by Challenge Rating"],
  [/summon: its creature is not among the converted/, () => "summon: its creature is not converted"],
  [/summon: a count of/, () => "summon: a count from a formula"],
  [/^not automated \((\w+), narrative\)/, () => "narrative use (its cost is all there is)"],
  [/concentration: its caster concentrates/, () => "concentration sustained (its effect is noted apart)"],
  [/^not automated \((\w+)\)/, match => `used, not automated: ${match[1]} activity`],
  [/save: a failure gives/, () => "save: conditions from its text (the rest by hand)"],
  [/save: a failure marks its creature \(narrative\)/, () => "narrative save (it tells or hides; nothing to automate)"],
  [/save: a failure marks its creature only/, () => "save: a failure marks its creature (rules by hand)"],
  [/^rolled \((\w+)\); what it does is by hand/, match => `rolled, consequences by hand: ${match[1]} activity`],
  [/^not automated:/, () => "used, not automated: no activity"],
  [/consumption: (\w+)/, match => `consumption: ${match[1]}`],
  [/custom formula/, () => "custom damage formula"],
  [/bonus "([^"]*)" not converted/, match => `formula: ${match[1].replace(/\d+/g, "n").slice(0, 40)}`],
  [/uses: maximum "([^"]*)"/, match => `uses maximum: ${match[1].replace(/\d+/g, "n").slice(0, 40)}`],
  [/save: .* DC .* not converted/, () => "save DC formula"],
  [/item's base damage/, () => "item base damage on a non-weapon"],
  [/a choice of [^ ]+ uses/, () => "a choice (damage type or save ability)"],
  [/is not an action-economy cost/, () => "long activation (minutes, hours)"],
  [/attack: (bonus|\+\d+ magic)/, () => "attack bonus or magic bonus"],
  [/partial recovery/, () => "partial recovery on a short rest"],
  [/vulnerabilities/, () => "vulnerabilities"],
  [/condition immunities/, () => "condition immunities"],
  [/magic or silvered/, () => "resistance bypasses"],
  [/AC: /, () => "AC calculation"],
  [/healing: temporary/, () => "temporary Hit Points"]
];
/** Reasons that say how something is handled rather than what is missing: counted apart from the real gaps. */
const INFORMATIONAL = new Set(["narrative use (its cost is all there is)", "passive trait (its text is its rule)",
  "narrative marker (a reminder, nothing to automate)", "narrative save (it tells or hides; nothing to automate)", "effect image (how it looks)",
  "concentration sustained (its effect is noted apart)",
  "long activation (minutes, hours)", "resistance bypasses"]);

const reason = note => {
  // A creature's notes name the item first ("Multiattack: not automated..."); the reason is what follows.
  for ( const text of [note, note.replace(/^[^:"]+: /, "")] ) {
    for ( const [pattern, name] of RULES ) {
      const match = text.match(pattern);
      if ( match ) return name(match);
    }
  }
  return `other: ${note.replace(/"[^"]*"/g, "\"…\"").replace(/\d+/g, "n").slice(0, 50)}`;
};

/** Per source: document name → notes. */
const sources = {};
const srd = {};
for ( const folder of ["srd-items", "srd-creatures"] ) {
  const path = join("packs/_source", folder);
  if ( !existsSync(path) ) continue;
  for ( const file of readdirSync(path) ) {
    const document = JSON.parse(readFileSync(join(path, file), "utf8"));
    for ( const entry of [document, ...(document.items ?? [])] ) {
      const notes = entry.flags?.wildpath?.conversion?.notes ?? [];
      if ( notes.length && (entry !== document || !document.items) ) srd[`${document.name}/${entry.name}`] = notes;
    }
  }
}
sources.SRD = srd;
for ( const id of ["dnd-players-handbook", "dnd-dungeon-masters-guide", "dnd-monster-manual", "dnd-tashas-cauldron"] ) {
  const path = join(data, "modules", `wildpath-${id}`, "conversion-notes.json");
  if ( existsSync(path) ) sources[id.replace("dnd-", "")] = JSON.parse(readFileSync(path, "utf8"));
}

const counts = {};
for ( const [source, documents] of Object.entries(sources) ) {
  for ( const notes of Object.values(documents) ) {
    for ( const key of new Set(notes.map(reason)) ) {
      counts[key] ??= {};
      counts[key][source] = (counts[key][source] ?? 0) + 1;
    }
  }
}
const columns = Object.keys(sources);
const rows = Object.entries(counts).map(([key, bySource]) => [key, columns.map(column => bySource[column] ?? 0)])
  .sort((a, b) => b[1].reduce((x, y) => x + y, 0) - a[1].reduce((x, y) => x + y, 0));
const sum = list => list.reduce((total, [, values]) => total + values.reduce((x, y) => x + y, 0), 0);
const real = rows.filter(([key]) => !INFORMATIONAL.has(key));
const info = rows.filter(([key]) => INFORMATIONAL.has(key));
console.log(`Real gaps: ${sum(real)}; informational notes: ${sum(info)}.\n`);
for ( const [title, list] of [["Real gaps", real], ["Informational", info]] ) {
  console.log(`### ${title}\n\n| Reason | ${columns.join(" | ")} | Total |\n| --- | ${columns.map(() => "---").join(" | ")} | --- |`);
  for ( const [key, values] of list ) console.log(`| ${key} | ${values.join(" | ")} | ${values.reduce((x, y) => x + y, 0)} |`);
  console.log("");
}
