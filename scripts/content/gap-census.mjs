import {existsSync, readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {INFORMATIONAL, noteReason as reason} from "../../module/helpers/conversion-notes.mjs";

/**
 * Count what converted content is not automated, by reason: the SRD packs (packs/_source/srd-*) and the local book
 * packages (their conversion-notes.json). Each reason is counted once per document. Prints a table, one column per
 * source, to rank the engine's gaps by how much content each one holds back.
 *
 *   node scripts/content/gap-census.mjs [--data <Foundry Data folder>]
 */
const data = process.argv.includes("--data") ? process.argv[process.argv.indexOf("--data") + 1]
  : join(process.env.LOCALAPPDATA ?? "", "FoundryVTT", "Data");

/** Per source: document name → notes. */
const sources = {};
const srd = {};
for ( const folder of ["srd-items", "srd-creatures"] ) {
  const path = join("packs/_source", folder);
  if ( !existsSync(path) ) continue;
  for ( const file of readdirSync(path) ) {
    const document = JSON.parse(readFileSync(join(path, file), "utf8"));
    // A creature's own notes hold each of its Items' (prefixed with the Item's name), as a book's creatures' do.
    const entries = (folder === "srd-creatures") ? [document] : [document, ...(document.items ?? [])];
    for ( const entry of entries ) {
      const notes = entry.flags?.wildpath?.conversion?.notes ?? [];
      if ( notes.length ) srd[`${document.name}/${entry.name}`] = notes;
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
