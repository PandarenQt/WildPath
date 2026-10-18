/**
 * The Homebrew Builder's rule rows (homebrew-content-builder.md, third slice): RuleElements as plain rows a
 * non-programmer can fill in ("+1 to AC", "resistance to fire", "allies within 10 ft gain +1 AC"), and the writer
 * that folds submitted rows back into the stored list. Like the Action Builder it is an overlay: a field the user
 * left unchanged writes nothing, so whatever a row does not show survives and an unchanged form gives back the
 * stored list. Rows match stored rules by position; an aura's nested rules are rows of their own.
 */
import {formatFormula, parseFormula} from "./formula.mjs";
import {WILDPATH} from "../config.mjs";
import {DEFAULT_RULE_ELEMENT_REGISTRY, evaluateRuleElement, normalizeRuleElementType, validateRuleElementDefinition}
  from "./rule-elements.mjs";

type Data = Record<string, any>;
export interface RuleError {field: string; key: string; data: Record<string, string>}
export interface RuleOptions {abilities?: readonly string[] | null}

const TYPE_OF_KIND: Record<string, string> = {bonus: "Modifier", rollMode: "RollMode", resistance: "GrantResistance",
  immunity: "GrantImmunity", vulnerability: "GrantVulnerability", conditionImmunity: "ConditionImmunity", reveal: "Reveal",
  speed: "GrantMovement", resource: "GrantResource", extraDamage: "ExtraDamage", abilityScore: "AbilityScore", aura: "Aura"};
const KIND_OF_TYPE: Record<string, string> = Object.fromEntries(Object.entries(TYPE_OF_KIND).map(([kind, type]) => [type, kind]));

/** The kinds a row can be; an aura's own rules can be any but another aura. */
export const RULE_KINDS = Object.freeze(Object.keys(TYPE_OF_KIND));
export const DAMAGE_DOMAINS = Object.freeze(["damage", "damage.melee", "damage.ranged", "damage.weapon", "damage.spell"]);
export const MOVEMENT_MODES = Object.freeze(["walk", "fly", "swim", "climb", "burrow"]);

/** What a row of `kind` can apply to, as the engine's statistic domains. */
export function ruleDomains(kind: string, abilities: readonly string[] = []) {
  // Skills are CONFIG.WILDPATH's (the same object), so a skill a world adds is offered too.
  const skills = Object.keys((WILDPATH as {SKILLS?: Record<string, unknown>}).SKILLS ?? {});
  const d20 = ["attack", "attack.melee", "attack.ranged", "attack.weapon", "attack.spell", "save", ...abilities.map(ability => `save.${ability}`),
    "check", ...abilities.map(ability => `check.${ability}`), ...skills.map(skill => `check.${skill}`), "initiative"];
  if ( kind === "rollMode" ) return [...d20, "attacked"];
  // `attacked`: on attacks against its bearer (a mark's extra damage).
  if ( kind === "extraDamage" ) return [...DAMAGE_DOMAINS, "attacked"];
  return [...d20, "defense.ac", "resources.health.max", "resources.movement.max", ...DAMAGE_DOMAINS];
}

/** Conditions a row's "while" offers besides a condition on its creature, by key ("@magical": against magic). */
export const WHILE_PREDICATES: Readonly<Record<string, Data>> = Object.freeze({
  "@magical": {tagsAny: ["magical"]},
  "@melee": {tagsAny: ["melee"]},
  "@ranged": {tagsAny: ["ranged"]},
  "@allyNearTarget": {equals: {path: "attack.allyNearTarget", value: true}},
  "@inSunlight": {equals: {path: "inSunlight", value: true}}
});
const whileOf = (predicate: Data | null) => (predicate ? (Object.entries(WHILE_PREDICATES)
  .find(([, known]) => JSON.stringify(known) === JSON.stringify(predicate))?.[0] ?? null) : null);

/** Keys a RuleElement keeps at its root; every other key is rule data. */
const ROOT_KEYS = new Set(["schemaVersion", "id", "slug", "type", "key", "rule", "label", "name", "predicate", "priority", "order",
  "enabled", "suppressed", "source", "metadata", "data"]);

