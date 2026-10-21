import {test} from "node:test";
import assert from "node:assert/strict";
import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";

// A control byte in source (a backspace where a regex meant `\b`) breaks what it touches without an error.
test("sources hold no control bytes but tabs and line ends", () => {
  const found = [];
  const walk = dir => {
    for ( const entry of readdirSync(dir, {withFileTypes: true}) ) {
      const path = join(dir, entry.name);
      if ( entry.isDirectory() ) walk(path);
      else if ( /\.(?:m?[jt]s|mts|json|hbs|css|md)$/.test(entry.name) ) {
        const bytes = readFileSync(path);
        if ( bytes.some(byte => (byte < 32) && ![9, 10, 13].includes(byte)) ) found.push(path);
      }
    }
  };
  for ( const dir of ["module", "scripts", "test", "lang", "templates", "styles", "docs"] ) walk(dir);
  assert.deepEqual(found, []);
});
