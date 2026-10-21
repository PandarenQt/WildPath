import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtempSync, readFileSync, readdirSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, relative} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

function files(dir, extension) {
  return readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path, extension) : (entry.name.endsWith(extension) ? [path] : []);
  });
}

test("every .mjs built from a .mts is what the .mts builds today (npm run build was run)", () => {
  const out = mkdtempSync(join(tmpdir(), "wildpath-mts-"));
  try {
    execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", join(root, "tsconfig.runtime.json"),
      "--outDir", out, "--rootDir", root], {cwd: root, stdio: "pipe"});
    const stale = files(join(root, "module"), ".mts").map(source => relative(root, source).replace(/\.mts$/u, ".mjs"))
      .filter(built => readFileSync(join(out, built), "utf8") !== readFileSync(join(root, built), "utf8"));
    assert.deepEqual(stale, []);
  } finally {
    rmSync(out, {recursive: true, force: true});
  }
});
