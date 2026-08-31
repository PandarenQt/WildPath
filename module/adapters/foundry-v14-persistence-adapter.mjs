export const FOUNDRY_PERSISTENCE_CODES = Object.freeze({
  OK: "OK",
  NO_UPDATES: "NO_UPDATES",
  DOCUMENT_NOT_FOUND: "DOCUMENT_NOT_FOUND",
  UNSUPPORTED_OPERATION: "UNSUPPORTED_OPERATION"
});

/* -------------------------------------------- */

export function createFoundryV14DocumentPersistenceAdapter({
  id="foundry-v14-document-persistence",
  documentResolver=null
}={}) {
  return {
    id,
    type: "foundry-v14-document-persistence",
    label: "Foundry V14 Document Persistence",
    async updateActor({actor=null, actorRef=null, updates={}, operation={}, metadata={}}={}) {
      const document = await resolveDocument({document: actor, ref: actorRef, kind: "actor", resolver: documentResolver});
      if ( !document ) return persistenceFailure(FOUNDRY_PERSISTENCE_CODES.DOCUMENT_NOT_FOUND, {
        reason: "Actor document could not be resolved.",
        actorRef,
        metadata
      });
      if ( !Object.keys(updates ?? {}).length ) return persistenceSuccess(FOUNDRY_PERSISTENCE_CODES.NO_UPDATES, {
        actorRef: actorRef ?? documentRef(document),
        updates: {},
        result: null,
        metadata
      });
      if ( typeof document.update !== "function" ) return persistenceFailure(FOUNDRY_PERSISTENCE_CODES.UNSUPPORTED_OPERATION, {
        reason: "Resolved Actor document does not support update().",
        actorRef: actorRef ?? documentRef(document),
        metadata
      });

      const result = await document.update(clonePlain(updates), clonePlain(operation) ?? {});
      return persistenceSuccess(FOUNDRY_PERSISTENCE_CODES.OK, {
        actorRef: actorRef ?? documentRef(document),
        updates,
        result,
        metadata
      });
    },

    async createEmbeddedDocuments({parent=null, actor=null, actorRef=null, embeddedName, documents=[], operation={}, metadata={}}={}) {
      const document = await resolveDocument({document: parent ?? actor, ref: actorRef, kind: "actor", resolver: documentResolver});
      if ( !document ) return persistenceFailure(FOUNDRY_PERSISTENCE_CODES.DOCUMENT_NOT_FOUND, {
        reason: "Parent document could not be resolved for embedded document creation.",
        actorRef,
        embeddedName,
        metadata
      });
      if ( typeof document.createEmbeddedDocuments !== "function" ) return persistenceFailure(FOUNDRY_PERSISTENCE_CODES.UNSUPPORTED_OPERATION, {
        reason: "Resolved parent document does not support createEmbeddedDocuments().",
        actorRef: actorRef ?? documentRef(document),
        embeddedName,
        metadata
      });

      const created = await document.createEmbeddedDocuments(
        String(embeddedName),
        clonePlain(documents) ?? [],
        clonePlain(operation) ?? {}
      );
      return persistenceSuccess(FOUNDRY_PERSISTENCE_CODES.OK, {
        actorRef: actorRef ?? documentRef(document),
        embeddedName,
        documents,
        result: collectionContents(created),
        metadata
      });
    },

    async updateDocument({document=null, documentRef=null, updates={}, operation={}, metadata={}}={}) {
      const resolved = await resolveDocument({document, ref: documentRef, kind: "document", resolver: documentResolver});
      if ( !resolved ) return persistenceFailure(FOUNDRY_PERSISTENCE_CODES.DOCUMENT_NOT_FOUND, {
        reason: "Document could not be resolved for update.",
        documentRef,
        metadata
      });
      if ( !Object.keys(updates ?? {}).length ) return persistenceSuccess(FOUNDRY_PERSISTENCE_CODES.NO_UPDATES, {
        documentRef: documentRef ?? documentRefOf(resolved),
        updates: {},
        result: resolved,
        metadata
      });
      if ( typeof resolved.update !== "function" ) return persistenceFailure(FOUNDRY_PERSISTENCE_CODES.UNSUPPORTED_OPERATION, {
        reason: "Resolved document does not support update().",
        documentRef: documentRef ?? documentRefOf(resolved),
        metadata
      });

      const result = await resolved.update(clonePlain(updates), clonePlain(operation) ?? {});
      return persistenceSuccess(FOUNDRY_PERSISTENCE_CODES.OK, {
        documentRef: documentRef ?? documentRefOf(resolved),
        updates,
        result,
        metadata
      });
    },

    async deleteDocument({document=null, documentRef=null, operation={}, metadata={}}={}) {
      const resolved = await resolveDocument({document, ref: documentRef, kind: "document", resolver: documentResolver});
      if ( !resolved ) return persistenceFailure(FOUNDRY_PERSISTENCE_CODES.DOCUMENT_NOT_FOUND, {
        reason: "Document could not be resolved for deletion.",
        documentRef,
        metadata
      });
      if ( typeof resolved.delete !== "function" ) return persistenceFailure(FOUNDRY_PERSISTENCE_CODES.UNSUPPORTED_OPERATION, {
        reason: "Resolved document does not support delete().",
        documentRef: documentRef ?? documentRefOf(resolved),
        metadata
      });

      const result = await resolved.delete(clonePlain(operation) ?? {});
      return persistenceSuccess(FOUNDRY_PERSISTENCE_CODES.OK, {
        documentRef: documentRef ?? documentRefOf(resolved),
        result,
        metadata
      });
    },

    async toggleStatusEffect({actor=null, actorRef=null, statusId, active=true, operation={}, metadata={}}={}) {
      const document = await resolveDocument({document: actor, ref: actorRef, kind: "actor", resolver: documentResolver});
      if ( !document ) return persistenceFailure(FOUNDRY_PERSISTENCE_CODES.DOCUMENT_NOT_FOUND, {
        reason: "Actor document could not be resolved for status toggle.",
        actorRef,
        statusId,
        metadata
      });
      if ( typeof document.toggleStatusEffect !== "function" ) return persistenceFailure(FOUNDRY_PERSISTENCE_CODES.UNSUPPORTED_OPERATION, {
        reason: "Resolved Actor document does not support toggleStatusEffect().",
        actorRef: actorRef ?? documentRef(document),
        statusId,
        metadata
      });

      const result = await document.toggleStatusEffect(String(statusId), {
        active: active === true,
        ...(clonePlain(operation) ?? {})
      });
      return persistenceSuccess(FOUNDRY_PERSISTENCE_CODES.OK, {
        actorRef: actorRef ?? documentRef(document),
        statusId,
        result,
        metadata
      });
    }
  };
}

