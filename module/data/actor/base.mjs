import {WILDPATH} from "../../config.mjs";
import {defenseField, resourceField, poolsField} from "../fields.mjs";
import {computeResourceMax, clampResourceValue, remainingFromSpent, spentFromRemaining} from "../../helpers/resources.mjs";
import {SPELLCASTING_PROGRESSIONS, deriveClassData, spellSlotPoolId} from "../../helpers/spellcasting.mjs";
import {formOverrides} from "../../helpers/transformations.mjs";
import {movementSpeeds} from "../../helpers/movement-modes.mjs";
import {abilityScoreAfter} from "../../helpers/rule-elements.mjs";

/** Action-economy counters: what is spent is stored, what remains is derived from the (modifiable) maximum. */
const COUNTED_RESOURCES = Object.freeze(["action", "bonus", "reaction", "movement"]);

const {SchemaField, NumberField, HTMLField, ArrayField, StringField, BooleanField} = foundry.data.fields;

/**
 * Shared data schema, derived-data preparation, and helper methods used by every Actor
 * sub-type in the WildPath system (character, npc, ...).
 *
 * Ability keys are fixed at the schema level (mirrors dnd5e/crucible): CONFIG.WILDPATH.ABILITIES
 * only controls labels/ordering for existing keys. Adding a wholly new ability requires extending
 * this schema (documented here as a known follow-up rather than solved generically), whereas
 * *resources* (see `pools`) and *modifiers* are fully data-driven and need no schema changes.
 */
export default class WildPathBaseActor extends foundry.abstract.TypeDataModel {

  /** @inheritDoc */
  static defineSchema() {
    const abilitySchema = () => new SchemaField({
      value: new NumberField({required: true, integer: true, initial: 10, min: 0}),
      // Proficient in this ability's saves: the proficiency bonus joins them (combat-statistics.mjs).
      saveProficient: new BooleanField({required: true, initial: false})
    });
    const abilities = {};
    for ( const key of Object.keys(WILDPATH.ABILITIES) ) abilities[key] = abilitySchema();
    // Skill proficiency (2024): 0 none, 1 proficient, 2 expertise (twice the proficiency bonus).
    const skills = Object.fromEntries(Object.keys(WILDPATH.SKILLS).map(key => [key, new SchemaField({
      proficiency: new NumberField({required: true, integer: true, initial: 0, min: 0, max: 2})})]));
    const names = () => new ArrayField(new StringField({required: true, blank: false}));

    return {
      biography: new HTMLField({required: true, blank: true}),
      abilities: new SchemaField(abilities),
      skills: new SchemaField(skills),
      // What it is trained with: armor (light, medium, heavy, shield), weapons (simple, martial, or a weapon), tools,
      // and the weapons whose mastery it uses (2024).
      training: new SchemaField({armor: names(), weapons: names(), tools: names(), masteries: names()}),
      defenses: new SchemaField({
        ac: defenseField({initial: null})
      }),
      resources: new SchemaField({
        health: resourceField({initial: 10, recovery: "none", temporary: true}),
        action: resourceField({initial: 1, recovery: "turn", counted: true}),
        bonus: resourceField({initial: 1, recovery: "turn", counted: true}),
        reaction: resourceField({initial: 1, recovery: "turn", counted: true}),
        movement: resourceField({initial: 30, recovery: "turn", counted: true})
      }),
      pools: poolsField(),
      // One record per class (multiclassing is the normal case); total level, the original class and
      // spellcasting are derived from these (helpers/spellcasting.mts).
      classes: new ArrayField(new SchemaField({
        id: new StringField({required: true, blank: false}),
        name: new StringField({required: true, blank: true}),
        level: new NumberField({required: true, integer: true, initial: 1, min: 1}),
        // Its Hit Die's faces (d10: 10): one Hit Die of that size per level.
        hitDie: new NumberField({required: false, nullable: true, integer: true, initial: null}),
        original: new BooleanField(),
        subclasses: new ArrayField(new StringField({required: true, blank: false})),
        spellcasting: new SchemaField({
          progression: new StringField({required: true, initial: SPELLCASTING_PROGRESSIONS.NONE,
            choices: Object.values(SPELLCASTING_PROGRESSIONS)}),
          ability: new StringField({required: true, blank: true})
        })
      })),
      // A companion, summon or sidekick lists the creatures that control it. Every Player who owns one of
      // them controls it too, and its Actions may also cost the controller that commands them (companions.md).
      companion: new SchemaField({
        kind: new StringField({required: true, initial: "companion", choices: ["companion", "summon", "sidekick"]}),
        controllers: new ArrayField(new StringField({required: true, blank: false}))
      }),
      // Whether this creature makes death saves at 0 health or dies (dying-and-death.md): `auto` is a character,
      // or a companion or sidekick a Player controls; `deathSaves` and `dies` set it for this creature.
      dyingMode: new StringField({required: true, initial: "auto", choices: ["auto", "deathSaves", "dies"]}),
      // Death saves while at 0 health (2024): three successes stabilize, three failures are death.
      deathSaves: new SchemaField({
        successes: new NumberField({required: true, integer: true, initial: 0, min: 0, max: 3}),
        failures: new NumberField({required: true, integer: true, initial: 0, min: 0, max: 3})
      }),
      status: new SchemaField({
        turnsTaken: new NumberField({required: true, integer: true, initial: 0, min: 0})
      })
    };
  }