const clone = <T,>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
const rowsOf = (value: unknown): Data[] => {
  if ( Array.isArray(value) ) return value;
  if ( !value || (typeof value !== "object") ) return [];
  return Object.keys(value).filter(key => /^\d+$/.test(key)).sort((a, b) => Number(a) - Number(b)).map(key => (value as Data)[key]);
};
const loose = (value: unknown) => {
  if ( (value === undefined) || (value === null) || (value === "") ) return null;
  if ( (typeof value === "string") && value.trim() && Number.isFinite(Number(value)) ) return Number(value);
  return value;
};
function differs(submitted: unknown, model: unknown): boolean {
  if ( Array.isArray(model) ) {
    const rows = rowsOf(submitted);
    return (rows.length !== model.length) || rows.some((row, index) => differs(row, model[index]));
  }
  if ( submitted && (typeof submitted === "object") ) {
    return Object.entries(submitted).some(([key, value]) => differs(value, (model as Data | null)?.[key]));
  }
  return loose(submitted) !== loose(model);
}
const number = (value: unknown) => (loose(value) === null || !Number.isFinite(Number(value)) ? null : Number(value));
const listText = (value: unknown) => (Array.isArray(value) ? value : (value == null ? [] : [value])).join(", ");
const listOf = (text: unknown) => String(text ?? "").split(",").map(entry => entry.trim().toLowerCase()).filter(Boolean);

/** A number or formula as row text; null when only Advanced can show it. */
function amountText(value: unknown): string | null {
  if ( value == null ) return "";
  if ( typeof value === "number" ) return String(value);
  return formatFormula(value);
}

/** The row for one stored RuleElement. */
function ruleToRow(rule: Data, abilities: readonly string[]): Data {
  const validation = validateRuleElementDefinition(rule) as {ok: boolean; ruleElement?: Data};
  const normalized: Data = validation.ruleElement ?? {data: {}};
  const data: Data = normalized.data ?? {};
  const kind = KIND_OF_TYPE[normalized.type] ?? "other";
  const domains: string[] = [].concat(data.domains ?? data.domain ?? data.selector ?? []);
  const known = (domains.length === 1) && ruleDomains(kind, abilities).includes(domains[0]!);
  const predicate = rule.predicate ?? null;
  const onlyCondition = predicate && (Object.keys(predicate).length === 1) && (typeof predicate.hasCondition === "string");
  const named = whileOf(predicate);
  const amount = amountText(data.valueExpression ?? data.expression ?? data.value);
  const maximum = amountText(data.maximum ?? data.max);
  return {
    kind,
    type: normalized.type ?? String(rule.type ?? ""),
    appliesTo: known ? domains[0] : "",
    appliesToText: known ? "" : domains.join(", "),
    amount: amount ?? "",
    amountReadOnly: amount === null,
    modifierType: data.modifierType ?? "untyped",
    mode: data.mode ?? (kind === "speed" ? "walk" : "advantage"),
    damageTypes: listText(data.damageTypes ?? data.types ?? data.damageType),
    conditions: listText(data.conditions),
    distance: number(data.distance ?? data.value),
    hover: data.hover === true,
    resourceId: data.resourceId ?? data.resource ?? "",
    resourceLabel: data.label ?? "",
    maximum: maximum ?? "",
    maximumReadOnly: maximum === null,
    recovery: data.recovery ?? "none",
    current: number(data.current),
    emptiesAtTurnStart: data.emptiesAtTurnStart === true,
    recharge: number(data.recharge) ?? "",
    regainShort: amountText(data.regain?.shortRest) ?? "",
    regainLong: amountText(data.regain?.longRest) ?? "",
    regainReadOnly: (amountText(data.regain?.shortRest) === null) || (amountText(data.regain?.longRest) === null),
    formula: formatFormula(data.expression ?? data.valueExpression) ?? "",
    damageType: typeof data.damageType === "string" ? data.damageType : "",
    oncePerTurn: data.once === "turn",
    radius: number(data.radius),
    ability: typeof data.ability === "string" ? data.ability : "",
    scoreMode: data.mode ?? "add",
    scoreValue: number(data.value),
    scoreMaximum: number(data.maximum) ?? "",
    affects: data.affects ?? "allies",
    rules: kind === "aura" ? (Array.isArray(data.ruleElements) ? data.ruleElements : []).map((nested: Data) => ruleToRow(nested, abilities)) : [],
    while: onlyCondition ? predicate.hasCondition : (named ?? ""),
    whileReadOnly: Boolean(predicate) && !onlyCondition && !named
  };
}

