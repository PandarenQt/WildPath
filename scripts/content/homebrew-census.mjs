import {cpSync, existsSync, mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {extractPack} from "@foundryvtt/foundryvtt-cli";
import {builderGaps} from "../../module/helpers/action-builder.mjs";
import {ruleGaps} from "../../module/helpers/rule-builder.mjs";
import {readPack} from "./packs.mjs";

/**
 * Can a homebrewer rebuild every converted effect in the item sheet's Builder and rule rows, without the Advanced
 * JSON? Counts, per source, the Actions and rule lists that cannot be, by what the Builder lacks (`builderGaps`,
 * `ruleGaps`). Sources: the SRD packs (packs/_source/srd-*) and the local book packages, whose LevelDB packs are
 * copied before they are read (opening one writes to it). Run it whenever content is converted (homebrew-content-builder.md).
 *
 *   node scripts/content/homebrew-census.mjs [--data <Foundry Data folder>]
 */
const data = process.argv.includes("--data") ? process.argv[process.argv.indexOf("--data") + 1]
  : join(process.env.LOCALAPPDATA ?? "", "FoundryVTT", "Data");
const abilities = ["might", "agility", "fortitude", "intellect", "wits", "presence"];

/** Every Item of a list of Documents, the Items of Actors included. */
const itemsOf = documents => documents.flatMap(document => (document.items ? document.items : [document]));

const sources = {SRD: itemsOf(["srd-items", "srd-creatures", "srd-classes"].flatMap(pack => readPack("packs/_source", pack)))};
const work = mkdtempSync(join(tmpdir(), "wildpath-census-"));
try {
  for ( const id of ["dnd-players-handbook", "dnd-dungeon-masters-guide", "dnd-monster-manual", "dnd-tashas-cauldron"] ) {
    const root = join(data, "modules", `wildpath-${id}`);
    if ( !existsSync(join(root, "module.json")) ) continue;
    const manifest = JSON.parse(readFileSync(join(root, "module.json"), "utf8"));
    const documents = [];
    for ( const pack of manifest.packs ?? [] ) {
      cpSync(join(root, pack.path), join(work, id, "db", pack.name), {recursive: true});
      await extractPack(join(work, id, "db", pack.name), join(work, id, "json", pack.name), {log: false});
      documents.push(...readPack(join(work, id, "json"), pack.name));
    }
    sources[id.replace("dnd-", "")] = itemsOf(documents);
  }
} finally {
  rmSync(work, {recursive: true, force: true});
}

const counts = {};
const totals = {};
for ( const [source, items] of Object.entries(sources) ) {
  totals[source] = {actions: 0, editable: 0, rules: 0, rulesEditable: 0};
  for ( const item of items ) {
    const definition = item.type === "action" ? item.system?.definition : null;
    const gaps = new Set();
    if ( definition ) {
      totals[source].actions += 1;
      const found = builderGaps(definition, {abilities});
      if ( !found.length ) totals[source].editable += 1;
      for ( const gap of found ) gaps.add(gap);
    }
    if ( item.system?.ruleElements?.length ) {
      totals[source].rules += 1;
      const found = ruleGaps(item.system.ruleElements, {abilities});
      if ( !found.length ) totals[source].rulesEditable += 1;
      for ( const gap of found ) gaps.add(`rules.${gap}`);
    }
    for ( const gap of gaps ) {
      counts[gap] ??= {};
      counts[gap][source] = (counts[gap][source] ?? 0) + 1;
    }
  }
}
const columns = Object.keys(sources);
console.log(columns.map(column => `${column}: ${totals[column].editable}/${totals[column].actions} Actions and `
  + `${totals[column].rulesEditable}/${totals[column].rules} rule lists fully editable`).join("\n"));
console.log(`\n| Builder gap | ${columns.join(" | ")} | Total |\n| --- | ${columns.map(() => "---").join(" | ")} | --- |`);
const rows = Object.entries(counts).map(([gap, bySource]) => [gap, columns.map(column => bySource[column] ?? 0)])
  .sort((a, b) => b[1].reduce((x, y) => x + y, 0) - a[1].reduce((x, y) => x + y, 0));
for ( const [gap, values] of rows ) console.log(`| ${gap} | ${values.join(" | ")} | ${values.reduce((x, y) => x + y, 0)} |`);
