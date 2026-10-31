import {createHash} from "node:crypto";

/**
 * A short hash of converted documents: it changes when, and only when, what a converter produced changes. Stored in a
 * package's manifest (`flags.wildpath.contentStamp`), it lets a world re-run its re-runnable migrations when converted
 * content changed (module/helpers/migrations.mjs, `runMigrations`).
 * @param {object[]} documents
 * @returns {string}
 */
export function contentStamp(documents) {
  const hash = createHash("sha1");
  for ( const document of documents ) hash.update(JSON.stringify(document));
  return hash.digest("hex").slice(0, 16);
}