/** The rows for a stored list of RuleElements. */
export function rulesToRows(ruleElements: unknown, {abilities=[]}: RuleOptions={}) {
  return (Array.isArray(ruleElements) ? ruleElements : []).map(rule => ruleToRow(rule, abilities ?? []));
}

/** The rule data each row kind shows (aliases included); `label` and `details` change nothing a row could. */
const ROW_DATA: Record<string, readonly string[]> = {
  bonus: ["domains", "domain", "selector", "value", "valueExpression", "expression", "modifierType", "type"],
  rollMode: ["domains", "domain", "selector", "mode"],
  resistance: ["damageTypes", "types", "damageType"],
  immunity: ["damageTypes", "types", "damageType"],
  vulnerability: ["damageTypes", "types", "damageType"],
  conditionImmunity: ["conditions"],
  reveal: ["details"],
  speed: ["mode", "movementMode", "distance", "value", "hover"],
  resource: ["resourceId", "resource", "label", "maximum", "max", "recovery", "current", "emptiesAtTurnStart", "recharge", "regain"],
  extraDamage: ["domains", "domain", "selector", "expression", "valueExpression", "damageType", "once"],
  abilityScore: ["ability", "mode", "value", "maximum"],
  aura: ["radius", "affects", "ruleElements"]
};

/**
 * What of a list of RuleElements the rule rows cannot show or edit, as `<Type>` (a type with no row) or
 * `<Type>.<part>` (its domains, amount, maximum, a condition other than "while", or a data key no row field writes).
 * Empty when the rows can rebuild every rule (the homebrew census, homebrew-content-builder.md).
 */
export function ruleGaps(ruleElements: unknown, {abilities=[]}: RuleOptions={}) {
  const gaps = new Set<string>();
  const visit = (rules: unknown) => {
    for ( const rule of (Array.isArray(rules) ? rules : []) as Data[] ) {
      const row = ruleToRow(rule, abilities ?? []);
      const name = String(row.type || rule?.type || "rule");
      if ( row.kind === "other" ) {
        gaps.add(name);
        continue;
      }
      if ( row.appliesToText ) gaps.add(`${name}.domains`);
      if ( row.amountReadOnly && ["bonus", "extraDamage"].includes(row.kind) ) gaps.add(`${name}.amount`);
      if ( row.kind === "resource" ) {
        if ( row.maximumReadOnly ) gaps.add(`${name}.maximum`);
        if ( row.regainReadOnly ) gaps.add(`${name}.regain`);
        if ( (rule.data?.current != null) && (row.current === null) ) gaps.add(`${name}.current`);
      }
      if ( row.whileReadOnly ) gaps.add(`${name}.predicate`);
      const data = {...Object.fromEntries(Object.entries(rule).filter(([key]) => !ROOT_KEYS.has(key))), ...(rule.data ?? {})};
      for ( const key of Object.keys(data) ) if ( !ROW_DATA[row.kind]!.includes(key) && (key !== "label") ) gaps.add(`${name}.${key}`);
      if ( row.kind === "aura" ) visit(rule.data?.ruleElements);
    }
  };
  visit(ruleElements);
  return [...gaps].sort();
}

