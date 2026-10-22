import {test} from "node:test";
import assert from "node:assert/strict";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";
import {tmpdir} from "node:os";
import {insideRepository} from "../scripts/content/local-module.mjs";

const repository = join(dirname(fileURLToPath(import.meta.url)), "..");

test("a local book package is never written inside this repository, however the path is given", () => {
  assert.equal(insideRepository(join(repository, "modules", "wildpath-dnd-players-handbook")), true);
  assert.equal(insideRepository(join(repository, "..", "Other", "..", "WildPath-x", "..", "WildPath", "x")), true, "through a sibling folder");
  assert.equal(insideRepository(repository), true);
  assert.equal(insideRepository(join(tmpdir(), "FoundryVTT", "Data", "modules", "wildpath-x")), false);
  assert.equal(insideRepository(`${repository}-other`), false, "a folder whose name only starts the same");
});
