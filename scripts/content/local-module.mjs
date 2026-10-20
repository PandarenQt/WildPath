import {existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, relative} from "node:path";
import {compilePack} from "@foundryvtt/foundryvtt-cli";
import {slugify} from "./dnd5e-to-wildpath.mjs";
import {validateActionDefinition} from "../../module/helpers/action-definitions.mjs";

/**
 * Write a local WildPath module package (a book the maintainer owns: converted from a bought Foundry module, or built
 * from a paper book's sources) at `target`: its manifest, its packs compiled from JSON, and its conversion notes.
 * - It is personal: a path inside this repository is refused, and the package must never be committed or shared.
 * - Every Action must be valid and every id unique within its pack, or nothing is written.
 * - The new package is built beside the old one and swapped in: the old one is renamed aside first, which fails without
 *   changing anything while Foundry holds its packs open (return to the setup screen, then run it again).
 * `packs`: `[name, type ("Item" | "Actor"), documents, label]`; empty ones are left out.
 */
export async function writeLocalModule({target, id, title, description, version="1.0.0", packs, flags={}, notes=[]}) {
  if ( !relative(process.cwd(), target).startsWith("..") ) throw new Error(`Refusing to write ${target}: it is inside this repository.`);
  const written = packs.filter(([, , list]) => list.length);
  const actions = written.flatMap(([, , list]) => list.flatMap(document => [document, ...(document.items ?? [])]))
    .filter(item => item.type === "action");
  const invalid = actions.filter(item => !validateActionDefinition(item.system.definition).ok).map(item => item.name);
  const duplicates = written.flatMap(([, , list]) => list.map(document => document._id).filter((entry, index, ids) => ids.indexOf(entry) !== index));
  if ( invalid.length || duplicates.length ) throw new Error(`Not written. Invalid Actions: ${invalid.join(", ") || "none"}; duplicate ids: ${duplicates.join(", ") || "none"}`);

  const work = mkdtempSync(join(tmpdir(), `${id}-`));
  const fresh = `${target}.new`;
  rmSync(fresh, {recursive: true, force: true});
  mkdirSync(fresh, {recursive: true});
  try {
    for ( const [name, , list] of written ) {
      const folder = join(work, name);
      mkdirSync(folder, {recursive: true});
      for ( const document of list ) writeFileSync(join(folder, `${slugify(document.name)}-${document._id}.json`), JSON.stringify(document));
      await compilePack(folder, join(fresh, "packs", name), {log: false});
    }
    writeFileSync(join(fresh, "module.json"), `${JSON.stringify({
      id, title, description, version,
      compatibility: {minimum: "14", verified: "14.369"},
      relationships: {systems: [{id: "wildpath", type: "system"}]},
      packs: written.map(([name, type, , label]) => ({name, label, path: `packs/${name}`, type, system: "wildpath",
        ownership: {PLAYER: "OBSERVER", ASSISTANT: "OWNER"}})),
      flags: {wildpath: flags}
    }, null, 2)}\n`);
    writeFileSync(join(fresh, "conversion-notes.json"), JSON.stringify(Object.fromEntries(notes.filter(([, list]) => list.length)), null, 2));
    const old = `${target}.old`;
    rmSync(old, {recursive: true, force: true});
    if ( existsSync(target) ) {
      try { renameSync(target, old); }
      catch (error) { throw new Error(`${target} is in use (is Foundry running with it open?); nothing was changed. ${error.message}`); }
    }
    renameSync(fresh, target);
    rmSync(old, {recursive: true, force: true});
  } finally {
    rmSync(work, {recursive: true, force: true});
    rmSync(fresh, {recursive: true, force: true});
  }
  return target;
}
