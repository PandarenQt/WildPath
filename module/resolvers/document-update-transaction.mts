import type {DocumentPersistencePort} from "../types/contracts.js";
import {clonePlainData} from "../helpers/multiplayer-authority.mjs";

/** Generic document writes share the existing transaction's preparation, ordering and rollback. */
export function createDocumentUpdateTransactionOperation({id, document, documentRef, updates, rollbackUpdates, persistencePort}: {
  id: string; document: unknown; documentRef: string; updates: Record<string, unknown>;
  rollbackUpdates: Record<string, unknown>; persistencePort: DocumentPersistencePort;
}) {
  const write = async (values: Record<string, unknown>, rollback: boolean) => {
    const result = await persistencePort.updateDocument({document, documentRef, updates: values,
      metadata: {resolutionId: id, rollback}});
    if (result?.ok === false) throw new Error(result.reason ?? "Document position persistence failed.");
    return true;
  };
  const planned = clonePlainData(updates), before = clonePlainData(rollbackUpdates);
  return {id, type: "documentUpdate", document, documentRef, updates: planned, rollbackUpdates: before,
    metadata: {role: "movementPosition"},
    commit: () => write(planned, false), rollback: () => write(before, true)};
}
