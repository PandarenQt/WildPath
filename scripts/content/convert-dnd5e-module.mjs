import {cpSync, existsSync, mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {extractPack} from "@foundryvtt/foundryvtt-cli";
import {spellListsOf, convertTable, PROGRESSION_TYPES, baseWeapons, beastsOf, convertActor, convertFacility, convertItem, convertProgression, isSrd2024, nameIndex, scaleTables,
  withRedirects} from "./dnd5e-to-wildpath.mjs";
import {readPack} from "./packs.mjs";
import {insideRepository, writeLocalModule} from "./local-module.mjs";

/**
 * Convert a dnd5e content module the maintainer owns (a Player's Handbook, a Monster Manual) into a local WildPath
 * module package: `<Foundry Data>/modules/wildpath-<module>`, with an Items pack and a Creatures pack.
 *
 *   node scripts/content/convert-dnd5e-module.mjs <module-id> [--data <Foundry Data folder>] [--srd <extracted dnd5e packs>]
 *
 * - The source module's packs are copied to a temporary folder and extracted there; the module itself is only read.
 * - The package is personal: it is written outside this repository (the script refuses a path inside it) and must
 *   never be committed or shared. Its documents keep the source module's art paths, which Foundry serves locally.
 * - `--srd` adds the extracted SRD packs (convert-dnd5e-srd.mjs) for class scale values and link names.
 * - Enable the package in the world after Foundry next scans its modules (return to setup and launch the world).
 */
const [moduleId, ...rest] = process.argv.slice(2);
if ( !moduleId ) throw new Error("Usage: convert-dnd5e-module.mjs <module-id> [--data <Foundry Data folder>] [--srd <extracted dnd5e packs>]");
const option = name => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : null);
const data = resolve(option("--data") ?? join(process.env.LOCALAPPDATA ?? "", "FoundryVTT", "Data"));
const source = join(data, "modules", moduleId);
const target = join(data, "modules", `wildpath-${moduleId}`);
if ( insideRepository(target) ) throw new Error(`Refusing to write ${target}: it is inside this repository.`);
const manifest = JSON.parse(readFileSync(join(source, "module.json"), "utf8"));

// Copy and extract every pack: opening a LevelDB pack writes to it, so the source module is never opened.
const work = mkdtempSync(join(tmpdir(), `wildpath-${moduleId}-`));
// The extracted book is removed however the run ends, a failed one too.
process.on("exit", () => rmSync(work, {recursive: true, force: true}));
const extracted = join(work, "json");
for ( const pack of manifest.packs ?? [] ) {
  if ( !["Item", "Actor", "JournalEntry", "RollTable"].includes(pack.type) ) continue;
  cpSync(join(source, pack.path), join(work, "db", pack.name), {recursive: true});
  await extractPack(join(work, "db", pack.name), join(extracted, pack.name), {log: false});
}
const documents = pack => readPack(extracted, pack.name);
const srd = option("--srd");
const all = (manifest.packs ?? []).flatMap(documents);
const srdDocuments = srd ? ["classes24", "spells24", "equipment24", "feats24", "origins24", "actors24", "content24"].flatMap(pack => readPack(srd, pack)) : [];
const scales = scaleTables([...srdDocuments, ...all]);
const names = nameIndex([...srdDocuments, ...all]);
// The spells the other installed books hold (a Monster Manual creature's Player's Handbook spell), read the same way.
const otherBooks = ["dnd-players-handbook", "dnd-dungeon-masters-guide", "dnd-monster-manual", "dnd-tashas-cauldron", "dnd-xanathars-guide"]
  .filter(id => (id !== moduleId) && existsSync(join(data, "modules", id, "module.json")));
const otherSpells = [];
for ( const id of otherBooks ) {
  const other = JSON.parse(readFileSync(join(data, "modules", id, "module.json"), "utf8"));
  for ( const pack of (other.packs ?? []).filter(entry => entry.type === "Item") ) {
    const name = `${id}--${pack.name}`;
    cpSync(join(data, "modules", id, pack.path), join(work, "db", name), {recursive: true});
    await extractPack(join(work, "db", name), join(extracted, name), {log: false});
    otherSpells.push(...readPack(extracted, name).filter(document => document.type === "spell"));
  }
}
// The spells a creature's Spellcasting casts, by id (the book's own, the other books' and the SRD's).
const spells = Object.fromEntries([...otherSpells, ...srdDocuments, ...all].filter(document => document.type === "spell")
  .map(document => [document._id, document]));
// The creatures a summon brings, by dnd5e id: the book's own (its creatures pack), else the SRD's; an old id the book
// redirects (its scripts/redirects.mjs) brings the one it points to.
const redirects = existsSync(join(source, "scripts", "redirects.mjs")) ? readFileSync(join(source, "scripts", "redirects.mjs"), "utf8") : "";
const creatures = withRedirects(Object.fromEntries([
  ...srdDocuments.filter(document => (document.type === "npc") && isSrd2024(document))
    .map(document => [document._id, `Compendium.wildpath.srd-creatures.Actor.${document._id}`]),
  ...(manifest.packs ?? []).filter(pack => pack.type === "Actor").flatMap(documents).filter(document => document.type === "npc")
    .map(document => [document._id, `Compendium.wildpath-${moduleId}.creatures.Actor.${document._id}`])]), redirects);