/** A valid RuleElement of `kind`, with `id`. */
export function defaultRule(kind: string, id: string): Data {
  const rule = (data: Data) => ({schemaVersion: 1, id, type: TYPE_OF_KIND[kind], data});
  switch ( kind ) {
    case "rollMode": return rule({domains: ["attack"], mode: "advantage"});
    case "resistance": return rule({damageTypes: ["fire"]});
    case "immunity": return rule({damageTypes: ["poison"]});
    case "vulnerability": return rule({damageTypes: ["bludgeoning"]});
    case "conditionImmunity": return rule({conditions: ["charmed"]});
    case "reveal": return rule({details: ["defenses"]});
    case "speed": return rule({mode: "fly", distance: 30});
    case "resource": return rule({resourceId: "points", label: "Points", maximum: 1, recovery: "longRest"});
    case "extraDamage": return rule({domains: ["damage.melee"], expression: {type: "dice", number: 1, faces: 6}, damageType: "fire", once: "turn"});
    case "abilityScore": return rule({ability: "might", mode: "upgrade", value: 19});
    case "aura": return rule({radius: 10, affects: "allies", ruleElements: [defaultRule("bonus", `${id}-1`)]});
    default: return {schemaVersion: 1, id, type: "Modifier", data: {domains: ["defense.ac"], value: 1, modifierType: "untyped"}};
  }
}

/** A rule id not yet used in `rules`. */
function nextRuleId(rules: Data[], prefix="rule") {
  const used = new Set(rules.map(rule => rule?.id));
  let index = rules.length + 1;
  while ( used.has(`${prefix}-${index}`) ) index += 1;
  return `${prefix}-${index}`;
}

