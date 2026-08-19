export const HEALING_RESOLVER_CODES = Object.freeze({
  OK: "OK",
  NO_COMPONENTS: "NO_COMPONENTS",
  NO_TARGETS: "NO_TARGETS",
  NO_HEALABLE_TARGETS: "NO_HEALABLE_TARGETS",
  TARGET_SKIPPED: "TARGET_SKIPPED",
  INVALID_COMPONENT: "INVALID_COMPONENT",
  MISSING_AMOUNT: "MISSING_AMOUNT"
});

/* -------------------------------------------- */

export function resolveHealingComponents({
  components=[],
  context={},
  minimumComponentAmount=0
}={}) {
  const normalized = components.map(component => normalizeHealingComponent(component));
  if ( !normalized.length ) {
    return {
      ok: false,
      code: HEALING_RESOLVER_CODES.NO_COMPONENTS,
      components: [],
      total: 0,
      byHealingType: {},
      failures: [],
      context: clonePlain(context) ?? {}
    };
  }

  const resolved = [];
  const failures = [];
  for ( const component of normalized ) {
    const validation = validateHealingComponent(component);
    if ( !validation.ok ) {
      failures.push({
        ...component,
        ok: false,
        code: validation.code,
        reason: validation.reason
      });
      continue;
    }
    resolved.push({
      ...component,
      ok: true,
      code: HEALING_RESOLVER_CODES.OK,
      amount: Math.max(component.amount, minimumComponentAmount)
    });
  }

  return {
    ok: failures.length === 0,
    code: failures[0]?.code ?? HEALING_RESOLVER_CODES.OK,
    components: resolved,
    total: resolved.reduce((sum, component) => sum + component.amount, 0),
    byHealingType: groupByHealingType(resolved),
    failures,
    context: clonePlain(context) ?? {}
  };
}

/* -------------------------------------------- */

export function resolveHealingTargets({
  components=[],
  targetContexts=[],
  targets=[],
  context={},
  componentsForTarget=null
}={}) {
  const contexts = normalizeTargetContexts({targetContexts, targets});
  if ( !contexts.length ) {
    return {
      ok: false,
      code: HEALING_RESOLVER_CODES.NO_TARGETS,
      results: [],
      totals: {},
      failures: [],
      skipped: []
    };
  }

  const results = contexts.map(targetContext => resolveHealingTarget({
    components: typeof componentsForTarget === "function"
      ? componentsForTarget(targetContext, components)
      : components,
    targetContext,
    context
  }));
  const attempted = results.filter(result => result.code !== HEALING_RESOLVER_CODES.TARGET_SKIPPED);
  const failures = attempted.filter(result => !result.ok);
  const skipped = results.filter(result => result.code === HEALING_RESOLVER_CODES.TARGET_SKIPPED);
  const code = failures[0]?.code ?? (attempted.length ? HEALING_RESOLVER_CODES.OK : HEALING_RESOLVER_CODES.NO_HEALABLE_TARGETS);

  return {
    ok: attempted.length > 0 && failures.length === 0,
    code,
    results,
    totals: Object.fromEntries(attempted.filter(result => result.ok).map(result => [result.target.id, result.total])),
    failures,
    skipped
  };
}

/* -------------------------------------------- */

function resolveHealingTarget({components, targetContext, context}) {
  const normalizedContext = normalizeTargetContext(targetContext);
  if ( !normalizedContext.selected || normalizedContext.excluded || normalizedContext.resolutionState === "excluded" ) {
    return {
      ok: true,
      code: HEALING_RESOLVER_CODES.TARGET_SKIPPED,
      target: normalizeTargetRef(normalizedContext.target),
      targetContext: normalizedContext,
      components: [],
      total: 0,
      byHealingType: {},
      reason: "target is not selected for this resolution"
    };
  }

  const healing = resolveHealingComponents({
    components,
    context: {
      ...context,
      target: normalizeTargetRef(normalizedContext.target)
    }
  });
  return {
    ...healing,
    target: normalizeTargetRef(normalizedContext.target),
    targetContext: normalizedContext
  };
}

function validateHealingComponent(component) {
  if ( component.amount == null ) {
    return {
      ok: false,
      code: HEALING_RESOLVER_CODES.MISSING_AMOUNT,
      reason: "healing component amount is required"
    };
  }
  if ( component.amount < 0 ) {
    return {
      ok: false,
      code: HEALING_RESOLVER_CODES.INVALID_COMPONENT,
      reason: "healing component amount cannot be negative"
    };
  }
  return {ok: true, code: HEALING_RESOLVER_CODES.OK};
}

function normalizeHealingComponent(component={}) {
  const rolled = finiteNumber(component.rolled ?? component.roll);
  const bonus = finiteNumber(component.bonus ?? component.flat) ?? 0;
  const amount = finiteNumber(component.amount ?? component.total ?? component.value) ?? (rolled == null ? null : rolled + bonus);
  return {
    id: component.id == null ? null : String(component.id),
    amount,
    rolled,
    bonus,
    dice: component.dice ? clonePlain(component.dice) : null,
    healingType: String(component.healingType ?? component.type ?? "healing"),
    source: component.source ? clonePlain(component.source) : null,
    tags: uniqueStrings(component.tags ?? []),
    metadata: clonePlain(component.metadata ?? {}) ?? {}
  };
}

function groupByHealingType(components) {
  const groups = {};
  for ( const component of components ) {
    groups[component.healingType] = (groups[component.healingType] ?? 0) + component.amount;
  }
  return groups;
}

function normalizeTargetContexts({targetContexts, targets}) {
  if ( targetContexts.length ) return targetContexts.map(normalizeTargetContext);
  return targets.map(target => normalizeTargetContext({target, selected: true}));
}

function normalizeTargetContext(targetContext={}) {
  return {
    target: clonePlain(targetContext.target ?? targetContext) ?? {},
    selected: targetContext.selected ?? true,
    excluded: !!targetContext.excluded,
    resolutionState: targetContext.resolutionState ?? "normal",
    overrides: (targetContext.overrides ?? []).map(clonePlain),
    results: (targetContext.results ?? []).map(clonePlain)
  };
}

function normalizeTargetRef(target={}) {
  return {
    id: target.target?.id ?? target.id ?? target.uuid ?? null,
    uuid: target.target?.uuid ?? target.uuid ?? null,
    actorId: target.target?.actorId ?? target.actorId ?? target.actor?.id ?? null,
    tokenId: target.target?.tokenId ?? target.tokenId ?? target.token?.id ?? null,
    name: target.target?.name ?? target.name ?? target.actor?.name ?? target.token?.name ?? null,
    type: target.target?.type ?? target.type ?? target.kind ?? null
  };
}

function uniqueStrings(values) {
  return [...new Set(values.filter(value => value != null).map(String))];
}

function finiteNumber(value) {
  if ( value == null || value === "" ) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clonePlain(value) {
  if ( value == null ) return value;
  return JSON.parse(JSON.stringify(value));
}