// The Beasts Polymorph may choose: the SRD's and the book's own.
const beasts = beastsOf([...srdDocuments.filter(isSrd2024), ...(manifest.packs ?? []).filter(pack => pack.type === "Actor").flatMap(documents)],
  document => creatures[document._id]).filter(beast => beast.uuid);
// Each document's uses by id (a formula): an enchantment's limit is the uses of the Item it spends (Infuse Item).
const usesOf = Object.fromEntries(all.filter(document => (typeof document.system?.uses?.max === "string") && document.system.uses.max)
  .map(document => [document._id, document.system.uses.max]));
// The class spell lists each spell is on: the SRD's, and the book's own pages (a Player's Handbook's).
const spellLists = spellListsOf([...(srd ? readPack(srd, "content24") : []), ...all.filter(document => Array.isArray(document.pages))]);
const options = {scales, names, licensed: () => true, book: manifest.title, images: ["icons/", `modules/${moduleId}/`], spells, creatures, beasts,
  usesOf, spellLists, weapons: baseWeapons([...srdDocuments, ...all])};

const items = [];
const actors = [];
const progressions = [];
const notes = [];
// What each of the book's documents became: its gear (which brings its Actions), else all its Items.
const convertedIds = new Map();
for ( const pack of manifest.packs ?? [] ) {
  for ( const document of documents(pack) ) {
    if ( (pack.type === "Item") && ["spell", "weapon", "feat", "equipment", "consumable", "tool", "loot", "container"].includes(document.type) ) {
      const result = convertItem(document, {...options, pack: pack.name});
      items.push(...result.items);
      const gear = result.items.filter(item => item.type === "gear");
      convertedIds.set(document._id, (gear.length ? gear : result.items).map(item => item._id));
      notes.push([document.name, result.notes]);
    } else if ( (pack.type === "Item") && (document.type === "facility") ) {
      const result = convertFacility(document, {...options, pack: pack.name});
      if ( result.ok ) items.push(result.item);
    } else if ( (pack.type === "Actor") && (document.type === "npc") ) {
      const result = convertActor(document, {...options, pack: pack.name});
      if ( !result.ok ) continue;
      actors.push(result.actor);
      notes.push([document.name, result.notes]);
    }
  }
}

// Classes, subclasses, species and backgrounds (G8): what they grant is the book's own converted Items, else the SRD's.
const uuidOf = uuid => {
  const id = String(uuid).split(".").pop();
  if ( convertedIds.has(id) ) return convertedIds.get(id).map(entry => `Compendium.wildpath-${moduleId}.items.Item.${entry}`);
  return String(uuid).startsWith("Compendium.dnd5e.") ? [`Compendium.wildpath.srd-items.Item.${id}`] : [];
};
for ( const pack of manifest.packs ?? [] ) {
  if ( pack.type !== "Item" ) continue;
  for ( const document of documents(pack) ) {
    if ( !PROGRESSION_TYPES[document.type] ) continue;
    const result = convertProgression(document, {...options, uuidOf, pack: pack.name});
    if ( !result.ok ) continue;
    progressions.push(result.item);
    notes.push([document.name, result.notes]);
  }
}

// The book's roll tables (the DMG's Bastion Events, treasure, ...): a result linking an Item converted here points to it.
const tables = (manifest.packs ?? []).filter(pack => pack.type === "RollTable").flatMap(documents)
  .filter(table => table.results?.length).map(table => convertTable(table, {source: {system: "dnd5e", book: manifest.title},
    uuidOf: uuid => uuidOf(uuid)[0] ?? null}));

// The package: its manifest, its packs and its notes (local-module.mjs: validated, then swapped in).
await writeLocalModule({target, id: `wildpath-${moduleId}`, title: `WildPath: ${manifest.title}`,
  description: `${manifest.title}, converted on this computer for the WildPath system. For personal use only: do not share or publish it.`,
  version: manifest.version ?? "1.0.0",
  packs: [["items", "Item", items, `${manifest.title}: Spells, Equipment and Features`], ["creatures", "Actor", actors, `${manifest.title}: Creatures`],
    ["classes", "Item", progressions, `${manifest.title}: Classes and Origins`], ["tables", "RollTable", tables, `${manifest.title}: Tables`]],
  flags: {convertedFrom: moduleId, sourceVersion: manifest.version ?? null}, notes});
const kinds = items.reduce((total, item) => {
  const kind = ["feature", "gear"].includes(item.type) ? item.type : (item.flags.wildpath.conversion.notes.some(note => note.startsWith("not automated")) ? "manual" : "automated");
  return {...total, [kind]: (total[kind] ?? 0) + 1};
}, {});
console.log(`${target}: Items ${JSON.stringify(kinds)}, creatures ${actors.length}, tables ${tables.length}${existsSync(join(target, "module.json")) ? "" : " (no manifest!)"}`);
