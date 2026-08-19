export const RESOLUTION_TRANSACTION_CODES = Object.freeze({
  OK: "OK",
  NO_OPERATIONS: "NO_OPERATIONS",
  INVALID_OPERATION: "INVALID_OPERATION",
  ROLLBACK_UNAVAILABLE: "ROLLBACK_UNAVAILABLE",
  COMMIT_FAILED: "COMMIT_FAILED",
  ROLLBACK_FAILED: "ROLLBACK_FAILED"
});

/* -------------------------------------------- */

export function createActorUpdateTransactionOperation({
  id=null,
  type="actorUpdate",
  actor=null,
  actorRef=null,
  mutationPlan=null,
  updates=null,
  rollbackUpdates=null,
  metadata={},
  commit=null,
  rollback=null
}={}) {
  const plannedUpdates = clonePlain(updates ?? mutationPlan?.updates ?? {}) ?? {};
  const plannedRollbackUpdates = clonePlain(
    rollbackUpdates ?? rollbackUpdatesForMutationPlan(mutationPlan, plannedUpdates)
  ) ?? {};
  return {
    id: id ?? `${type}:${actorRef ?? "actor"}`,
    type,
    actorRef,
    actor,
    mutationPlan: mutationPlan ? clonePlain(mutationPlan) : null,
    updates: plannedUpdates,
    rollbackUpdates: plannedRollbackUpdates,
    rollbackAvailable: rollbackAvailableFor(plannedUpdates, plannedRollbackUpdates),
    metadata: clonePlain(metadata) ?? {},
    commit,
    rollback
  };
}

/* -------------------------------------------- */

export async function executeResolutionTransaction({
  operations=[],
  metadata={},
  commitOperation=commitActorUpdateOperation,
  rollbackOperation=rollbackActorUpdateOperation
}={}) {
  const prepared = prepareResolutionTransactionOperations(operations);
  if ( !prepared.ok ) {
    return transactionFailure(prepared.code, {
      failures: prepared.failures,
      committedOperations: [],
      rollbackResults: [],
      metadata
    });
  }
  if ( !prepared.operations.length ) {
    return {
      ok: true,
      code: RESOLUTION_TRANSACTION_CODES.NO_OPERATIONS,
      committed: [],
      rollbacks: [],
      failures: [],
      rolledBack: false,
      metadata: clonePlain(metadata) ?? {}
    };
  }

  const committedOperations = [];
  const committed = [];
  for ( const operation of prepared.operations ) {
    try {
      const ok = await (operation.commit ?? commitOperation)(operation);
      if ( !ok ) {
        const commitFailure = operationFailure(RESOLUTION_TRANSACTION_CODES.COMMIT_FAILED, {
          reason: "Transaction operation commit returned false.",
          operation
        });
        return commitFailedTransaction({commitFailure, committedOperations, committed, rollbackOperation, metadata});
      }
      committedOperations.push(operation);
      committed.push(operationSummary(operation, "committed"));
    } catch (error) {
      const commitFailure = operationFailure(RESOLUTION_TRANSACTION_CODES.COMMIT_FAILED, {
        reason: error?.message ?? String(error),
        operation
      });
      return commitFailedTransaction({commitFailure, committedOperations, committed, rollbackOperation, metadata});
    }
  }

  return {
    ok: true,
    code: RESOLUTION_TRANSACTION_CODES.OK,
    committed,
    rollbacks: [],
    failures: [],
    rolledBack: false,
    metadata: clonePlain(metadata) ?? {}
  };
}

/* -------------------------------------------- */

export function prepareResolutionTransactionOperations(operations=[]) {
  const failures = [];
  const prepared = [];
  for ( const operation of operations ) {
    const normalized = normalizeOperation(operation);
    if ( !normalized ) {
      failures.push(operationFailure(RESOLUTION_TRANSACTION_CODES.INVALID_OPERATION, {
        reason: "Transaction operation must be an object.",
        operation
      }));
      continue;
    }
    if ( Object.keys(normalized.updates).length && !normalized.actor ) {
      failures.push(operationFailure(RESOLUTION_TRANSACTION_CODES.INVALID_OPERATION, {
        reason: "Transaction operation with updates requires an Actor.",
        operation: normalized
      }));
      continue;
    }
    if ( !normalized.rollbackAvailable ) {
      failures.push(operationFailure(RESOLUTION_TRANSACTION_CODES.ROLLBACK_UNAVAILABLE, {
        reason: "Transaction operation with updates requires rollback data before commit.",
        operation: normalized
      }));
      continue;
    }
    prepared.push(normalized);
  }

  return {
    ok: failures.length === 0,
    code: failures[0]?.code ?? RESOLUTION_TRANSACTION_CODES.OK,
    operations: failures.length ? [] : prepared,
    failures
  };
}

/* -------------------------------------------- */

