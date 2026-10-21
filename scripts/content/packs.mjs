import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";

/** The Documents of one pack extracted with the Foundry CLI (`extractPack`), RollTables too; none when the folder is missing. */
export function readPack(root, pack) {
  try {
    return readdirSync(join(root, pack)).filter(file => file.endsWith(".json"))
      .map(file => JSON.parse(readFileSync(join(root, pack, file), "utf8"))).filter(document => document.name && (document.type || Array.isArray(document.results)));
  } catch {
    return [];
  }
}
