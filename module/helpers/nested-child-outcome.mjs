const ENTRY_LIMIT = 8;
const TEXT_LIMIT = 1024;
/** Capture before a terminal child is removed. Project diagnostics, never its payload/state. */
export function summarizeNestedChildOutcome(childState, childResult = null) {
    const child = record(childState);
    const result = record(childResult);
    const status = text(child.status) ?? text(result.status);
    if (status !== "failed" && status !== "cancelled" && result.ok !== false)
        return null;
    const action = record(record(child.results).actionResult);
    const trace = entries(child.trace);
    const terminal = [...trace].reverse().find(entry => entry.status === "failed" || entry.status === "cancelled") ?? {};
    const errors = entries(child.errors);
    const warnings = entries(child.warnings);
    const details = [...entries(action.steps), ...trace, ...errors].reverse().map(entry => record(entry.data));
    const tx = record(details.find(data => data.transaction)?.transaction);
    const targets = record(details.find(data => data.targetOperations)?.targetOperations);
    const commitFailure = failure(tx.commitFailure);
    const cause = errors.at(-1) ?? warnings.at(-1) ?? {};
    return {
        childResolutionId: text(child.id) ?? text(result.resolutionId),
        childStatus: status,
        code: text(action.code) ?? text(terminal.code) ?? text(cause.code) ?? text(result.code),
        reason: commitFailure?.reason ?? text(entries(targets.failures)[0]?.reason)
            ?? text(terminal.reason) ?? text(cause.reason) ?? text(result.reason),
        failedStageId: text(terminal.stageId) ?? text(child.currentStageId),
        errors: errors.slice(-ENTRY_LIMIT).map(diagnostic),
        traceTail: trace.slice(-ENTRY_LIMIT).map(entry => ({
            ...diagnostic(entry), id: text(entry.id), status: text(entry.status), result: text(entry.result)
        })),
        actionResult: Object.keys(action).length ? {
            status: text(action.status), code: text(action.code),
            errors: entries(action.errors).slice(-ENTRY_LIMIT).map(diagnostic)
        } : null,
        targetOperations: Object.keys(targets).length ? {
            code: text(targets.code),
            failures: entries(targets.failures).slice(-ENTRY_LIMIT).map(entry => ({
                ...diagnostic(entry),
                targetRefs: Array.isArray(entry.targetRefs) ? entry.targetRefs.slice(0, ENTRY_LIMIT).map(text) : [],
                mutationPlan: { type: text(record(entry.mutationPlan).type) }
            }))
        } : null,
        transaction: Object.keys(tx).length ? {
            code: text(tx.code), commitFailure,
            rolledBack: tx.rolledBack === true,
            committed: entries(tx.committed).slice(-ENTRY_LIMIT).map(operation),
            rollbacks: entries(tx.rollbacks).slice(-ENTRY_LIMIT).map(operation),
            failures: entries(tx.failures).slice(-ENTRY_LIMIT).map(failure)
        } : null
    };
}
function record(value) {
    return value !== null && typeof value === "object" ? value : {};
}
function entries(value) {
    return Array.isArray(value) ? value.map(record) : [];
}
function text(value) {
    return typeof value === "string" ? value.slice(0, TEXT_LIMIT) : null;
}
function diagnostic(value) {
    return { code: text(value.code), reason: text(value.reason),
        stage: text(value.stage), stageId: text(value.stageId) };
}
function operation(value) {
    return { id: text(value.id), type: text(value.type), actorRef: text(value.actorRef),
        status: text(value.status), metadata: { role: text(record(value.metadata).role) } };
}
function failure(value) {
    if (value == null)
        return null;
    const data = record(value);
    return { code: text(data.code), reason: text(data.reason), operation: operation(record(data.operation)) };
}
