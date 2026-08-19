export const DAMAGE_RESOLVER_CODES = Object.freeze({
  OK: "OK",
  NO_COMPONENTS: "NO_COMPONENTS",
  NO_TARGETS: "NO_TARGETS",
  NO_DAMAGEABLE_TARGETS: "NO_DAMAGEABLE_TARGETS",
  TARGET_SKIPPED: "TARGET_SKIPPED",
  INVALID_COMPONENT: "INVALID_COMPONENT",
  MISSING_AMOUNT: "MISSING_AMOUNT"
});

export const DAMAGE_COMPONENT_PROVENANCE = Object.freeze({
  WEAPON_BASE: "weapon-base",
  SPELL_BASE: "spell-base",
  FEATURE: "feature",
  EFFECT: "effect",
  ADDITIONAL: "additional",
  UNKNOWN: "unknown"
});

export const DAMAGE_SCALING_CATEGORIES = Object.freeze({
  NONE: "none",
  WEAPON_SIZE: "weapon-size"
});

/* -------------------------------------------- */

export function createDamageDice({
  number=0,
  faces=0,
  formula=null,
  metadata={}
}={}) {
  return normalizeDamageDice({number, faces, formula, metadata});
}

/* -------------------------------------------- */

export function createDamageComponent({
  id=null,
  amount=null,
  rolled=null,
  bonus=0,
  dice=null,
  damageType="untyped",
  provenance=DAMAGE_COMPONENT_PROVENANCE.UNKNOWN,
  scalingCategory=DAMAGE_SCALING_CATEGORIES.NONE,
  weaponSizeScalable=null,
  source=null,
  tags=[],
  metadata={}
}={}) {
  return normalizeDamageComponent({
    id,
    amount,
    rolled,
    bonus,
    dice,
    damageType,
    provenance,
    scalingCategory,
    weaponSizeScalable,
    source,
    tags,
    metadata
  });
}

/* -------------------------------------------- */

export function resolveDamageComponents({
  components=[],
  context={},
  minimumComponentAmount=0
}={}) {
  const normalized = components.map(component => normalizeDamageComponent(component));
  if ( !normalized.length ) {
    return {
      ok: false,
      code: DAMAGE_RESOLVER_CODES.NO_COMPONENTS,
      components: [],
      total: 0,
      byDamageType: {},
      scalableComponents: [],
      unscaledComponents: [],
      failures: [],
      context: clonePlain(context) ?? {}
    };
  }

  const resolved = [];
  const failures = [];
  for ( const component of normalized ) {
    const validation = validateDamageComponent(component);
    if ( !validation.ok ) {
      failures.push({
        ...component,
        ok: false,
        code: validation.code,
        reason: validation.reason
      });
      continue;
    }
    const amount = Math.max(component.amount, minimumComponentAmount);
    resolved.push({
      ...component,
      ok: true,
      code: DAMAGE_RESOLVER_CODES.OK,
      amount
    });
  }

  const byDamageType = groupByDamageType(resolved);
  return {
    ok: failures.length === 0,
    code: failures[0]?.code ?? DAMAGE_RESOLVER_CODES.OK,
    components: resolved,
    total: resolved.reduce((sum, component) => sum + component.amount, 0),
    byDamageType,
    scalableComponents: resolved.filter(isWeaponSizeScalable),
    unscaledComponents: resolved.filter(component => !isWeaponSizeScalable(component)),
    failures,
    context: clonePlain(context) ?? {}
  };
}

/* -------------------------------------------- */

export function resolveDamageTargets({
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
      code: DAMAGE_RESOLVER_CODES.NO_TARGETS,
      results: [],
      totals: {},
      failures: [],
      skipped: []
    };
  }

  const results = contexts.map(targetContext => resolveDamageTarget({
    components: typeof componentsForTarget === "function"
      ? componentsForTarget(targetContext, components)
      : components,
    targetContext,
    context
  }));
  const attempted = results.filter(result => result.code !== DAMAGE_RESOLVER_CODES.TARGET_SKIPPED);
  const failures = attempted.filter(result => !result.ok);
  const skipped = results.filter(result => result.code === DAMAGE_RESOLVER_CODES.TARGET_SKIPPED);
  const code = failures[0]?.code ?? (attempted.length ? DAMAGE_RESOLVER_CODES.OK : DAMAGE_RESOLVER_CODES.NO_DAMAGEABLE_TARGETS);

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

