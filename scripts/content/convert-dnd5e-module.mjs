import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, relative, resolve} from "node:path";
import {compilePack, extractPack} from "@foundryvtt/foundryvtt-cli";
import {convertActor, convertItem, isSrd2024, nameIndex, scaleTables, slugify} from "./dnd5e-to-wildpath.mjs";
import {readPack} from "./packs.mjs";
import {validateActionDefinition} from "../../module/helpers/action-definitions.mjs";

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
if ( !relative(process.cwd(), target).startsWith("..") ) throw new Error(`Refusing to write ${target}: it is inside this repository.`);
const manifest = JSON.parse(readFileSync(join(source, "module.json"), "utf8"));

// Copy and extract every pack: opening a LevelDB pack writes to it, so the source module is never opened.
const work = mkdtempSync(join(tmpdir(), `wildpath-${moduleId}-`));
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
const scales = scaleTables([...srdDocuments, ...all].filter(document => document.type === "class"));
const names = nameIndex([...srdDocuments, ...all]);
// The spells a creature's Spellcasting casts, by id (the book's own and the SRD's).
const spells = Object.fromEntries([...srdDocuments, ...all].filter(document => document.type === "spell").map(document => [document._id, document]));
// The creatures a summon brings, by dnd5e id: the book's own (its creatures pack), else the SRD's.
const creatures = Object.fromEntries([
  ...srdDocuments.filter(document => (document.type === "npc") && isSrd2024(document))
    .map(document => [document._id, `Compendium.wildpath.srd-creatures.Actor.${document._id}`]),
  ...(manifest.packs ?? []).filter(pack => pack.type === "Actor").flatMap(documents).filter(document => document.type === "npc")
    .map(document => [document._id, `Compendium.wildpath-${moduleId}.creatures.Actor.${document._id}`])]);
const options = {scales, names, licensed: () => true, book: manifest.title, images: ["icons/", `modules/${moduleId}/`], spells, creatures};

const items = [];
const actors = [];
const notes = [];
for ( const pack of manifest.packs ?? [] ) {
  for ( const document of documents(pack) ) {
    if ( (pack.type === "Item") && ["spell", "weapon", "feat", "equipment", "consumable", "tool", "loot", "container"].includes(document.type) ) {
      const result = convertItem(document, {...options, pack: pack.name});
      items.push(...result.items);
      notes.push([document.name, result.notes]);
    } else if ( (pack.type === "Actor") && (document.type === "npc") ) {
      const result = convertActor(document, {...options, pack: pack.name});
      if ( !result.ok ) continue;
      actors.push(result.actor);
      notes.push([document.name, result.notes]);
    }
  }
}

// Every Action must be valid and every id unique before anything is written.
const actions = [...items, ...actors.flatMap(actor => actor.items)].filter(item => item.type === "action");
const invalid = actions.filter(item => !validateActionDefinition(item.system.definition).ok).map(item => item.name);
// Ids are unique within each pack (a spell and the creature it summons may share one across the two).
const duplicates = [items, actors].flatMap(list => list.map(document => document._id).filter((id, index, ids) => ids.indexOf(id) !== index));
if ( invalid.length || duplicates.length ) throw new Error(`Not written. Invalid Actions: ${invalid.join(", ") || "none"}; duplicate ids: ${duplicates.join(", ") || "none"}`);

// The package: its manifest and its two packs, compiled from JSON sources written in the work folder.
rmSync(target, {recursive: true, force: true});
mkdirSync(target, {recursive: true});
const packs = [["items", "Item", items, `${manifest.title}: Spells, Equipment and Features`], ["creatures", "Actor", actors, `${manifest.title}: Creatures`]]
  .filter(([, , list]) => list.length);
for ( const [name, , list] of packs ) {
  const folder = join(work, "out", name);
  mkdirSync(folder, {recursive: true});
  for ( const document of list ) writeFileSync(join(folder, `${slugify(document.name)}-${document._id}.json`), JSON.stringify(document));
  await compilePack(folder, join(target, "packs", name), {log: false});
}
writeFileSync(join(target, "module.json"), `${JSON.stringify({
  id: `wildpath-${moduleId}`,
  title: `WildPath: ${manifest.title}`,
  description: `${manifest.title}, converted on this computer for the WildPath system. For personal use only: do not share or publish it.`,
  version: manifest.version ?? "1.0.0",
  compatibility: {minimum: "14", verified: "14.369"},
  relationships: {systems: [{id: "wildpath", type: "system"}]},
  packs: packs.map(([name, type, , label]) => ({name, label, path: `packs/${name}`, type, system: "wildpath",
    ownership: {PLAYER: "OBSERVER", ASSISTANT: "OWNER"}})),
  flags: {wildpath: {convertedFrom: moduleId, sourceVersion: manifest.version ?? null}}
}, null, 2)}\n`);
writeFileSync(join(target, "conversion-notes.json"), JSON.stringify(Object.fromEntries(notes.filter(([, list]) => list.length)), null, 2));
rmSync(work, {recursive: true, force: true});
const kinds = items.reduce((total, item) => {
  const kind = ["feature", "gear"].includes(item.type) ? item.type : (item.flags.wildpath.conversion.notes.some(note => note.startsWith("not automated")) ? "manual" : "automated");
  return {...total, [kind]: (total[kind] ?? 0) + 1};
}, {});
console.log(`${target}: Items ${JSON.stringify(kinds)}, creatures ${actors.length}${existsSync(join(target, "module.json")) ? "" : " (no manifest!)"}`);
