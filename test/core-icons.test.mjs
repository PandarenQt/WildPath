import {test} from "node:test";
import assert from "node:assert/strict";
import {existsSync, readFileSync, readdirSync} from "node:fs";
import {join} from "node:path";

// Foundry's own icons, where the local install keeps them; the check is skipped on a machine without Foundry.
const FOUNDRY_PUBLIC = process.env.FOUNDRY_PUBLIC ?? "C:/Program Files/Foundry Virtual Tabletop/resources/app/public";

/** Every .mjs under a folder, recursively. */
function moduleFiles(folder) {
  return readdirSync(folder, {withFileTypes: true}).flatMap(entry => (entry.isDirectory() ? moduleFiles(join(folder, entry.name))
    : (entry.name.endsWith(".mjs") ? [join(folder, entry.name)] : [])));
}

test("every Foundry core icon the system's code names exists (a missing one 404s each time a status list renders)",
  {skip: !existsSync(join(FOUNDRY_PUBLIC, "icons")) && "Foundry is not installed here"}, () => {
    const named = new Set(moduleFiles("module").flatMap(file => [...readFileSync(file, "utf8").matchAll(/["'](icons\/[\w/.-]+\.(?:webp|svg|png))["']/g)]
      .map(match => match[1])));
    assert.ok(named.size > 10, "the code names core icons");
    assert.deepEqual([...named].filter(icon => !existsSync(join(FOUNDRY_PUBLIC, icon))), []);
  });