  /* -------------------------------------------- */

  /**
   * Counters stored before `spent` existed keep their state: spent = (base + bonus) - remaining. Foundry also
   * migrates partial update data; a write without `base` is not a stored counter, and _preUpdate translates it.
   */
  static migrateData(source) {
    for ( const id of COUNTED_RESOURCES ) {
      const resource = source.resources?.[id];
      if ( !resource || ("spent" in resource) || !("value" in resource) || !("base" in resource) ) continue;
      resource.spent = spentFromRemaining(resource.base + (resource.bonus ?? 0), resource.value);
    }
    return super.migrateData(source);
  }

  /* -------------------------------------------- */

  /**
   * Every writer of a counted resource (payment, turn recovery, the sheet) sets its remaining `value`;
   * store it as the matching `spent` against the current maximum, which effects may have changed.
   * @inheritDoc
   */
  async _preUpdate(changes, options, user) {
    if ( (await super._preUpdate(changes, options, user)) === false ) return false;
    const classes = foundry.utils.getProperty(changes, "system.classes");
    if ( Array.isArray(classes) ) {
      const pools = this.#withClassPools(classes, foundry.utils.getProperty(changes, "system.pools") ?? this.parent.toObject(true).system.pools);
      if ( pools ) foundry.utils.setProperty(changes, "system.pools", pools);
    }
    // A counted resource keeps its stored remaining value and spent count in step: a write of one sets the
    // other; a write of both (a payment) is kept as given.
    for ( const id of COUNTED_RESOURCES ) {
      const valuePath = `system.resources.${id}.value`;
      const spentPath = `system.resources.${id}.spent`;
      const value = foundry.utils.getProperty(changes, valuePath) ?? changes[valuePath];
      const spent = foundry.utils.getProperty(changes, spentPath) ?? changes[spentPath];
      if ( (typeof value === "number") && (typeof spent !== "number") ) {
        foundry.utils.setProperty(changes, spentPath, spentFromRemaining(this.resources[id].max, value));
      } else if ( (typeof spent === "number") && (typeof value !== "number") ) {
        foundry.utils.setProperty(changes, valuePath, remainingFromSpent(this.resources[id].max, spent));
      }
    }
  }

  /** @inheritDoc */
  async _preCreate(data, options, user) {
    if ( (await super._preCreate(data, options, user)) === false ) return false;
    const stored = this.#withClassPools(data.system?.classes ?? [], data.system?.pools ?? []) ?? data.system?.pools ?? [];
    // An Actor created with granting Items (an import) gets their pools at once.
    const granted = this.parent.grantedPoolsMissing?.(stored) ?? [];
    if ( (stored !== data.system?.pools) || granted.length ) this.parent.updateSource({"system.pools": [...stored, ...granted]});
  }

  /* -------------------------------------------- */