export async function commitActorUpdateOperation(operation) {
  if ( !Object.keys(operation.updates ?? {}).length ) return true;
  const result = await operation.actor.update(operation.updates);
  return result !== false;
}

export async function rollbackActorUpdateOperation(operation) {
  if ( !Object.keys(operation.rollbackUpdates ?? {}).length ) return true;
  const result = await operation.actor.update(operation.rollbackUpdates);
  return result !== false;
}

/* -------------------------------------------- */

async function commitFailedTransaction({
  commitFailure,
  committedOperations,
  committed,
  rollbackOperation,
  metadata
}) {
  const rollbackResults = [];
  const rollbackFailures = [];
  for ( const operation of [...committedOperations].reverse() ) {
    if ( !Object.keys(operation.updates ?? {}).length && typeof operation.rollback !== "function" ) continue;
    try {
      const ok = await (operation.rollback ?? rollbackOperation)(operation);
      const summary = operationSummary(operation, ok ? "rolledBack" : "rollbackFailed");
      rollbackResults.push(summary);
      if ( !ok ) {
        rollbackFailures.push(operationFailure(RESOLUTION_TRANSACTION_CODES.ROLLBACK_FAILED, {
          reason: "Transaction rollback returned false.",
          operation
        }));
      }
    } catch (error) {
      rollbackResults.push(operationSummary(operation, "rollbackFailed"));
      rollbackFailures.push(operationFailure(RESOLUTION_TRANSACTION_CODES.ROLLBACK_FAILED, {
        reason: error?.message ?? String(error),
        operation
      }));
    }
  }

  const code = rollbackFailures.length
    ? RESOLUTION_TRANSACTION_CODES.ROLLBACK_FAILED
    : RESOLUTION_TRANSACTION_CODES.COMMIT_FAILED;
  return transactionFailure(code, {
    commitFailure,
    failures: [commitFailure, ...rollbackFailures],
    committedOperations,
    committed,
    rollbackResults,
    metadata
  });
}

function transactionFailure(code, {
  commitFailure=null,
  failures=[],
  committedOperations=[],
  committed=null,
  rollbackResults=[],
  metadata={}
}={}) {
  return {
    ok: false,
    code,
    commitFailure,
    committed: committed ?? committedOperations.map(operation => operationSummary(operation, "committed")),
    rollbacks: rollbackResults,
    failures,
    rolledBack: rollbackResults.length > 0 && rollbackResults.every(result => result.status === "rolledBack"),
    metadata: clonePlain(metadata) ?? {}
  };
}

function normalizeOperation(operation) {
  if ( !operation || typeof operation !== "object" ) return null;
  const updates = clonePlain(operation.updates ?? operation.mutationPlan?.updates ?? {}) ?? {};
  const rollbackUpdates = clonePlain(
    operation.rollbackUpdates ?? rollbackUpdatesForMutationPlan(operation.mutationPlan, updates)
  ) ?? {};
  return {
    ...operation,
    id: operation.id ?? `${operation.type ?? "actorUpdate"}:${operation.actorRef ?? "actor"}`,
    type: operation.type ?? "actorUpdate",
    actorRef: operation.actorRef ?? null,
    updates,
    rollbackUpdates,
    rollbackAvailable: operation.rollbackAvailable ?? rollbackAvailableFor(updates, rollbackUpdates),
    metadata: clonePlain(operation.metadata ?? {}) ?? {}
  };
}

function rollbackUpdatesForMutationPlan(mutationPlan, updates={}) {
  const rollbackUpdates = {};
  for ( const payment of mutationPlan?.payments ?? [] ) {
    if ( payment?.path && Object.hasOwn(updates, payment.path) ) rollbackUpdates[payment.path] = payment.from;
  }
  if ( mutationPlan?.path && Object.hasOwn(updates, mutationPlan.path) ) {
    rollbackUpdates[mutationPlan.path] = mutationPlan.from;
  }
  return rollbackUpdates;
}

function rollbackAvailableFor(updates={}, rollbackUpdates={}) {
  const updatePaths = Object.keys(updates ?? {});
  if ( !updatePaths.length ) return true;
  return updatePaths.every(path => Object.hasOwn(rollbackUpdates ?? {}, path));
}

function operationFailure(code, {reason, operation}) {
  return {
    code,
    reason,
    operation: operationSummary(operation, "failed")
  };
}

function operationSummary(operation, status) {
  if ( !operation || typeof operation !== "object" ) return {status};
  return {
    id: operation.id ?? null,
    type: operation.type ?? null,
    actorRef: operation.actorRef ?? null,
    updates: clonePlain(operation.updates ?? {}) ?? {},
    rollbackUpdates: clonePlain(operation.rollbackUpdates ?? {}) ?? {},
    metadata: clonePlain(operation.metadata ?? {}) ?? {},
    status
  };
}

function clonePlain(value) {
  if ( value == null ) return value;
  return JSON.parse(JSON.stringify(value));
}
