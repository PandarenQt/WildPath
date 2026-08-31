export const TEST_PERSISTENCE_CODES = Object.freeze({
  OK: "OK",
  NO_UPDATES: "NO_UPDATES",
  FAILED: "FAILED",
  DOCUMENT_NOT_FOUND: "DOCUMENT_NOT_FOUND"
});

/* -------------------------------------------- */

export function createTestDocumentPersistenceAdapter({
  actors={},
  failOn=null
}={}) {
  const actorStore = normalizeActorStore(actors);
  const operations = [];
  let nextEmbeddedId = 1;

  const adapter = {
    id: "test-document-persistence",
    type: "test-document-persistence",
    label: "Test Document Persistence",
    operations,
    actors: actorStore,

    async updateActor({actor=null, actorRef=null, updates={}, metadata={}}={}) {
      const document = actor ?? resolveFromStore(actorStore, actorRef);
      const operation = operationRecord("updateActor", {
        actorRef: actorRef ?? documentRef(document),
        updates,
        metadata
      });
      operations.push(operation);
      maybeFail(operation, failOn);
      if ( !document ) return failure(TEST_PERSISTENCE_CODES.DOCUMENT_NOT_FOUND, operation);
      if ( !Object.keys(updates ?? {}).length ) return success(TEST_PERSISTENCE_CODES.NO_UPDATES, operation);
      applyDotPathUpdates(document, updates);
      return success(TEST_PERSISTENCE_CODES.OK, operation);
    },

    async createEmbeddedDocuments({parent=null, actor=null, actorRef=null, embeddedName, documents=[], metadata={}}={}) {
      const document = parent ?? actor ?? resolveFromStore(actorStore, actorRef);
      const operation = operationRecord("createEmbeddedDocuments", {
        actorRef: actorRef ?? documentRef(document),
        embeddedName,
        documents,
        metadata
      });
      operations.push(operation);
      maybeFail(operation, failOn);
      if ( !document ) return failure(TEST_PERSISTENCE_CODES.DOCUMENT_NOT_FOUND, operation);

      const created = documents.map(data => createTestEmbeddedDocument({
        id: data._id ?? data.id ?? `effect-${nextEmbeddedId++}`,
        data,
        actor: document,
        operations
      }));
      if ( String(embeddedName) === "ActiveEffect" ) {
        document.effects = appendCollection(document.effects, created);
      }
      return success(TEST_PERSISTENCE_CODES.OK, {
        ...operation,
        result: created
      });
    },

    async updateDocument({document=null, documentRef=null, updates={}, metadata={}}={}) {
      const operation = operationRecord("updateDocument", {
        documentRef: documentRef ?? documentRefOf(document),
        updates,
        metadata
      });
      operations.push(operation);
      maybeFail(operation, failOn);
      if ( !document ) return failure(TEST_PERSISTENCE_CODES.DOCUMENT_NOT_FOUND, operation);
      if ( !Object.keys(updates ?? {}).length ) return success(TEST_PERSISTENCE_CODES.NO_UPDATES, operation);
      applyDotPathUpdates(document, updates);
      return success(TEST_PERSISTENCE_CODES.OK, operation);
    },

    async deleteDocument({document=null, documentRef=null, metadata={}}={}) {
      const operation = operationRecord("deleteDocument", {
        documentRef: documentRef ?? documentRefOf(document),
        metadata
      });
      operations.push(operation);
      maybeFail(operation, failOn);
      if ( !document ) return failure(TEST_PERSISTENCE_CODES.DOCUMENT_NOT_FOUND, operation);
      deleteFromParent(document);
      document.deleted = true;
      return success(TEST_PERSISTENCE_CODES.OK, operation);
    },

    async toggleStatusEffect({actor=null, actorRef=null, statusId, active=true, metadata={}}={}) {
      const document = actor ?? resolveFromStore(actorStore, actorRef);
      const operation = operationRecord("toggleStatusEffect", {
        actorRef: actorRef ?? documentRef(document),
        statusId,
        active,
        metadata
      });
      operations.push(operation);
      maybeFail(operation, failOn);
      if ( !document ) return failure(TEST_PERSISTENCE_CODES.DOCUMENT_NOT_FOUND, operation);
      if ( active !== true ) return success(TEST_PERSISTENCE_CODES.OK, {...operation, result: null});

      const existing = collectionContents(document.effects)
        .find(effect => collectionContents(effect.statuses).includes(statusId) || effect.system?.type === statusId);
      if ( existing ) return success(TEST_PERSISTENCE_CODES.OK, {...operation, result: existing});

      const created = createTestEmbeddedDocument({
        id: `effect-${nextEmbeddedId++}`,
        data: {
          type: "condition",
          name: String(statusId),
          statuses: [statusId],
          system: {type: statusId, level: null}
        },
        actor: document,
        operations
      });
      document.effects = appendCollection(document.effects, [created]);
      return success(TEST_PERSISTENCE_CODES.OK, {...operation, result: created});
    }
  };

  return adapter;
}

