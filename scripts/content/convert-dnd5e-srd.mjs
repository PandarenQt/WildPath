import {mkdirSync, rmSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {PROGRESSION_TYPES, beastsOf, convertActor, convertItem, convertProgression, isSrd2024, nameIndex, scaleTables, slugify} from "./dnd5e-to-wildpath.mjs";
import {readPack} from "./packs.mjs";

/**
 * Convert the 2024 SRD from dnd5e's compendium sources into WildPath pack sources.
 *
 *   node scripts/content/convert-dnd5e-srd.mjs <extracted-dir> [--only "Name, Name"]
 *
 * - `<extracted-dir>` holds dnd5e's packs extracted with the Foundry CLI (`extractPack`): spells24, equipment24,
 *   classes24, feats24, origins24 and actors24, and content24 and tables24 for the names its links show. Extract
 *   from a copy; opening a LevelDB pack writes to it.
 * - Only documents whose own source says CC-BY-4.0 (SRD 5.2) are written: Items to packs/_source/srd-items and
 *   creatures to packs/_source/srd-creatures. Both folders are this script's own and are rewritten whole.
 * - Every note, meaning what is not automated and why, goes to docs/content/srd-conversion.md for review.
 */
const [from, ...rest] = process.argv.slice(2);
if ( !from ) throw new Error("Usage: convert-dnd5e-srd.mjs <extracted-dir> [--only \"Name, Name\"]");
const onlyIndex = rest.indexOf("--only");
const only = onlyIndex >= 0 ? new Set(rest[onlyIndex + 1].split(",").map(name => name.trim()).filter(Boolean)) : null;

const ITEM_PACKS = ["equipment24", "spells24", "classes24", "feats24", "origins24"];
// Classes', subclasses', features' and species' scale values (Sneak Attack, Land's Aid, Divine Spark, Breath Weapon).
const scales = scaleTables(["classes24", "origins24", "feats24"].flatMap(pack => readPack(from, pack)));
const names = nameIndex([...ITEM_PACKS, "actors24", "content24", "tables24"].flatMap(pack => readPack(from, pack)));
const wanted = document => isSrd2024(document) && (!only || only.has(document.name));
// The spells a creature's Spellcasting casts, by id.
const spells = Object.fromEntries(readPack(from, "spells24").map(document => [document._id, document]));
// The creatures a summon brings, by dnd5e id: the SRD's own, in this system's creature pack.
const creatures = Object.fromEntries(readPack(from, "actors24").filter(document => isSrd2024(document) && (document.type === "npc"))
  .map(document => [document._id, `Compendium.wildpath.srd-creatures.Actor.${document._id}`]));
// The Beasts Polymorph may choose.
const beasts = beastsOf(readPack(from, "actors24").filter(isSrd2024), document => creatures[document._id]);

const items = [];
const actors = [];
const progressions = [];
const report = [];
// What each dnd5e document became here: its gear (which brings its Actions), else all its Items.
const convertedIds = new Map();
for ( const pack of ITEM_PACKS ) {
  for ( const document of readPack(from, pack).filter(wanted) ) {
    if ( !["spell", "weapon", "feat", "equipment", "consumable", "tool", "loot", "container"].includes(document.type) ) continue;
    const result = convertItem(document, {scales, pack, names, creatures, spells, beasts});
    items.push(...result.items);
    const gear = result.items.filter(item => item.type === "gear");
    convertedIds.set(document._id, (gear.length ? gear : result.items).map(item => item._id));
    report.push({pack, name: document.name, converted: result.items.map(item => `${item.name} (${kind(item)})`), notes: result.notes});
  }
}
// Classes, subclasses, species and backgrounds (G8), granting what was converted above.
const uuidOf = uuid => (convertedIds.get(String(uuid).split(".").pop()) ?? []).map(id => `Compendium.wildpath.srd-items.Item.${id}`);
for ( const pack of ITEM_PACKS ) {
  for ( const document of readPack(from, pack).filter(wanted) ) {
    if ( !PROGRESSION_TYPES[document.type] ) continue;
    const result = convertProgression(document, {uuidOf, pack, names});
    if ( !result.ok ) continue;
    progressions.push(result.item);
    report.push({pack, name: document.name, converted: [`${result.item.name} (${result.item.type})`], notes: result.notes});
  }
}
for ( const document of readPack(from, "actors24").filter(wanted) ) {
  const result = convertActor(document, {scales, pack: "actors24", names, spells, creatures, beasts});
  if ( !result.ok ) continue;
  actors.push(result.actor);
  report.push({pack: "actors24", name: document.name, converted: [`${result.actor.name} (${result.actor.items.length} items)`], notes: result.notes});
}

/** What a converted Item is: automated, manual (it spends its cost only), or a passive feature. */
function kind(item) {
  if ( (item.type === "feature") || (item.type === "gear") ) return item.type;
  return item.flags.wildpath.conversion.notes.some(note => note.startsWith("not automated")) ? "manual" : "automated";
}

// Never anything but SRD 5.2 under the repository.
for ( const document of [...items, ...actors, ...progressions] ) {
  if ( (document.flags.wildpath.source.license !== "CC-BY-4.0") || (document.flags.wildpath.source.book !== "SRD 5.2") ) {
    throw new Error(`${document.name} is not SRD 5.2 content; nothing was written`);
  }
}
const write = (folder, documents) => {
  rmSync(folder, {recursive: true, force: true});
  mkdirSync(folder, {recursive: true});
  for ( const document of documents ) writeFileSync(join(folder, `${slugify(document.name)}-${document._id}.json`), `${JSON.stringify(document, null, 2)}\n`);
};
write("packs/_source/srd-items", items);
write("packs/_source/srd-creatures", actors);
write("packs/_source/srd-classes", progressions);

const counts = items.reduce((total, item) => ({...total, [kind(item)]: (total[kind(item)] ?? 0) + 1}), {});
const rows = report.sort((a, b) => a.name.localeCompare(b.name)).map(entry => `| ${entry.name} | ${entry.pack} | ${entry.converted.join(", ") || "—"} | ${
  entry.notes.join("; ").replaceAll("|", "\\|") || "—"} |`);
mkdirSync("docs/content", {recursive: true});
writeFileSync("docs/content/srd-conversion.md", `# SRD 5.2 conversion report

Generated by \`scripts/content/convert-dnd5e-srd.mjs\`; do not edit by hand. Each row is a dnd5e document whose source
says CC-BY-4.0, what it became, and what WildPath does not automate. An **automated** Action resolves fully; a **manual**
Action spends its cost (an Action, a Reaction, a spell slot) and its description says the rest; a **feature** is a
passive ability with its text. Descriptions are the SRD's own text, copied as placeholders.

Items: ${counts.automated ?? 0} automated, ${counts.manual ?? 0} manual, ${counts.feature ?? 0} features. Creatures: ${actors.length}.

This work includes material from the System Reference Document 5.2 ("SRD 5.2") by Wizards of the Coast LLC, available at
https://www.dndbeyond.com/srd. The SRD 5.2 is licensed under the Creative Commons Attribution 4.0 International License,
available at https://creativecommons.org/licenses/by/4.0/legalcode.

| Document | dnd5e pack | WildPath | Not automated |
| --- | --- | --- | --- |
${rows.join("\n")}
`);
console.log(`Items: ${JSON.stringify(counts)}; creatures: ${actors.length}; from ${report.length} SRD documents`);
