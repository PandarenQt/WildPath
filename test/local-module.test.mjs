import {test} from "node:test";
import assert from "node:assert/strict";
import {existsSync, mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {writeLocalModule} from "../scripts/content/local-module.mjs";

test("a local module is written outside the repository, swapped in on a rebuild, and not at all with an invalid Action", async () => {
  const root = mkdtempSync(join(tmpdir(), "wildpath-local-"));
  try {
    const target = join(root, "wildpath-test-book");
    const feat = {_id: "testfeat00000001", _key: "!items!testfeat00000001", name: "Test Feat", type: "feature", system: {active: true, ruleElements: []},
      flags: {wildpath: {source: {system: "wildpath-paper"}}}};
    const write = items => writeLocalModule({target, id: "wildpath-test-book", title: "Test", description: "", packs: [["items", "Item", items, "Items"]]});
    await write([feat]);
    await write([feat]);
    assert.equal(JSON.parse(readFileSync(join(target, "module.json"), "utf8")).id, "wildpath-test-book");
    assert.deepEqual([existsSync(`${target}.old`), existsSync(`${target}.new`)], [false, false], "nothing left beside it");
    const broken = {_id: "testaction000001", _key: "!items!testaction000001", name: "Broken", type: "action", system: {definition: {schemaVersion: 1}}};
    await assert.rejects(write([feat, broken]), /Invalid Actions: Broken/);
    assert.ok(existsSync(join(target, "module.json")), "the old package stays");
    await assert.rejects(writeLocalModule({target: join(process.cwd(), "tmp-module"), id: "x", title: "x", description: "", packs: []}), /inside this repository/);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