/** Fold one submitted row into its stored rule. */
function writeRule(stored: Data | undefined, row: Data, model: Data | undefined, field: string, errors: RuleError[], options: RuleOptions,
  index: number, siblings: Data[]): Data {
  const changed = (key: string) => (row[key] !== undefined) && (!model || differs(row[key], model[key]));
  if ( !stored || !model || changed("kind") ) {
    const fresh = defaultRule(String(row.kind || "bonus"), stored?.id ?? nextRuleId(siblings));
    if ( stored?.predicate ) fresh.predicate = clone(stored.predicate);
    return fresh;
  }
  if ( model.kind === "other" ) return stored;
  const rule: Data = clone(stored);
  rule.data = {...(rule.data ?? {})};
  // Rule data may also sit at the rule's root, where it wins; a written key lives in `data` only.
  const set = (key: string, value: unknown) => {
    if ( !ROOT_KEYS.has(key) ) delete rule[key];
    if ( value === undefined ) delete rule.data[key];
    else rule.data[key] = value;
  };
  const formula = (key: string, dice: boolean) => {
    const result = parseFormula(String(row[key] ?? ""), {dice, abilities: options.abilities ?? null});
    if ( !result.ok ) {
      errors.push({field: `${field}.${index}.${key}`, key: result.key, data: result.data});
      return undefined;
    }
    return result.expression;
  };

  if ( changed("while") && !model.whileReadOnly ) {
    if ( WHILE_PREDICATES[row.while] ) rule.predicate = clone(WHILE_PREDICATES[row.while]);
    else if ( row.while ) rule.predicate = {hasCondition: String(row.while)};
    else delete rule.predicate;
  }
  if ( changed("appliesTo") && row.appliesTo ) {
    set("domain", undefined);
    set("selector", undefined);
    set("domains", [String(row.appliesTo)]);
  }
  switch ( model.kind ) {
    case "bonus":
      if ( changed("amount") ) {
        const expression = formula("amount", false);
        if ( expression ) {
          set("expression", undefined);
          if ( expression.type === "constant" ) { set("value", expression.value); set("valueExpression", undefined); }
          else { set("valueExpression", expression); set("value", undefined); }
        }
      }
      if ( changed("modifierType") ) {
        delete rule.data.type;
        rule.data.modifierType = row.modifierType || "untyped";
      }
      break;
    case "rollMode":
      if ( changed("mode") ) set("mode", row.mode === "disadvantage" ? "disadvantage" : "advantage");
      break;
    case "conditionImmunity":
      if ( changed("conditions") ) set("conditions", listOf(row.conditions));
      break;
    case "resistance":
    case "immunity":
    case "vulnerability":
      if ( changed("damageTypes") ) {
        set("types", undefined);
        set("damageType", undefined);
        set("damageTypes", listOf(row.damageTypes));
      }
      break;
    case "speed":
      if ( changed("mode") ) { set("movementMode", undefined); set("mode", row.mode || "walk"); }
      if ( changed("distance") ) { set("value", undefined); set("distance", Math.max(0, number(row.distance) ?? 0)); }
      if ( changed("hover") ) set("hover", row.hover ? true : undefined);
      break;
    case "resource":
      if ( changed("resourceId") ) { set("resource", undefined); set("resourceId", String(row.resourceId ?? "").trim() || "points"); }
      if ( changed("resourceLabel") ) set("label", String(row.resourceLabel ?? "").trim() || undefined);
      if ( changed("maximum") ) {
        const expression = formula("maximum", false);
        if ( expression ) { set("max", undefined); set("maximum", expression.type === "constant" ? expression.value : expression); }
      }
      if ( changed("recovery") ) set("recovery", row.recovery || "none");
      // Starts at (Extra Attack's pool starts empty), emptied each turn (Multiattack's), Recharge 5-6, a partial regain.
      if ( changed("current") ) set("current", number(row.current) ?? undefined);
      if ( changed("emptiesAtTurnStart") ) set("emptiesAtTurnStart", row.emptiesAtTurnStart ? true : undefined);
      if ( changed("recharge") ) {
        const recharge = Math.trunc(number(row.recharge) ?? 0);
        set("recharge", (recharge >= 2) && (recharge <= 6) ? recharge : undefined);
      }
      for ( const [key, rest] of [["regainShort", "shortRest"], ["regainLong", "longRest"]] as const ) {
        if ( !changed(key) || model.regainReadOnly ) continue;
        const regain: Data = {...(rule.data.regain ?? {})};
        if ( !String(row[key] ?? "").trim() ) delete regain[rest];
        else {
          const expression = formula(key, true);
          if ( !expression ) continue;
          regain[rest] = expression.type === "constant" ? expression.value : expression;
        }
        set("regain", Object.keys(regain).length ? regain : undefined);
      }
      break;
    case "extraDamage":
      if ( changed("formula") ) {
        const expression = formula("formula", true);
        if ( expression ) { set("valueExpression", undefined); set("expression", expression); }
      }
      if ( changed("damageType") ) set("damageType", String(row.damageType ?? "").trim().toLowerCase() || "untyped");
      if ( changed("oncePerTurn") ) set("once", row.oncePerTurn ? "turn" : undefined);
      break;
    case "abilityScore":
      if ( changed("ability") && row.ability ) set("ability", String(row.ability));
      if ( changed("scoreMode") ) set("mode", ["add", "upgrade", "downgrade", "override"].includes(row.scoreMode) ? row.scoreMode : "add");
      if ( changed("scoreValue") ) set("value", Math.trunc(number(row.scoreValue) ?? 0));
      if ( changed("scoreMaximum") ) set("maximum", number(row.scoreMaximum) ?? undefined);
      break;
    case "aura":
      if ( changed("radius") ) set("radius", Math.max(5, number(row.radius) ?? 10));
      if ( changed("affects") ) set("affects", ["allies", "enemies", "all"].includes(row.affects) ? row.affects : "allies");
      if ( (row.rules !== undefined) && differs(row.rules, model.rules) ) {
        const nested = foldRows(row.rules, rule.data.ruleElements ?? [], model.rules, `${field}.${index}.rules`, errors, options);
        rule.data.ruleElements = nested;
      }
      break;
  }
  return rule;
}