  /**
   * A caster gets a pool for every spell level its classes reach, so slots can be spent and recovered, and a
   * creature with classes a pool of Hit Dice per die size; the maxima are derived from the classes. Returns the
   * pools to store, or null when none is missing.
   */
  #withClassPools(classes, pools) {
    const derived = deriveClassData(classes);
    const existing = new Set(pools.map(pool => pool.id));
    const format = (key, data, fallback) => globalThis.game?.i18n?.format?.(key, data) ?? fallback;
    const missing = [
      ...derived.spellcasting.slots.map((count, index) => [spellSlotPoolId(index + 1), count,
        format("WILDPATH.SPELLCASTING.SlotPool", {level: index + 1}, spellSlotPoolId(index + 1))]),
      ...Object.entries(derived.hitDice).map(([id, count]) => [id, count, format("WILDPATH.HITDICE.Pool", {die: id.split(".").pop()}, id)])
    ].flatMap(([id, count, label]) => ((!count || existing.has(id)) ? []
      : [{id, label, base: 0, bonus: 0, max: count, value: count, recovery: "longRest"}]));
    return missing.length ? [...pools, ...missing] : null;
  }

  /* -------------------------------------------- */
  /*  Data Preparation                             */
  /* -------------------------------------------- */

  /** @inheritDoc */
  prepareBaseData() {
    super.prepareBaseData();
    // `bonus` is a persisted/manual value; `modifierBonus` is a transient, per-cycle property
    // (not part of the schema) recomputed fresh in #applyResourceModifiers every prepare pass.
    for ( const resource of Object.values(this.resources) ) {
      resource.bonus ??= 0;
      resource.modifierBonus = 0;
    }
    for ( const pool of this.pools ) {
      pool.bonus ??= 0;
      pool.modifierBonus = 0;
    }
    // Each pass starts each score from its stored value (`base`, what the sheet edits): a form and rules change it
    // later (#applyAbilityScores), never twice.
    for ( const [key, ability] of Object.entries(this.abilities ?? {}) ) {
      ability.base = this._source?.abilities?.[key]?.value ?? ability.value;
      ability.value = ability.base;
    }
    // A transformation replaces the statistics it lists with its form's; everything else stays the creature's.
    const transformation = this.parent?.transformation;
    const form = transformation ? globalThis.fromUuidSync?.(transformation.policy.formRef) : null;
    if ( form?.toObject ) {
      for ( const [path, value] of formOverrides(form.toObject(true).system, transformation.policy.takes) ) {
        foundry.utils.setProperty(this, path, value);
      }
    }
    // Where rules start: the creature's own score, or its form's.
    for ( const ability of Object.values(this.abilities ?? {}) ) ability.formed = ability.value;
  }

  /* -------------------------------------------- */

  /** @inheritDoc */
  prepareDerivedData() {
    super.prepareDerivedData();
    // First: hit points, saves, AC and every modifier read the scores.
    this.#applyAbilityScores();
    this.#deriveClasses();
    this.#applyResourceModifiers();
    this.#finalizeResources();
    // Walking Speed is the movement maximum; other Speeds come from grants (GrantMovement). Modifiers on `speed`
    // (Exhaustion) or the mode's own (`speed.fly`: Ray of Frost), then its factors, and a movement cap (Speed 0) reach them.
    const grants = (this.parent?.getGrantedMovement?.() ?? []).map(grant => {
      const mode = grant.mode ?? "walk";
      const bonus = this.parent?.getStatistic?.(["speed", `speed.${mode}`])?.totalModifier ?? 0;
      return {...grant, distance: Math.min(Math.max(Math.floor(((Number(grant.distance) || 0) + bonus) * this.#speedFactor(mode)), 0),
        this.resourceCaps.movement ?? Infinity)};
    });
    this.speeds = movementSpeeds(this.resources.movement.max, grants);
  }

  /* -------------------------------------------- */

  /** Ability scores after the creature's `AbilityScore` rules (a Belt of Giant Strength), from its own or its form's. */
  #applyAbilityScores() {
    const changes = this.parent?.getAbilityScoreChanges?.() ?? [];
    for ( const [key, ability] of Object.entries(this.abilities ?? {}) ) {
      const own = changes.filter(change => change.ability === key);
      const start = ability.formed ?? ability.base ?? ability.value;
      ability.value = own.length ? abilityScoreAfter(start, own) : start;
    }
  }

  /* -------------------------------------------- */

  /**
   * With class records, the total level is their sum (a character's `details.level` is then derived);
   * `originalClass` and `spellcasting` ({casterLevel, ability, slots}) come from the same records.
   */
  #deriveClasses() {
    const derived = deriveClassData(this.classes);
    if ( this.classes.length && this.details && ("level" in this.details) ) this.details.level = derived.level;
    this.originalClass = derived.original;
    this.spellcasting = derived.spellcasting;
    this.hitDice = derived.hitDice;
  }

  /* -------------------------------------------- */

  /**
   * Collect modifiers targeting each resource's max value from Items/ActiveEffects (via the
   * PF2e-style `Actor#getStatistic` domain lookup) into the transient `modifierBonus` property.
   * Always *assigns* (never accumulates) so this stays idempotent across repeated prepare passes
   * - Foundry does not guarantee `prepareDerivedData()` runs only once per update, and `+=` onto
   * a field here would silently inflate `max` the more times preparation happens to run.
   */
  #applyResourceModifiers() {
    for ( const id of Object.keys(this.resources) ) {
      this.resources[id].modifierBonus = this.parent.getStatistic?.(`resources.${id}.max`)?.totalModifier ?? 0;
    }
    // Spell slot pools also hold what the class progression gives at the current caster level, and every
    // pool what its grants give (`GrantResource`).
    const granted = new Map([...this.spellcasting.slots.map((count, index) => [spellSlotPoolId(index + 1), count]),
      ...Object.entries(this.hitDice ?? {})]);
    for ( const {id, maximum} of this.parent.getGrantedResources?.() ?? [] ) granted.set(id, (granted.get(id) ?? 0) + maximum);
    for ( const pool of this.pools ) {
      pool.modifierBonus = (this.parent.getStatistic?.(`pools.${pool.id}.max`)?.totalModifier ?? 0)
        + (granted.get(pool.id) ?? 0);
    }
  }

  /* -------------------------------------------- */

  /**
   * Compute final max values and clamp current values within [0, max] for every resource pool,
   * built-in and custom alike. Delegates the actual math to the pure, unit-tested helpers in
   * helpers/resources.mjs so the same idempotent computation is verifiable outside Foundry.
   */
  #finalizeResources() {
    this.resourceCaps = this.parent?.getResourceCaps?.() ?? {};
    for ( const [id, resource] of Object.entries(this.resources) ) {
      // Walking Speed (the movement maximum) times its factors (Haste, Slow).
      const factor = (id === "movement") ? this.#speedFactor("walk") : 1;
      resource.max = Math.min(Math.floor(computeResourceMax(resource, resource.modifierBonus) * factor), this.resourceCaps[id] ?? Infinity);
      resource.value = COUNTED_RESOURCES.includes(id) ? remainingFromSpent(resource.max, resource.spent)
        : clampResourceValue(resource.value, resource.max);
    }
    for ( const pool of this.pools ) {
      pool.max = computeResourceMax(pool, pool.modifierBonus);
      pool.value = clampResourceValue(pool.value, pool.max);
    }
  }

  /**
   * A Speed's factor: the product of the Modifiers on `speed.multiplier` (every Speed) and `speed.<mode>.multiplier`
   * (Haste 2, Slow 0.5; two halvings quarter it), 1 with none.
   */
  #speedFactor(mode) {
    const domains = ["speed.multiplier", `speed.${mode}.multiplier`];
    // Only Modifiers naming a factor: a wildcard (`all`) bonus is not one.
    const applied = (this.parent?.getStatistic?.(domains)?.applied ?? [])
      .filter(modifier => [...(modifier.domains ?? [])].some(domain => domains.includes(domain)));
    return applied.reduce((product, modifier) => product * (Number.isFinite(Number(modifier.value)) ? Number(modifier.value) : 1), 1);
  }

  /* -------------------------------------------- */
  /*  Helpers                                      */
  /* -------------------------------------------- */

  /**
   * Retrieve a resource pool (built-in or custom) by id.
   * @param {string} id
   * @returns {{base: number, bonus: number, max: number, value: number, recovery: string}|null}
   */
  getResource(id) {
    if ( id in this.resources ) return this.resources[id];
    return this.pools.find(p => p.id === id) ?? null;
  }
}
