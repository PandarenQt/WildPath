const {SchemaField, NumberField, StringField, ArrayField, SetField, BooleanField, ObjectField} = foundry.data.fields;

/**
 * Build the schema for a single resource pool (health, action, bonus action, reaction, etc).
 * `base` and `bonus` are persisted/manual additive inputs; item/effect modifiers are computed
 * into a transient `modifierBonus` during Actor data preparation. `max` and `value` are
 * derived/clamped outputs (`max = base + bonus + modifierBonus`, `value` clamped to [0, max]).
 * @param {object} [options]
 * @param {number} [options.initial=0]        Initial base value.
 * @param {string} [options.recovery="none"]  Default recovery cadence for this pool.
 * @returns {SchemaField}
 */
export function resourceField({initial=0, recovery="none"}={}) {
  return new SchemaField({
    base: new NumberField({required: true, integer: true, initial}),
    bonus: new NumberField({required: true, integer: true, initial: 0}),
    max: new NumberField({required: true, integer: true, initial, min: 0}),
    value: new NumberField({required: true, integer: true, initial, min: 0}),
    recovery: new StringField({required: true, initial: recovery,
      choices: ["turn", "shortRest", "longRest", "none"]})
  });
}

/* -------------------------------------------- */

/**
 * Schema for a single custom, world/homebrew-defined resource pool. Used inside the
 * `pools` ArrayField on the base actor model so new resources can be added without any
 * code or schema changes.
 * @returns {SchemaField}
 */
export function customPoolField() {
  return new SchemaField({
    id: new StringField({required: true, blank: false}),
    label: new StringField({required: true, blank: false}),
    base: new NumberField({required: true, integer: true, initial: 0}),
    bonus: new NumberField({required: true, integer: true, initial: 0}),
    max: new NumberField({required: true, integer: true, initial: 0, min: 0}),
    value: new NumberField({required: true, integer: true, initial: 0, min: 0}),
    recovery: new StringField({required: true, initial: "none",
      choices: ["turn", "shortRest", "longRest", "none"]})
  });
}

/* -------------------------------------------- */

/**
 * A repeatable field for arbitrary custom resource pools.
 * @returns {ArrayField}
 */
export function poolsField() {
  return new ArrayField(customPoolField());
}

/* -------------------------------------------- */

/**
 * Schema for a single declarative modifier entry, as authored on an Item or ActiveEffect.
 * These are gathered by `WildPathActor#getStatistic(domain)` and reduced by
 * `WildPathStatistic` (see helpers/modifiers.mjs), mirroring PF2e's Modifier/domain/selector
 * calculation engine. `domains` is a set of free-form strings describing which derived value(s)
 * this modifier contributes to (e.g. "resources.health.max", "all") so any homebrew derived
 * value can opt in, and a single modifier may apply to multiple domains at once.
 * @returns {SchemaField}
 */
export function modifierField() {
  return new SchemaField({
    id: new StringField({required: true, blank: true, initial: ""}),
    selector: new StringField({required: true, blank: true, initial: ""}),
    domains: new SetField(new StringField({required: true, blank: false})),
    label: new StringField({required: true, blank: true, initial: ""}),
    type: new StringField({required: true, blank: false, initial: "untyped"}),
    value: new NumberField({required: true, initial: 0}),
    valueExpression: new ObjectField({nullable: true, initial: null}),
    predicate: new ObjectField({nullable: true, initial: null}),
    priority: new NumberField({required: true, integer: true, initial: 100}),
    metadata: new ObjectField({required: true, initial: () => ({})}),
    enabled: new BooleanField({required: true, initial: true}),
    suppressed: new BooleanField({required: true, initial: false})
  });
}

/**
 * A repeatable field for declarative modifiers carried by an Item or ActiveEffect.
 * @returns {ArrayField}
 */
export function modifiersField() {
  return new ArrayField(modifierField());
}

/* -------------------------------------------- */

/**
 * Schema for a single declarative RuleElement entry, as authored on an Item or ActiveEffect.
 * Common fields are stored at the top level; type-specific configuration belongs in `data` so
 * Foundry persistence remains stable while the pure RuleElement registry evolves.
 * @returns {SchemaField}
 */
export function ruleElementField() {
  return new SchemaField({
    schemaVersion: new NumberField({required: true, integer: true, initial: 1, min: 1}),
    id: new StringField({required: true, blank: true, initial: ""}),
    type: new StringField({required: true, blank: false, initial: "Modifier"}),
    key: new StringField({required: true, blank: true, initial: ""}),
    label: new StringField({required: true, blank: true, initial: ""}),
    data: new ObjectField({required: true, initial: () => ({})}),
    predicate: new ObjectField({nullable: true, initial: null}),
    priority: new NumberField({required: true, integer: true, initial: 100}),
    source: new ObjectField({nullable: true, initial: null}),
    metadata: new ObjectField({required: true, initial: () => ({})}),
    enabled: new BooleanField({required: true, initial: true}),
    suppressed: new BooleanField({required: true, initial: false})
  });
}

/**
 * A repeatable field for declarative RuleElements carried by an Item or ActiveEffect.
 * @returns {ArrayField}
 */
export function ruleElementsField() {
  return new ArrayField(ruleElementField());
}

/* -------------------------------------------- */

/**
 * Canonical persisted mechanical definition for an Action Item. Component payloads are validated
 * by the pure ActionDefinition contract; the Foundry schema preserves the composed structure
 * without turning every future action mechanic into a new nullable top-level field.
 * @returns {SchemaField}
 */
export function actionDefinitionField() {
  return new SchemaField({
    schemaVersion: new NumberField({required: true, integer: true, initial: 1, min: 1}),
    id: new StringField({required: true, blank: true, initial: ""}),
    slug: new StringField({required: true, blank: true, initial: ""}),
    label: new StringField({required: true, blank: true, initial: ""}),
    category: new StringField({required: true, blank: false, initial: "action"}),
    tags: new ArrayField(new StringField({required: true, blank: false})),
    source: new ObjectField({nullable: true, initial: null}),
    origin: new ObjectField({nullable: true, initial: null}),
    activation: new ObjectField({nullable: true, initial: null}),
    costs: new ObjectField({required: true, initial: () => ({})}),
    range: new ObjectField({nullable: true, initial: null}),
    targeting: new ObjectField({nullable: true, initial: null}),
    area: new ObjectField({nullable: true, initial: null}),
    attack: new ObjectField({nullable: true, initial: null}),
    save: new ObjectField({nullable: true, initial: null}),
    check: new ObjectField({nullable: true, initial: null}),
    damage: objectArrayField(),
    healing: objectArrayField(),
    effects: objectArrayField(),
    duration: new ObjectField({nullable: true, initial: null}),
    configuration: objectArrayField(),
    ruleElements: ruleElementsField(),
    policies: new ObjectField({required: true, initial: () => ({})}),
    metadata: new ObjectField({required: true, initial: () => ({})})
  });
}

/* -------------------------------------------- */

/**
 * Legacy schema for a single damage/healing-over-time tick. ConditionTriggerResolver translates
 * this into a synthetic Trigger RuleElement when an old condition effect has no `ruleElements`.
 * @returns {SchemaField}
 */
export function dotField() {
  return new SchemaField({
    resource: new StringField({required: true, blank: false, initial: "health"}),
    amount: new NumberField({required: true, integer: true, initial: 1}),
    restoration: new BooleanField({required: true, initial: false})
  });
}

function objectArrayField() {
  return new ArrayField(new ObjectField({required: true, initial: () => ({})}));
}