export function createFoundryV14ActorPersistenceAdapter(options={}) {
  return createFoundryV14DocumentPersistenceAdapter(options);
}

export function createFoundryV14EffectPersistenceAdapter(options={}) {
  return createFoundryV14DocumentPersistenceAdapter(options);
}

/* -------------------------------------------- */

async function resolveDocument({document=null, ref=null, kind="document", resolver=null}={}) {
  if ( document ) return document;
  if ( !ref ) return null;
  if ( typeof resolver === "function" ) return await resolver({ref, kind});
  if ( resolver instanceof Map ) return resolver.get(ref) ?? null;
  if ( resolver && typeof resolver === "object" ) return resolver[ref] ?? null;
  if ( typeof globalThis.fromUuid === "function" && looksLikeUuid(ref) ) return await globalThis.fromUuid(ref);
  return null;
}

function persistenceSuccess(code, data={}) {
  return {
    ok: true,
    code,
    ...clonePersistenceData(data)
  };
}

function persistenceFailure(code, data={}) {
  return {
    ok: false,
    code,
    ...clonePersistenceData(data)
  };
}

function clonePersistenceData(data) {
  return {
    ...data,
    updates: clonePlain(data.updates ?? {}),
    documents: clonePlain(data.documents ?? undefined),
    metadata: clonePlain(data.metadata ?? {})
  };
}

function collectionContents(value) {
  if ( value == null ) return [];
  if ( Array.isArray(value) ) return value;
  if ( value instanceof Set ) return [...value];
  if ( value instanceof Map ) return [...value.values()];
  if ( typeof value.values === "function" ) return [...value.values()];
  return [value];
}

function documentRef(document) {
  return document?.uuid ?? (document?.id ? `actor:${document.id}` : null);
}

function documentRefOf(document) {
  return document?.uuid ?? document?.id ?? null;
}

function looksLikeUuid(value) {
  return typeof value === "string" && /^[A-Z][A-Za-z]+[.]/.test(value);
}

function clonePlain(value) {
  if ( value === undefined ) return undefined;
  if ( value == null ) return value;
  return JSON.parse(JSON.stringify(value));
}
