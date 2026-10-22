import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";

/** The Documents of one pack extracted with the Foundry CLI (`extractPack`), RollTables and JournalEntries too; none when the folder is missing. */
export function readPack(root, pack) {
  try {
    return readdirSync(join(root, pack)).filter(file => file.endsWith(".json"))
      .map(file => JSON.parse(readFileSync(join(root, pack, file), "utf8"))).filter(document => document.name && (document.type || Array.isArray(document.results) || Array.isArray(document.pages)));
  } catch (error) {
    // Only a missing folder is no pack; anything else (a broken file, no access) must not read as an empty pack.
    if ( error?.code === "ENOENT" ) return [];
    throw error;
  }
}
