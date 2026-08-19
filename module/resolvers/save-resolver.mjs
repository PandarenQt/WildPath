export const SAVE_RESOLVER_CODES = Object.freeze({
  OK: "OK",
  NO_TARGETS: "NO_TARGETS",
  NO_SAVEABLE_TARGETS: "NO_SAVEABLE_TARGETS",
  TARGET_SKIPPED: "TARGET_SKIPPED",
  MISSING_SAVE_TOTAL: "MISSING_SAVE_TOTAL",
  MISSING_DC: "MISSING_DC"
});

export const SAVE_OUTCOMES = Object.freeze({
  CRITICAL_SUCCESS: "criticalSuccess",
  SUCCESS: "success",
  FAILURE: "failure",
  CRITICAL_FAILURE: "criticalFailure"
});

export const SAVE_DEFAULT_POLICY = Object.freeze({
  successOnTie: true,
  naturalCriticalSuccesses: false,
  naturalCriticalFailures: false,
  criticalSuccessThreshold: 20,
  criticalFailureThreshold: 1
});

/* -------------------------------------------- */

export function createSaveRoll({
  total=null,
  die=null,
  ability=null,
  formula=null,
  mode=null,
  statistic=null,
  modifiers=[],
  metadata={}
}={}) {
  return normalizeSaveRoll({total, die, ability, formula, mode, statistic, modifiers, metadata});
}

/* -------------------------------------------- */

export function createSaveDC({
  value=null,
  slug="save",
  ability=null,
  label=null,
  source=null,
  metadata={}
}={}) {
  return normalizeSaveDC({value, slug, ability, label, source, metadata});
}

/* -------------------------------------------- */

export function resolveSaveAgainstDC({
  roll,
  dc,
  target=null,
  policy={},
  context={}
}={}) {
  const normalizedRoll = normalizeSaveRoll(roll);
  const normalizedDC = normalizeSaveDC(dc);
  const targetRef = target ? normalizeTargetRef(target) : null;

  if ( normalizedRoll.total == null ) {
    return saveFailure(SAVE_RESOLVER_CODES.MISSING_SAVE_TOTAL, {
      roll: normalizedRoll,
      dc: normalizedDC,
      target: targetRef,
      context,
      reason: "save total is required"
    });
  }
  if ( normalizedDC.value == null ) {
    return saveFailure(SAVE_RESOLVER_CODES.MISSING_DC, {
      roll: normalizedRoll,
      dc: normalizedDC,
      target: targetRef,
      context,
      reason: "save DC is required"
    });
  }

  const activePolicy = normalizePolicy(policy);
  const margin = normalizedRoll.total - normalizedDC.value;
  const criticalSuccess = isNaturalCriticalSuccess(normalizedRoll.die, activePolicy);
  const criticalFailure = isNaturalCriticalFailure(normalizedRoll.die, activePolicy);
  const outcome = saveOutcome({criticalSuccess, criticalFailure, margin, policy: activePolicy});

  return {
    ok: true,
    code: SAVE_RESOLVER_CODES.OK,
    outcome,
    success: outcome === SAVE_OUTCOMES.CRITICAL_SUCCESS || outcome === SAVE_OUTCOMES.SUCCESS,
    critical: outcome === SAVE_OUTCOMES.CRITICAL_SUCCESS || outcome === SAVE_OUTCOMES.CRITICAL_FAILURE,
    margin,
    roll: normalizedRoll,
    dc: normalizedDC,
    target: targetRef,
    context: clonePlain(context) ?? {}
  };
}

/* -------------------------------------------- */

export function resolveSaveTargets({
  roll=null,
  targetContexts=[],
  targets=[],
  dc=null,
  dcKey="save",
  saveKey=null,
  policy={},
  context={}
}={}) {
  const contexts = normalizeTargetContexts({targetContexts, targets});
  if ( !contexts.length ) {
    return {
      ok: false,
      code: SAVE_RESOLVER_CODES.NO_TARGETS,
      results: [],
      successes: [],
      failures: [],
      criticals: [],
      invalid: [],
      skipped: []
    };
  }

  const results = contexts.map(targetContext => resolveSaveTarget({
    roll,
    targetContext,
    dc,
    dcKey,
    saveKey,
    policy,
    context
  }));
  const attempted = results.filter(result => result.code !== SAVE_RESOLVER_CODES.TARGET_SKIPPED);
  const invalid = attempted.filter(result => !result.ok);
  const successes = attempted.filter(result => result.ok && result.success);
  const failures = attempted.filter(result => result.ok && !result.success);
  const criticals = attempted.filter(result => result.ok && result.critical);
  const skipped = results.filter(result => result.code === SAVE_RESOLVER_CODES.TARGET_SKIPPED);
  const code = invalid[0]?.code ?? (attempted.length ? SAVE_RESOLVER_CODES.OK : SAVE_RESOLVER_CODES.NO_SAVEABLE_TARGETS);

  return {
    ok: attempted.length > 0 && invalid.length === 0,
    code,
    results,
    successes,
    failures,
    criticals,
    invalid,
    skipped
  };
}

/* -------------------------------------------- */

