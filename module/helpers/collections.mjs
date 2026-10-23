/**
 * The members of a Foundry collection, a Map, a Set, an array or a plain object, as an array; none for nothing.
 * @param {Iterable<any>|object|null|undefined} collection
 * @returns {any[]}
 */
export function collectionContents(collection) {
  if ( collection == null ) return [];
  if ( Array.isArray(collection) ) return collection;
  if ( typeof collection.values === "function" ) return [...collection.values()];
  if ( typeof collection === "object" ) return Object.values(collection);
  return [];
}
