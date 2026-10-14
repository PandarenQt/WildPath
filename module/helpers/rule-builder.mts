/**
 * The Homebrew Builder's rule rows (homebrew-content-builder.md, third slice): RuleElements as plain rows a
 * non-programmer can fill in ("+1 to AC", "resistance to fire", "allies within 10 ft gain +1 AC"), and the writer
 * that folds submitted rows back into the stored list. Like the Action Builder it is an overlay: a field the user
 * left unchanged writes nothing, so whatever a row does not show survives and an unchanged form gives back the
 * stored list. Rows match stored rules by position; an aura's nested rules are rows of their own.
 */
import {formatFormula, parseFormula} from "./formula.mjs";
import {DEFAULT_RULE_ELEMENT_REGISTRY, evaluateRuleElement, normalizeRuleElementType, validateRuleElementDefinition}
  from "./rule-elements.mjs";

type Data = Record<string, any>;
export interface RuleError {field: string; key: string; data: Record<string, string>}
export interface RuleOptions {abilities?: readonly string[] | null}

const TYPE_OF_KIND: Record<string, string> = {bonus: "Modifier", rollMode: "RollMode", resistance: "GrantResistance",
  immunity: "GrantImmunity", vulnerability: "GrantVulnerability", conditionImmunity: "ConditionImmunity", reveal: "Reveal",
  speed: "GrantMovement", resource: "GrantResource", extraDamage: "ExtraDamage", aura: "Aura"};
const KIND_OF_TYPE: Record<string, string> = Object.fromEntries(Object.entries(TYPE_OF_KIND).map(([kind, type]) => [type, kind]));

/** The kinds a row can be; an aura's own rules can be any but another aura. */
export const RULE_KINDS = Object.freeze(Object.keys(TYPE_OF_KIND));
export const DAMAGE_DOMAINS = Object.freeze(["damage", "damage.melee", "damage.ranged", "damage.weapon", "damage.spell"]);
export const MOVEMENT_MODES = Object.freeze(["walk", "fly", "swim", "climb", "burrow"]);

/** What a row of `kind` can apply to, as the engine's statistic domains. */
export function ruleDomains(kind: string, abilities: readonly string[] = []) {
  const d20 = ["attack", "attack.melee", "attack.ranged", "attack.weapon", "attack.spell", "save", ...abilities.map(ability => `save.${ability}`),
    "check", ...abilities.map(ability => `check.${ability}`), "initiative"];
  if ( kind === "rollMode" ) return [...d20, "attacked"];
  if ( kind === "extraDamage" ) return [...DAMAGE_DOMAINS];
  return [...d20, "defense.ac", "resources.health.max", "resources.movement.max", ...DAMAGE_DOMAINS];
}

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
    resourceId: data.resourceId ?? data.resource ?? "",
    resourceLabel: data.label ?? "",
    maximum: maximum ?? "",
    maximumReadOnly: maximum === null,
    recovery: data.recovery ?? "none",
    formula: formatFormula(data.expression ?? data.valueExpression) ?? "",
    damageType: typeof data.damageType === "string" ? data.damageType : "",
    oncePerTurn: data.once === "turn",
    radius: number(data.radius),
    affects: data.affects ?? "allies",
    rules: kind === "aura" ? (Array.isArray(data.ruleElements) ? data.ruleElements : []).map((nested: Data) => ruleToRow(nested, abilities)) : [],
    while: onlyCondition ? predicate.hasCondition : "",
    whileReadOnly: Boolean(predicate) && !onlyCondition
  };
}

/** The rows for a stored list of RuleElements. */
export function rulesToRows(ruleElements: unknown, {abilities=[]}: RuleOptions={}) {
  return (Array.isArray(ruleElements) ? ruleElements : []).map(rule => ruleToRow(rule, abilities ?? []));
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
    if ( row.while ) rule.predicate = {hasCondition: String(row.while)};
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
      break;
    case "resource":
      if ( changed("resourceId") ) { set("resource", undefined); set("resourceId", String(row.resourceId ?? "").trim() || "points"); }
      if ( changed("resourceLabel") ) set("label", String(row.resourceLabel ?? "").trim() || undefined);
      if ( changed("maximum") ) {
        const expression = formula("maximum", false);
        if ( expression ) { set("max", undefined); set("maximum", expression.type === "constant" ? expression.value : expression); }
      }
      if ( changed("recovery") ) set("recovery", row.recovery || "none");
      break;
    case "extraDamage":
      if ( changed("formula") ) {
        const expression = formula("formula", true);
        if ( expression ) { set("valueExpression", undefined); set("expression", expression); }
      }
      if ( changed("damageType") ) set("damageType", String(row.damageType ?? "").trim().toLowerCase() || "untyped");
      if ( changed("oncePerTurn") ) set("once", row.oncePerTurn ? "turn" : undefined);
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
  const rows = rowsOf(submitted);
  const written: Data[] = [];
  rows.forEach((row, index) => written.push(writeRule(stored[index], row, model[index], field, errors, options, index, [...stored, ...written])));
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
