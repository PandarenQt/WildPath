import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, readdirSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {compilePack, extractPack} from "@foundryvtt/foundryvtt-cli";
import {validateActionDefinition} from "../module/helpers/action-definitions.mjs";

const SOURCE = "packs/_source";
const sources = name => readdirSync(join(SOURCE, name)).map(file => JSON.parse(readFileSync(join(SOURCE, name, file), "utf8")));

test("every built-in pack source folder is declared in system.json at the path the build writes", () => {
  const declared = JSON.parse(readFileSync("system.json", "utf8")).packs ?? [];
  for ( const name of readdirSync(SOURCE) ) {
    assert.deepEqual(declared.filter(pack => pack.name === name).map(pack => [pack.path, pack.system]),
      [[`packs/${name}`, "wildpath"]], name);
  }
});

test("every Action in the built-in pack is a valid Action Item with a stable, unique identity", () => {
  const items = sources("actions");
  assert.ok(items.length >= 9);
  assert.equal(new Set(items.map(item => item._id)).size, items.length, "unique Document ids");
  assert.equal(new Set(items.map(item => item.system.definition.id)).size, items.length, "unique definition ids");
  for ( const item of items ) {
    assert.match(item._id, /^[a-zA-Z0-9]{16}$/, item.name);
    assert.equal(item._key, `!items!${item._id}`, item.name);
    assert.equal(item.type, "action", item.name);
    const validation = validateActionDefinition(item.system.definition);
    assert.equal(validation.ok, true, `${item.name}: ${JSON.stringify(validation.errors)}`);
  }
});

test("the Foundry CLI compiles the sources into a LevelDB pack that reads back unchanged", async t => {
  const scratch = mkdtempSync(join(tmpdir(), "wildpath-pack-"));
  t.after(() => rmSync(scratch, {recursive: true, force: true}));
  await compilePack(join(SOURCE, "actions"), join(scratch, "actions"));
  await extractPack(join(scratch, "actions"), join(scratch, "extracted"));
  const read = readdirSync(join(scratch, "extracted")).map(file => JSON.parse(readFileSync(join(scratch, "extracted", file), "utf8")));
  const byId = items => Object.fromEntries(items.map(({_id, name, system}) => [_id, {name, definition: system.definition}]));
  assert.deepEqual(byId(read), byId(sources("actions")));
});
