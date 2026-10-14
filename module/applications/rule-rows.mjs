import {MOVEMENT_MODES, RULE_KINDS, ruleDomains, rulesToRows} from "../helpers/rule-builder.mjs";

/** The rule-rows partial, shared by the item sheet, an Action's custom effects and the effect sheet. */
export const RULE_ROWS_TEMPLATE = "systems/wildpath/templates/item/rule-rows.hbs";

const DOMAIN_KEYS = {
  attack: "attack", "attack.melee": "attackMelee", "attack.ranged": "attackRanged", "attack.weapon": "attackWeapon",
  "attack.spell": "attackSpell", save: "save", check: "check", initiative: "initiative", "defense.ac": "ac",
  "resources.health.max": "hp", "resources.movement.max": "speed", damage: "damage", "damage.melee": "damageMelee",
  "damage.ranged": "damageRanged", "damage.weapon": "damageWeapon", "damage.spell": "damageSpell", attacked: "attacked"
};

/** A statistic domain in plain words: "Melee attack rolls", "Agility saves". */
function domainLabel(domain) {
  const key = DOMAIN_KEYS[domain];
  if ( key ) return game.i18n.localize(`WILDPATH.RULES.Domain.${key}`);
  const [kind, ability] = domain.split(".");
  const name = game.i18n.localize(CONFIG.WILDPATH.ABILITIES[ability]?.label ?? ability);
  return game.i18n.format(kind === "save" ? "WILDPATH.RULES.Domain.saveOf" : "WILDPATH.RULES.Domain.checkOf", {ability: name});
}

/** Fold a draft's submitted rows (by index, nested under `rules`) over the rows shown. */
function overlay(rows, submitted) {
  for ( const [index, row] of Object.entries(submitted ?? {}) ) {
    const target = rows[Number(index)];
    if ( !target || !row ) continue;
    const {rules, ...fields} = row;
    Object.assign(target, fields);
    if ( rules ) overlay(target.rules, rules);
  }
}

const options = (values, prefix) => Object.fromEntries(values.map(value => [value, `${prefix}${value || "Always"}`]));

/**
 * What the rule-rows partial needs for a list of RuleElements: rows named `<prefix>.<index>.<field>`, with errors
 * found under `<field>.<index>.<field>`, and the shared choices. `list` tells the add and remove buttons which list
 * they edit; `draft` holds rows typed but not saved.
 */
export function ruleRowsContext(ruleElements, {prefix, field=prefix, list, errors=[], draft=null, editable=true}) {
  const abilities = Object.keys(CONFIG.WILDPATH.ABILITIES);
  const rows = rulesToRows(ruleElements, {abilities});
  if ( draft ) overlay(rows, draft);
  const errorText = Object.fromEntries(errors.map(error => [error.field,
    game.i18n.format(`WILDPATH.BUILDER.Formula.${error.key}`, error.data)]));
  const domains = Object.fromEntries(RULE_KINDS.map(kind => [kind, Object.fromEntries(ruleDomains(kind, abilities)
    .map(domain => [domain, domainLabel(domain)]))]));
  const view = (list, namePrefix, fieldPrefix, path) => list.map((row, index) => {
    const name = `${namePrefix}.${index}`;
    const key = `${fieldPrefix}.${index}`;
    const at = [...path, index];
    return {
      ...row, name, path: at.join("."),
      isOther: row.kind === "other", isBonus: row.kind === "bonus", isRollMode: row.kind === "rollMode",
      isDamageTypes: ["resistance", "immunity"].includes(row.kind), isSpeed: row.kind === "speed", isResource: row.kind === "resource",
      isExtraDamage: row.kind === "extraDamage", isAura: row.kind === "aura",
      hasAppliesTo: ["bonus", "rollMode", "extraDamage"].includes(row.kind),
      appliesToChoices: domains[row.kind] ?? {},
      errors: {amount: errorText[`${key}.amount`], maximum: errorText[`${key}.maximum`], formula: errorText[`${key}.formula`]},
      rules: row.kind === "aura" ? view(row.rules, `${name}.rules`, `${key}.rules`, at) : []
    };
  });
  const kinds = options(RULE_KINDS, "WILDPATH.RULES.Kind.");
  const {aura: _aura, ...nestedKinds} = kinds;
  return {
    rows: view(rows, prefix, field, []),
    ctx: {
      list, editable, kinds, nestedKinds,
      modifierTypes: Object.fromEntries(Object.entries(CONFIG.WILDPATH.MODIFIER_TYPES).map(([key, type]) => [key, type.label])),
      modes: options(["advantage", "disadvantage"], "WILDPATH.RULES.Mode."),
      movementModes: options(MOVEMENT_MODES, "WILDPATH.RULES.Movement."),
      recovery: options(CONFIG.WILDPATH.RESOURCE_RECOVERY, "WILDPATH.RULES.Recovery."),
      affects: options(["allies", "enemies", "all"], "WILDPATH.RULES.Affects."),
      conditions: {"": "WILDPATH.RULES.While.Always", ...Object.fromEntries(Object.entries(CONFIG.WILDPATH.CONDITIONS)
        .map(([key, condition]) => [key, condition.name ?? key]))}
    }
  };
}

/** Where a rule-row button points: the list's aura path (`"2"` is rule 2's own rules) and, to remove, the index. */
export function ruleButtonPath(target) {
  const path = String(target.dataset.path ?? "").split(".").filter(part => part !== "").map(Number);
  return {list: target.dataset.list, path};
}
