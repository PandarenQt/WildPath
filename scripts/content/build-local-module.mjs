import {existsSync, readFileSync, readdirSync} from "node:fs";
import {join, resolve} from "node:path";
import {slugify} from "./dnd5e-to-wildpath.mjs";
import {writeLocalModule} from "./local-module.mjs";

/**
 * Build a local WildPath module package for a book the maintainer owns on paper (Xanathar's Guide, Humblewood): its
 * documents are already WildPath's, authored on this computer in `<Foundry Data>/wildpath-sources/<book>/`:
 * - `book.json`: `{title, version?, rules? ("2014" | "2024"), thirdParty?}`;
 * - `items/*.json`, `creatures/*.json`, `classes/*.json`: WildPath Items and Actors.
 *
 *   node scripts/content/build-local-module.mjs <book> [--data <Foundry Data folder>]
 *
 * It writes `<Foundry Data>/modules/wildpath-<book>` (local-module.mjs: never inside this repository, never to be
 * committed or shared). Each document is given what it lacks: a stable id from its name, and its source (this book, its
 * rules, an identifier, and `thirdParty` for a third-party book), which the level-up dialog's source settings read.
 */
const [book, ...rest] = process.argv.slice(2);
if ( !book || !/^[a-z0-9-]+$/.test(book) ) throw new Error("Usage: build-local-module.mjs <book: lower-case-with-hyphens> [--data <Foundry Data folder>]");
const option = name => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : null);
const data = resolve(option("--data") ?? join(process.env.LOCALAPPDATA ?? "", "FoundryVTT", "Data"));
const sources = join(data, "wildpath-sources", book);
if ( !existsSync(join(sources, "book.json")) ) throw new Error(`No ${join(sources, "book.json")}: write the book's title there first.`);
const about = JSON.parse(readFileSync(join(sources, "book.json"), "utf8"));
const title = String(about.title ?? book);

/** A stable 16-character id from a name (the same name, the same id, so a rebuild keeps links). */
const stableId = text => {
  let hash = 0;
  for ( const character of String(text) ) hash = ((hash * 31) + character.codePointAt(0)) >>> 0;
  return `${slugify(text).replace(/-/g, "").slice(0, 10)}${hash.toString(36)}`.padEnd(16, "0").slice(0, 16);
};

/** The documents in one folder of its sources, each completed with its id and source. */
function read(folder) {
  const path = join(sources, folder);
  if ( !existsSync(path) ) return [];
  return readdirSync(path).filter(file => file.endsWith(".json")).map(file => {
    const document = JSON.parse(readFileSync(join(path, file), "utf8"));
    document._id ??= stableId(`${book}:${document.name}`);
    const source = document.flags?.wildpath?.source ?? {};
    document.flags = {...(document.flags ?? {}), wildpath: {...(document.flags?.wildpath ?? {}), source: {system: "wildpath-paper", book: title,
      rules: about.rules ?? "2014", identifier: slugify(document.name), ...(about.thirdParty ? {thirdParty: true} : {}), ...source},
    conversion: document.flags?.wildpath?.conversion ?? {notes: []}}};
    document._key ??= `!${folder === "creatures" ? "actors" : "items"}!${document._id}`;
    return document;
  });
}

const target = join(data, "modules", `wildpath-${book}`);
await writeLocalModule({target, id: `wildpath-${book}`, title: `WildPath: ${title}`,
  description: `${title}, from the maintainer's own copy, for the WildPath system. For personal use only: do not share or publish it.`,
  version: String(about.version ?? "1.0.0"),
  packs: [["items", "Item", read("items"), `${title}: Spells, Equipment and Features`], ["creatures", "Actor", read("creatures"), `${title}: Creatures`],
    ["classes", "Item", read("classes"), `${title}: Classes and Origins`]],
  flags: {builtFrom: book}});
console.log(`${target}: built from ${sources}`);