/* -------------------------------------------- */

function createTestEmbeddedDocument({id, data, actor, operations}) {
  const document = {
    id,
    _id: id,
    uuid: data.uuid ?? `${actor?.uuid ?? actor?.id ?? "Actor.unknown"}.ActiveEffect.${id}`,
    parent: actor,
    actor,
    type: data.type ?? "condition",
    name: data.name ?? null,
    img: data.img ?? null,
    statuses: collectionContents(data.statuses),
    system: clonePlain(data.system ?? {}),
    duration: clonePlain(data.duration ?? null),
    origin: data.origin ?? null,
    flags: clonePlain(data.flags ?? {}),
    async update(updates) {
      operations.push(operationRecord("embeddedDocument.updateFallback", {
        documentRef: documentRefOf(document),
        updates
      }));
      applyDotPathUpdates(document, updates);
      return true;
    },
    async delete() {
      operations.push(operationRecord("embeddedDocument.deleteFallback", {
        documentRef: documentRefOf(document)
      }));
      deleteFromParent(document);
      document.deleted = true;
      return true;
    },
    toObject() {
      return {
        _id: document.id,
        id: document.id,
        uuid: document.uuid,
        type: document.type,
        name: document.name,
        img: document.img,
        statuses: collectionContents(document.statuses),
        system: clonePlain(document.system ?? {}),
        duration: clonePlain(document.duration ?? null),
        origin: document.origin ?? null,
        flags: clonePlain(document.flags ?? {})
      };
    }
  };
  applyDotPathUpdates(document, data);
  return document;
}

function normalizeActorStore(actors) {
  if ( actors instanceof Map ) return actors;
  return new Map(Object.entries(actors ?? {}));
}

function resolveFromStore(store, ref) {
  if ( !ref ) return null;
  return store.get(ref) ?? store.get(String(ref).replace(/^actor:/, "")) ?? null;
}

function appendCollection(collection, entries) {
  if ( collection instanceof Map ) {
    for ( const entry of entries ) collection.set(entry.id, entry);
    return collection;
  }
  return [...collectionContents(collection), ...entries];
}

function deleteFromParent(document) {
  const parent = document?.parent ?? document?.actor ?? null;
  if ( !parent ) return;
  if ( parent.effects instanceof Map ) {
    parent.effects.delete(document.id);
    return;
  }
  if ( Array.isArray(parent.effects) ) {
    parent.effects = parent.effects.filter(effect => effect !== document && effect.id !== document.id);
  }
}

function applyDotPathUpdates(target, updates={}) {
  for ( const [path, value] of Object.entries(updates ?? {}) ) {
    setDotPath(target, path, clonePlain(value));
  }
}

function setDotPath(target, path, value) {
  const parts = String(path).split(".").filter(Boolean);
  if ( !parts.length ) return;
  let cursor = target;
  for ( const part of parts.slice(0, -1) ) {
    if ( cursor[part] == null || typeof cursor[part] !== "object" ) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = value;
}

function operationRecord(type, data={}) {
  return {
    type,
    ...clonePlain(data)
  };
}

function maybeFail(operation, failOn) {
  if ( typeof failOn === "function" && failOn(operation) ) {
    throw new Error(`Test persistence failure: ${operation.type}`);
  }
}

function success(code, data={}) {
  return {ok: true, code, ...data};
}

function failure(code, data={}) {
  return {ok: false, code, ...data};
}

function documentRef(document) {
  return document?.uuid ?? (document?.id ? `actor:${document.id}` : null);
}

function documentRefOf(document) {
  return document?.uuid ?? document?.id ?? null;
}

function collectionContents(value) {
  if ( value == null ) return [];
  if ( Array.isArray(value) ) return value;
  if ( value instanceof Set ) return [...value];
  if ( value instanceof Map ) return [...value.values()];
  if ( typeof value.values === "function" ) return [...value.values()];
  return [value];
}

function clonePlain(value) {
  if ( value === undefined ) return undefined;
  if ( value == null ) return value;
  return JSON.parse(JSON.stringify(value));
}