export function isWeaponSizeScalable(component) {
  return component?.weaponSizeScalable === true
    || component?.scalingCategory === DAMAGE_SCALING_CATEGORIES.WEAPON_SIZE
    || (component?.scalingCategories ?? []).includes(DAMAGE_SCALING_CATEGORIES.WEAPON_SIZE);
}

/* -------------------------------------------- */

function resolveDamageTarget({components, targetContext, context}) {
  const normalizedContext = normalizeTargetContext(targetContext);
  if ( !normalizedContext.selected || normalizedContext.excluded || normalizedContext.resolutionState === "excluded" ) {
    return {
      ok: true,
      code: DAMAGE_RESOLVER_CODES.TARGET_SKIPPED,
      target: normalizeTargetRef(normalizedContext.target),
      targetContext: normalizedContext,
      components: [],
      total: 0,
      byDamageType: {},
      reason: "target is not selected for this resolution"
    };
  }

  const damage = resolveDamageComponents({
    components,
    context: {
      ...context,
      target: normalizeTargetRef(normalizedContext.target)
    }
  });
  return {
    ...damage,
    target: normalizeTargetRef(normalizedContext.target),
    targetContext: normalizedContext
  };
}

function validateDamageComponent(component) {
  if ( component.amount == null ) {
    return {
      ok: false,
      code: DAMAGE_RESOLVER_CODES.MISSING_AMOUNT,
      reason: "damage component amount is required"
    };
  }
  if ( component.amount < 0 ) {
    return {
      ok: false,
      code: DAMAGE_RESOLVER_CODES.INVALID_COMPONENT,
      reason: "damage component amount cannot be negative"
    };
  }
  return {ok: true, code: DAMAGE_RESOLVER_CODES.OK};
}

function normalizeDamageComponent(component={}) {
  const rolled = finiteNumber(component.rolled ?? component.roll);
  const bonus = finiteNumber(component.bonus ?? component.flat) ?? 0;
  const amount = finiteNumber(component.amount ?? component.total ?? component.value) ?? (rolled == null ? null : rolled + bonus);
  const scalingCategory = component.scalingCategory
    ?? (component.weaponSizeScalable ? DAMAGE_SCALING_CATEGORIES.WEAPON_SIZE : DAMAGE_SCALING_CATEGORIES.NONE);
  return {
    id: component.id == null ? null : String(component.id),
    amount,
    rolled,
    bonus,
    dice: component.dice ? normalizeDamageDice(component.dice) : null,
    damageType: String(component.damageType ?? component.type ?? "untyped"),
    provenance: component.provenance ?? DAMAGE_COMPONENT_PROVENANCE.UNKNOWN,
    scalingCategory,
    scalingCategories: uniqueStrings([
      ...(component.scalingCategories ?? []),
      scalingCategory
    ]).filter(category => category !== DAMAGE_SCALING_CATEGORIES.NONE),
    weaponSizeScalable: component.weaponSizeScalable ?? scalingCategory === DAMAGE_SCALING_CATEGORIES.WEAPON_SIZE,
    source: component.source ? clonePlain(component.source) : null,
    tags: uniqueStrings(component.tags ?? []),
    metadata: clonePlain(component.metadata ?? {}) ?? {}
  };
}

function normalizeDamageDice(dice={}) {
  return {
    number: Math.max(Math.floor(finiteNumber(dice.number ?? dice.count) ?? 0), 0),
    faces: Math.max(Math.floor(finiteNumber(dice.faces ?? dice.sides) ?? 0), 0),
    formula: dice.formula ?? null,
    metadata: clonePlain(dice.metadata ?? {}) ?? {}
  };
}

function groupByDamageType(components) {
  const groups = {};
  for ( const component of components ) {
    groups[component.damageType] = (groups[component.damageType] ?? 0) + component.amount;
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