function resolveSaveTarget({roll, targetContext, dc, dcKey, saveKey, policy, context}) {
  const normalizedContext = normalizeTargetContext(targetContext);
  if ( !normalizedContext.selected || normalizedContext.excluded || normalizedContext.resolutionState === "excluded" ) {
    return {
      ok: true,
      code: SAVE_RESOLVER_CODES.TARGET_SKIPPED,
      outcome: null,
      success: false,
      critical: false,
      margin: null,
      roll: normalizeSaveRoll(roll),
      dc: null,
      target: normalizeTargetRef(normalizedContext.target),
      targetContext: normalizedContext,
      context: clonePlain(context) ?? {},
      reason: "target is not selected for this resolution"
    };
  }

  const targetRoll = resolveTargetSaveRoll(normalizedContext, saveKey, roll);
  const targetDC = resolveTargetSaveDC(normalizedContext, dcKey, dc);
  return {
    ...resolveSaveAgainstDC({
      roll: targetRoll,
      dc: targetDC,
      target: normalizedContext.target,
      policy,
      context
    }),
    targetContext: normalizedContext
  };
}

function saveOutcome({criticalSuccess, criticalFailure, margin, policy}) {
  if ( criticalSuccess ) return SAVE_OUTCOMES.CRITICAL_SUCCESS;
  if ( criticalFailure ) return SAVE_OUTCOMES.CRITICAL_FAILURE;
  const succeeds = policy.successOnTie ? margin >= 0 : margin > 0;
  return succeeds ? SAVE_OUTCOMES.SUCCESS : SAVE_OUTCOMES.FAILURE;
}

function saveFailure(code, {roll, dc, target, context, reason}) {
  return {
    ok: false,
    code,
    outcome: null,
    success: false,
    critical: false,
    margin: null,
    roll,
    dc,
    target,
    context: clonePlain(context) ?? {},
    reason
  };
}

function resolveTargetSaveRoll(targetContext, saveKey, fallback) {
  const key = saveKey ?? targetContext.saveKey ?? targetContext.ability ?? targetContext.target?.saveKey ?? targetContext.target?.ability ?? null;
  const sources = [
    targetContext.roll,
    targetContext.save,
    key ? targetContext.saves?.[key] : null,
    targetContext.target?.roll,
    targetContext.target?.save,
    key ? targetContext.target?.saves?.[key] : null,
    targetContext.target?.target?.save,
    key ? targetContext.target?.target?.saves?.[key] : null,
    targetContext.target?.actor?.save,
    key ? targetContext.target?.actor?.saves?.[key] : null,
    fallback
  ];
  return normalizeSaveRoll(sources.find(source => source != null));
}

function resolveTargetSaveDC(targetContext, dcKey, fallback) {
  const key = dcKey ?? "save";
  const sources = [
    targetContext.dc,
    targetContext.dcs?.[key],
    targetContext.target?.dc,
    targetContext.target?.dcs?.[key],
    targetContext.target?.target?.dc,
    targetContext.target?.target?.dcs?.[key],
    targetContext.target?.actor?.dc,
    targetContext.target?.actor?.dcs?.[key],
    fallback
  ];
  return normalizeSaveDC(sources.find(source => source != null));
}

function normalizeSaveRoll(roll={}) {
  if ( typeof roll === "number" ) roll = {total: roll};
  return {
    total: finiteNumber(roll?.total),
    die: finiteNumber(roll?.die ?? roll?.natural ?? roll?.d20),
    ability: roll?.ability ?? roll?.slug ?? roll?.key ?? null,
    formula: roll?.formula ?? null,
    mode: roll?.mode ?? null,
    statistic: roll?.statistic ? clonePlain(roll.statistic) : null,
    modifiers: (roll?.modifiers ?? []).map(clonePlain),
    metadata: clonePlain(roll?.metadata ?? {}) ?? {}
  };
}

function normalizeSaveDC(dc={}) {
  if ( typeof dc === "number" ) dc = {value: dc};
  return {
    value: finiteNumber(dc?.value ?? dc?.dc ?? dc?.total),
    slug: dc?.slug ?? dc?.key ?? "save",
    ability: dc?.ability ?? null,
    label: dc?.label ?? null,
    source: dc?.source ? clonePlain(dc.source) : null,
    metadata: clonePlain(dc?.metadata ?? {}) ?? {}
  };
}

function normalizePolicy(policy={}) {
  return {
    ...SAVE_DEFAULT_POLICY,
    ...clonePlain(policy)
  };
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
    results: (targetContext.results ?? []).map(clonePlain),
    roll: targetContext.roll != null ? clonePlain(targetContext.roll) : null,
    save: targetContext.save != null ? clonePlain(targetContext.save) : null,
    saves: clonePlain(targetContext.saves ?? null),
    dc: targetContext.dc != null ? clonePlain(targetContext.dc) : null,
    dcs: clonePlain(targetContext.dcs ?? null),
    ability: targetContext.ability ?? null,
    saveKey: targetContext.saveKey ?? null
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

function isNaturalCriticalSuccess(die, policy) {
  if ( die == null || !policy.naturalCriticalSuccesses ) return false;
  return die >= policy.criticalSuccessThreshold;
}

function isNaturalCriticalFailure(die, policy) {
  if ( die == null || !policy.naturalCriticalFailures ) return false;
  return die <= policy.criticalFailureThreshold;
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