function foldRows(submitted: unknown, stored: Data[], model: Data[], field: string, errors: RuleError[], options: RuleOptions) {
  // Rows by their posted index. A stored rule the form posted nothing for (one only Advanced can edit) is kept:
  // rules are removed with removeRule, never by a shorter form.
  const posted = (index: number): Data | undefined => (Array.isArray(submitted) ? submitted[index] : (submitted as Data | null)?.[index]);
  const count = Math.max(stored.length, ...Object.keys(submitted ?? {}).filter(key => /^\d+$/.test(key)).map(key => Number(key) + 1));
  const written: Data[] = [];
  for ( let index = 0; index < count; index++ ) {
    const row = posted(index);
    const kept = stored[index];
    if ( row ) written.push(writeRule(kept, row, model[index], field, errors, options, index, [...stored, ...written]));
    else if ( kept ) written.push(kept);
  }
  return written;
}

/**
 * Fold submitted rows (`{0: {...}, 1: {...}}`) into `stored`. `field` names the form prefix errors are reported
 * under. Returns the stored list itself when nothing changed, and leaves it untouched when any text is unreadable.
 */
export function rowsToRules(submitted: unknown, stored: unknown, {field="rules", ...options}: RuleOptions & {field?: string}={}) {
  const list: Data[] = Array.isArray(stored) ? stored : [];
  const model = rulesToRows(list, options);
  if ( (submitted === undefined) || !differs(submitted, model) ) return {changed: false, ruleElements: list, errors: [] as RuleError[]};
  const errors: RuleError[] = [];
  const ruleElements = foldRows(submitted, list, model, field, errors, options);
  return errors.length ? {changed: false, ruleElements: list, errors} : {changed: true, ruleElements, errors};
}

/** The list a path of aura indices points at: `[]` is the list itself, `[2]` the nested rules of its third rule. */
function nestedList(rules: Data[], path: readonly number[]): Data[] | null {
  let list = rules;
  for ( const index of path ) {
    const rule = list[index];
    if ( !rule ) return null;
    rule.data ??= {};
    rule.data.ruleElements ??= [];
    list = rule.data.ruleElements;
  }
  return list;
}

/** `rules` with a new default rule of `kind` in the list `path` points at. */
export function addRule(rules: unknown, kind: string, path: readonly number[] = []) {
  const next: Data[] = clone(Array.isArray(rules) ? rules : []);
  const list = nestedList(next, path);
  if ( list ) list.push(defaultRule(kind, nextRuleId(list, path.length ? "aura-rule" : "rule")));
  return next;
}

/** `rules` without rule `index` of the list `path` points at. */
export function removeRule(rules: unknown, index: number, path: readonly number[] = []) {
  const next: Data[] = clone(Array.isArray(rules) ? rules : []);
  nestedList(next, path)?.splice(index, 1);
  return next;
}

/** Handlers that read nothing but their own data, so they can be tried while editing. */
const CONTEXT_FREE = new Set(["Modifier", "RollMode", "GrantResistance", "GrantImmunity", "GrantVulnerability", "ConditionImmunity",
  "Reveal", "ExtraDamage", "Aura", "RollOutcome"]);

/**
 * What is wrong with a list of RuleElements, one message per rule: its shape, an unknown type, or what the rule's
 * own handler refuses (a Modifier without domains), tried without its predicate.
 */
export function ruleIssues(ruleElements: unknown): Array<{index: number; text: string}> {
  if ( !Array.isArray(ruleElements) ) return [{index: -1, text: "RuleElements must be a list."}];
  return ruleElements.flatMap((rule: Data, index) => {
    const validation = validateRuleElementDefinition(rule, {index}) as {ok: boolean; reason?: string; code?: string; ruleElement: Data};
    if ( !validation.ok ) return [{index, text: validation.reason ?? validation.code ?? "Invalid"}];
    const type = validation.ruleElement.type;
    if ( !DEFAULT_RULE_ELEMENT_REGISTRY.has(type) ) return [{index, text: `Unknown RuleElement type: ${rule.type}`}];
    if ( !CONTEXT_FREE.has(type) ) return [];
    const {predicate: _predicate, ...unconditional} = rule;
    const result = evaluateRuleElement({...unconditional, type: normalizeRuleElementType(rule.type)}, {}, {index}) as {ok: boolean;
      reason?: string; failure?: {reason?: string}};
    return result.ok ? [] : [{index, text: result.reason ?? result.failure?.reason ?? "Invalid"}];
  });
}
