import {mkdirSync, rmSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {PROGRESSION_TYPES, beastsOf, convertActor, convertItem, convertProgression, convertTable, isSrd2024, nameIndex, scaleTables, slugify,
  withRedirects} from "./dnd5e-to-wildpath.mjs";
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
// The creatures a summon brings, by dnd5e id: the SRD's own, in this system's creature pack. Some SRD items (a
// Figurine of Wondrous Power, a Horn of Valhalla) name a creature by an older id; these are the SRD creatures those ids
// redirect to (ids only, as the DMG module's redirects give them).
const SUMMON_REDIRECTS = {"5SgVGhQBswgWRwsF": "mmNightmare00000", "8SMQl75HLjhuSeau": "mmFireElemental0", Hm4o2FgPZsdbXjLq: "mmFleshGolem0000",
  JW8bXggOMBx1S6tF: "mmBaboon00000000", MZYCPIVoBs918qGZ: "mmJackal00000000", SXXvwaLBNuzBymp3: "mmAxeBeak0000000",
  SsuCaF2fIEoDdFA3: "mmGiantBoar00000", VVXly3ue0i3YgGrB: "mmGiantOwl000000", YOqhbf8WsX0jH9Fu: "mmClayGolem00000",
  aAqfEHPiVbhMwZ6j: "mmGiantHyena0000", banHjKDMCegbUwYE: "mmAirElemental00", h052EIIUmRwJum65: "mmGriffon0000000",
  h98AuPfomEPcCibP: "mmIronGolem00000", hQt3qIahnB1Odb40: "mmGiantElk000000", kz1t6xeXVwODpYb2: "mmBerserker00000",
  namJz755U1EhvEJa: "mmWaterElemental", q1YJIeIt6rK8fCKn: "mmGiantRat000000", sApYLZj9PTZ40wJr: "mmEarthElemental",
  t8WYD7ak07X7xpx8: "mmMummy000000000", z3gSIXHHWYaHjfBT: "mmStoneGolem0000"};
const creatures = withRedirects(Object.fromEntries(readPack(from, "actors24").filter(document => isSrd2024(document) && (document.type === "npc"))
  .map(document => [document._id, `Compendium.wildpath.srd-creatures.Actor.${document._id}`])), SUMMON_REDIRECTS);
// The Beasts Polymorph may choose.
const beasts = beastsOf(readPack(from, "actors24").filter(isSrd2024), document => creatures[document._id]);

// Its tables: only those of an SRD 5.2 magic item or spell (a table's id begins as its owner's: dmgWandOfWonderE of the
// Wand of Wonder; or its name does: Gray Bag of Tricks), never a creature's lore table, which this export does not license.
const tableOwners = [...readPack(from, "equipment24"), ...readPack(from, "spells24")].filter(isSrd2024);
const ownedTables = readPack(from, "tables24").filter(table => Array.isArray(table.results)).flatMap(table => {
  const owner = tableOwners.find(document => document._id.slice(0, 12).toLowerCase() === table._id.slice(0, 12).toLowerCase())
    ?? tableOwners.find(document => (document.name.length >= 6) && table.name.startsWith(document.name));
  return owner ? [{table, owner}] : [];
});
// An item drawing its own table when used (a Bag of Tricks): its converted table's uuid, by dnd5e id.
const tables = Object.fromEntries(ownedTables.map(({table}) => [table._id, `Compendium.wildpath.srd-tables.RollTable.${table._id}`]));

const items = [];
const actors = [];
const progressions = [];
const report = [];
// What each dnd5e document became here: what brings its Actions with it (gear, a feature with grants), else all its Items.
const convertedIds = new Map();
for ( const pack of ITEM_PACKS ) {
  for ( const document of readPack(from, pack).filter(wanted) ) {
    if ( !["spell", "weapon", "feat", "equipment", "consumable", "tool", "loot", "container"].includes(document.type) ) continue;
    const result = convertItem(document, {scales, pack, names, creatures, spells, beasts, tables});
    items.push(...result.items);
    const gear = result.items.filter(item => item.type === "gear");
    const granting = result.items.filter(item => item.flags?.wildpath?.grants?.length);
    convertedIds.set(document._id, (gear.length ? gear : (granting.length ? granting : result.items)).map(item => item._id));
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

const tableUuid = uuid => {
  const id = String(uuid ?? "").split(".").pop();
  if ( String(uuid).includes(".actors24.") || String(uuid).includes(".monsters.") ) return creatures[id] ?? null;
  const converted = convertedIds.get(id)?.[0];
  return converted ? `Compendium.wildpath.srd-items.Item.${converted}` : null;
};
const convertedTables = ownedTables.map(({table, owner}) => convertTable(table, {uuidOf: tableUuid, source: {system: "dnd5e",
  pack: "tables24", id: table._id, book: "SRD 5.2", license: "CC-BY-4.0", rules: "2024", owner: owner.name}}));

/** What a converted Item is: automated, manual (it spends its cost only), or a passive feature. */
function kind(item) {
  if ( (item.type === "feature") || (item.type === "gear") ) return item.type;
  return item.flags.wildpath.conversion.notes.some(note => note.startsWith("not automated")) ? "manual" : "automated";
}

// Never anything but SRD 5.2 under the repository.
for ( const document of [...items, ...actors, ...progressions, ...convertedTables] ) {
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
write("packs/_source/srd-tables", convertedTables);

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
