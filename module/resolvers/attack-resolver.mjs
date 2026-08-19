export const ATTACK_RESOLVER_CODES = Object.freeze({
  OK: "OK",
  NO_TARGETS: "NO_TARGETS",
  NO_ATTACKABLE_TARGETS: "NO_ATTACKABLE_TARGETS",
  TARGET_SKIPPED: "TARGET_SKIPPED",
  MISSING_ATTACK_TOTAL: "MISSING_ATTACK_TOTAL",
  MISSING_DEFENSE: "MISSING_DEFENSE"
});

export const ATTACK_OUTCOMES = Object.freeze({
  CRITICAL_HIT: "criticalHit",
  HIT: "hit",
  MISS: "miss",
  CRITICAL_MISS: "criticalMiss"
});

export const ATTACK_DEFAULT_POLICY = Object.freeze({
  hitOnTie: true,
  naturalCriticalHits: true,
  naturalCriticalMisses: true,
  criticalHitThreshold: 20,
  criticalMissThreshold: 1
});

/* -------------------------------------------- */

export function createAttackRoll({
  total=null,
  die=null,
  formula=null,
  mode=null,
  statistic=null,
  modifiers=[],
  metadata={}
}={}) {
  return normalizeAttackRoll({total, die, formula, mode, statistic, modifiers, metadata});
}

/* -------------------------------------------- */

export function createAttackDefense({
  value=null,
  slug="ac",
  label=null,
  source=null,
  metadata={}
}={}) {
  return normalizeDefense({value, slug, label, source, metadata});
}

/* -------------------------------------------- */

export function resolveAttackAgainstDefense({
  roll,
  defense,
  target=null,
  policy={},
  context={}
}={}) {
  const normalizedRoll = normalizeAttackRoll(roll);
  const normalizedDefense = normalizeDefense(defense);
  const targetRef = target ? normalizeTargetRef(target) : null;

  if ( normalizedRoll.total == null ) {
    return attackFailure(ATTACK_RESOLVER_CODES.MISSING_ATTACK_TOTAL, {
      roll: normalizedRoll,
      defense: normalizedDefense,
      target: targetRef,
      context,
      reason: "attack total is required"
    });
  }
  if ( normalizedDefense.value == null ) {
    return attackFailure(ATTACK_RESOLVER_CODES.MISSING_DEFENSE, {
      roll: normalizedRoll,
      defense: normalizedDefense,
      target: targetRef,
      context,
      reason: "target defense is required"
    });
  }

  const activePolicy = normalizePolicy(policy);
  const margin = normalizedRoll.total - normalizedDefense.value;
  const criticalHit = isNaturalCriticalHit(normalizedRoll.die, activePolicy);
  const criticalMiss = isNaturalCriticalMiss(normalizedRoll.die, activePolicy);
  const outcome = attackOutcome({criticalHit, criticalMiss, margin, policy: activePolicy});

  return {
    ok: true,
    code: ATTACK_RESOLVER_CODES.OK,
    outcome,
    hit: outcome === ATTACK_OUTCOMES.CRITICAL_HIT || outcome === ATTACK_OUTCOMES.HIT,
    critical: outcome === ATTACK_OUTCOMES.CRITICAL_HIT || outcome === ATTACK_OUTCOMES.CRITICAL_MISS,
    margin,
    roll: normalizedRoll,
    defense: normalizedDefense,
    target: targetRef,
    context: clonePlain(context) ?? {}
  };
}

/* -------------------------------------------- */

export function resolveAttackTargets({
  roll,
  targetContexts=[],
  targets=[],
  defense=null,
  defenseKey="ac",
  policy={},
  context={}
}={}) {
  const contexts = normalizeTargetContexts({targetContexts, targets});
  if ( !contexts.length ) {
    return {
      ok: false,
      code: ATTACK_RESOLVER_CODES.NO_TARGETS,
      results: [],
      hits: [],
      misses: [],
      criticals: [],
      failures: [],
      skipped: []
    };
  }

  const results = contexts.map(targetContext => resolveAttackTarget({
    roll,
    targetContext,
    defense,
    defenseKey,
    policy,
    context
  }));
  const attempted = results.filter(result => result.code !== ATTACK_RESOLVER_CODES.TARGET_SKIPPED);
  const failures = attempted.filter(result => !result.ok);
  const hits = attempted.filter(result => result.ok && result.hit);
  const misses = attempted.filter(result => result.ok && !result.hit);
  const criticals = attempted.filter(result => result.ok && result.critical);
  const skipped = results.filter(result => result.code === ATTACK_RESOLVER_CODES.TARGET_SKIPPED);
  const code = failures[0]?.code ?? (attempted.length ? ATTACK_RESOLVER_CODES.OK : ATTACK_RESOLVER_CODES.NO_ATTACKABLE_TARGETS);

  return {
    ok: attempted.length > 0 && failures.length === 0,
    code,
    results,
    hits,
    misses,
    criticals,
    failures,
    skipped
  };
}

/* -------------------------------------------- */

function resolveAttackTarget({roll, targetContext, defense, defenseKey, policy, context}) {
  const normalizedContext = normalizeTargetContext(targetContext);
  if ( !normalizedContext.selected || normalizedContext.excluded || normalizedContext.resolutionState === "excluded" ) {
    return {
      ok: true,
      code: ATTACK_RESOLVER_CODES.TARGET_SKIPPED,
      outcome: null,
      hit: false,
      critical: false,
      margin: null,
      roll: normalizeAttackRoll(roll),
      defense: null,
      target: normalizeTargetRef(normalizedContext.target),
      targetContext: normalizedContext,
      context: clonePlain(context) ?? {},
      reason: "target is not selected for this resolution"
    };
  }

  const targetDefense = resolveTargetDefense(normalizedContext, defenseKey, defense);
  return {
    ...resolveAttackAgainstDefense({
      roll,
      defense: targetDefense,
      target: normalizedContext.target,
      policy,
      context
    }),
    targetContext: normalizedContext
  };
}

function attackOutcome({criticalHit, criticalMiss, margin, policy}) {
  if ( criticalHit ) return ATTACK_OUTCOMES.CRITICAL_HIT;
  if ( criticalMiss ) return ATTACK_OUTCOMES.CRITICAL_MISS;
  const hits = policy.hitOnTie ? margin >= 0 : margin > 0;
  return hits ? ATTACK_OUTCOMES.HIT : ATTACK_OUTCOMES.MISS;
}

function attackFailure(code, {roll, defense, target, context, reason}) {
  return {
    ok: false,
    code,
    outcome: null,
    hit: false,
    critical: false,
    margin: null,
    roll,
    defense,
    target,
    context: clonePlain(context) ?? {},
    reason
  };
}

function resolveTargetDefense(targetContext, defenseKey, fallback) {
  const key = defenseKey ?? "ac";
  const sources = [
    targetContext.defense,
    targetContext.defenses?.[key],
    targetContext.target?.defense,
    targetContext.target?.defenses?.[key],
    targetContext.target?.target?.defense,
    targetContext.target?.target?.defenses?.[key],
    targetContext.target?.actor?.defense,
    targetContext.target?.actor?.defenses?.[key],
    fallback
  ];
  return normalizeDefense(sources.find(source => source != null));
}

function normalizeAttackRoll(roll={}) {
  if ( typeof roll === "number" ) roll = {total: roll};
  return {
    total: finiteNumber(roll?.total),
    die: finiteNumber(roll?.die ?? roll?.natural ?? roll?.d20),
    formula: roll?.formula ?? null,
    mode: roll?.mode ?? null,
    statistic: roll?.statistic ? clonePlain(roll.statistic) : null,
    modifiers: (roll?.modifiers ?? []).map(clonePlain),
    metadata: clonePlain(roll?.metadata ?? {}) ?? {}
  };
}

function normalizeDefense(defense={}) {
  if ( typeof defense === "number" ) defense = {value: defense};
  return {
    value: finiteNumber(defense?.value ?? defense?.dc ?? defense?.total),
    slug: defense?.slug ?? defense?.key ?? "ac",
    label: defense?.label ?? null,
    source: defense?.source ? clonePlain(defense.source) : null,
    metadata: clonePlain(defense?.metadata ?? {}) ?? {}
  };
}

function normalizePolicy(policy={}) {
  return {
    ...ATTACK_DEFAULT_POLICY,
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
    defense: targetContext.defense ? clonePlain(targetContext.defense) : null,
    defenses: clonePlain(targetContext.defenses ?? null)
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

function isNaturalCriticalHit(die, policy) {
  if ( die == null || !policy.naturalCriticalHits ) return false;
  return die >= policy.criticalHitThreshold;
}

function isNaturalCriticalMiss(die, policy) {
  if ( die == null || !policy.naturalCriticalMisses ) return false;
  return die <= policy.criticalMissThreshold;
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
