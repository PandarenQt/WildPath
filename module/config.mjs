/**
 * Core system configuration object for Wild Path.
 * Everything here is intentionally data-driven so a world or module can extend/override
 * entries (add resources, conditions, modifier types, abilities) without touching code.
 * @type {object}
 */
export const WILDPATH = {};

/* -------------------------------------------- */
/*  Abilities                                    */
/* -------------------------------------------- */

/**
 * The baseline set of abilities used to derive resource pools and modifiers.
 * Kept intentionally small and generic - homebrew content can add more via
 * `CONFIG.WILDPATH.ABILITIES` before `init` completes.
 * @type {Record<string, {label: string}>}
 */
WILDPATH.ABILITIES = {
  might: {label: "WILDPATH.ABILITIES.Might"},
  agility: {label: "WILDPATH.ABILITIES.Agility"},
  fortitude: {label: "WILDPATH.ABILITIES.Fortitude"},
  intellect: {label: "WILDPATH.ABILITIES.Intellect"},
  wits: {label: "WILDPATH.ABILITIES.Wits"},
  presence: {label: "WILDPATH.ABILITIES.Presence"}
};

/* -------------------------------------------- */
/*  Skills                                       */
/* -------------------------------------------- */

/**
 * The 2024 skills, each with the ability its checks use unless a check names another. Their ids are the check
 * domains' (`check.stealth`, `check.sleight-of-hand`).
 * @type {Record<string, {label: string, ability: string}>}
 */
/**
 * Heroic Inspiration as Baldur's Gate 3 keeps it (maintainer, 2026-10-18): a player character's pool of up to 4 points,
 * each spent to reroll a d20, its own failed one or, by the GM, a monster's.
 */
WILDPATH.HEROIC_INSPIRATION = Object.freeze({pool: "heroic-inspiration", max: 4});

WILDPATH.SKILLS = {
  acrobatics: {label: "WILDPATH.SKILLS.Acrobatics", ability: "agility"},
  "animal-handling": {label: "WILDPATH.SKILLS.AnimalHandling", ability: "wits"},
  arcana: {label: "WILDPATH.SKILLS.Arcana", ability: "intellect"},
  athletics: {label: "WILDPATH.SKILLS.Athletics", ability: "might"},
  deception: {label: "WILDPATH.SKILLS.Deception", ability: "presence"},
  history: {label: "WILDPATH.SKILLS.History", ability: "intellect"},
  insight: {label: "WILDPATH.SKILLS.Insight", ability: "wits"},
  intimidation: {label: "WILDPATH.SKILLS.Intimidation", ability: "presence"},
  investigation: {label: "WILDPATH.SKILLS.Investigation", ability: "intellect"},
  medicine: {label: "WILDPATH.SKILLS.Medicine", ability: "wits"},
  nature: {label: "WILDPATH.SKILLS.Nature", ability: "intellect"},
  perception: {label: "WILDPATH.SKILLS.Perception", ability: "wits"},
  performance: {label: "WILDPATH.SKILLS.Performance", ability: "presence"},
  persuasion: {label: "WILDPATH.SKILLS.Persuasion", ability: "presence"},
  religion: {label: "WILDPATH.SKILLS.Religion", ability: "intellect"},
  "sleight-of-hand": {label: "WILDPATH.SKILLS.SleightOfHand", ability: "agility"},
  stealth: {label: "WILDPATH.SKILLS.Stealth", ability: "agility"},
  survival: {label: "WILDPATH.SKILLS.Survival", ability: "wits"}
};

/* -------------------------------------------- */
/*  Resource Pools                               */
/* -------------------------------------------- */

/**
 * @typedef WildPathResourceConfig
 * @property {string} label        Display label.
 * @property {string} recovery     One of "turn", "shortRest", "longRest", "none".
 *                                 Determines when the pool automatically refills to max.
 * @property {boolean} [hidden]    Hide this resource from the default sheet resource list.
 */

/**
 * Built-in resource pools. Action economy pools (action/bonus/reaction/movement) reset every
 * turn, mirroring BG3. Additional custom pools may be layered on via each Actor's
 * `system.pools` array without needing new config entries here.
 * @type {Record<string, WildPathResourceConfig>}
 */
WILDPATH.RESOURCES = {
  health: {
    label: "WILDPATH.RESOURCES.Health",
    recovery: "none"
  },
  action: {
    label: "WILDPATH.RESOURCES.Action",
    recovery: "turn"
  },
  bonus: {
    label: "WILDPATH.RESOURCES.BonusAction",
    recovery: "turn"
  },
  reaction: {
    label: "WILDPATH.RESOURCES.Reaction",
    recovery: "turn"
  },
  movement: {
    label: "WILDPATH.RESOURCES.Movement",
    recovery: "turn"
  }
};

/**
 * The recovery cadences a resource (built-in or custom pool) may declare.
 * @type {string[]}
 */
WILDPATH.RESOURCE_RECOVERY = ["turn", "shortRest", "longRest", "none"];

/* -------------------------------------------- */
/*  Modifiers                                    */
/* -------------------------------------------- */

/**
 * Recognized modifier types. Not strictly enforced - a homebrew type string is still
 * accepted by the stacking engine - but these are offered as sane defaults with known
 * stacking behavior (see helpers/modifiers.mjs).
 * "untyped" and "circumstance" always stack with everything else.
 * Every other type only allows a single positive (bonus) and a single negative
 * (penalty) value of that type to apply at once.
 * @type {Record<string, {label: string}>}
 */
WILDPATH.MODIFIER_TYPES = {
  untyped: {label: "WILDPATH.MODIFIERS.Untyped"},
  circumstance: {label: "WILDPATH.MODIFIERS.Circumstance"},
  ability: {label: "WILDPATH.MODIFIERS.Ability"},
  item: {label: "WILDPATH.MODIFIERS.Item"},
  status: {label: "WILDPATH.MODIFIERS.Status"},
  proficiency: {label: "WILDPATH.MODIFIERS.Proficiency"}
};

/**
 * Modifier types which always stack with each other rather than being deduplicated to a
 * single highest bonus / lowest penalty.
 * @type {Set<string>}
 */
WILDPATH.MODIFIER_TYPES_ALWAYS_STACK = new Set(["untyped", "circumstance"]);

/* -------------------------------------------- */
/*  Conditions / Status Effects                  */
/* -------------------------------------------- */

/**
 * @typedef WildPathConditionConfig
 * @property {string} id                 Status identifier, matches CONFIG.statusEffects id.
 * @property {string} name               Localization key for the display name.
 * @property {string} img                Icon path.
 * @property {boolean} [stacking=false]  Whether this condition tracks a numeric level (e.g. Exhaustion).
 * @property {number} [maxLevel]         Maximum level, when stacking.
 * @property {object[]} [ruleElements]   Declarative mechanical contributions persisted onto the
 *                                       condition ActiveEffect when the condition is applied.
 * @property {function} [generator]      Legacy compatibility hook for old condition payloads.
 *                                       Prefer serializable RuleElements for new mechanics.
 */

/**
 * WildPath condition definitions. Populates CONFIG.statusEffects at init time (see wildpath.mjs)
 * so conditions are togglable from the Token HUD like any other Foundry status.
 * @type {Record<string, WildPathConditionConfig>}
 */
/** A 2024 advantage or disadvantage a condition gives, as a RollMode RuleElement. */
const rollMode = (id, domains, mode, predicate=null) => ({schemaVersion: 1, id: `condition.${id}`, type: "RollMode",
  label: id, ...(predicate ? {predicate} : {}), data: {domains, mode}});
const adjacent = value => ({equals: {path: "attack.adjacent", value}});
/** A ceiling on resource maxima: Incapacitated (no actions) and Speed 0. */
const cap = (id, resources) => ({schemaVersion: 1, id: `condition.${id}`, type: "ResourceCap", label: id,
  data: {resources, maximum: 0}});
const INCAPACITATED = ["action", "bonus", "reaction"];
/** A forced outcome: automatic failure on saves, or hits against the creature becoming critical. */
const outcome = (id, domains, forced, predicate=null) => ({schemaVersion: 1, id: `condition.${id}`, type: "RollOutcome",
  label: id, ...(predicate ? {predicate} : {}), data: {domains, outcome: forced}});
/** A RuleElement of `type` with `data`, as a condition gives it. */
const grant = (id, type, data, predicate=null) => ({schemaVersion: 1, id: `condition.${id}`, type, label: id,
  ...(predicate ? {predicate} : {}), data});
/** Gates a rule on the condition's level (2014 Exhaustion): `source` is the condition effect. */
const atLevels = values => ({oneOf: {path: "source.level", values}});
/** Half of a resource's own maximum (base plus bonus), rounded down. */
const half = id => ({type: "divide", round: "floor", denominator: {type: "constant", value: 2}, numerator: {type: "add",
  terms: [{type: "context", path: `actorSystem.resources.${id}.base`}, {type: "context", path: `actorSystem.resources.${id}.bonus`}]}});
/** A Modifier scaled by the condition's level (Exhaustion): `perLevel` per level on `domains`. */
const perLevel = (id, domains, value) => ({schemaVersion: 1, id: `condition.${id}`, type: "Modifier", label: id,
  data: {domains, modifierType: "untyped",
    valueExpression: {type: "multiply", terms: [{type: "context", path: "effect.system.level"}, {type: "constant", value}]}}});

/**
 * A damage-over-time condition: at the start of each of its turns the creature takes `amount` damage of
 * `damageType`, times its stacks when the condition stacks (each application adds a stack). Envenomed
 * (poison) and Bleeding are built this way; another damage type is one more entry.
 */
function damageOverTimeCondition({id, name, summary, img, damageType, amount=1, stacking=true, maxLevel, label}) {
  const perTurn = stacking ? {type: "multiply", terms: [{type: "context", path: "effect.system.level"}, {type: "constant", value: amount}]}
    : {type: "constant", value: amount};
  return {id, name, summary, img, ...(stacking ? {stacking: true} : {}), ...(maxLevel ? {maxLevel} : {}),
    ruleElements: [{schemaVersion: 1, id: `condition.${id}.turn-start-damage`, type: "Trigger", label: label ?? `${id} turn damage`,
      data: {event: "turn.started", payload: {type: "durabilityChange", changeType: "damage", resourceId: "health",
        amount: perTurn, damageType, tags: ["condition", id, "periodic"]}}}]};
}

// The 2024 conditions (maintainer decision, 2026-10-14: 2024 rules; advantage and disadvantage cancel source
// for source). `implies` applies other conditions with this one; `endsConcentration` (Incapacitated) ends
// everything the creature sustains.
WILDPATH.CONDITIONS = {
  prone: {
    id: "prone",
    name: "WILDPATH.CONDITIONS.Prone",
    summary: "WILDPATH.CONDITIONS.Summary.Prone",
    img: "icons/svg/falling.svg",
    ruleElements: [
      rollMode("prone.own-attacks", ["attack"], "disadvantage"),
      rollMode("prone.attacked-within-5ft", ["attacked"], "advantage", adjacent(true)),
      rollMode("prone.attacked-from-farther", ["attacked"], "disadvantage", adjacent(false))
    ]
  },
  blinded: {
    id: "blinded",
    name: "WILDPATH.CONDITIONS.Blinded",
    summary: "WILDPATH.CONDITIONS.Summary.Blinded",
    img: "icons/svg/blind.svg",
    // Unless it perceives its target anyway (Blindsight within range), and while its attacker goes unperceived
    // (`attack.seesTarget`, `attack.seenByTarget`: helpers/senses.mts).
    ruleElements: [
      rollMode("blinded.own-attacks", ["attack"], "disadvantage", {not: {equals: {path: "attack.seesTarget", value: true}}}),
      rollMode("blinded.attacked", ["attacked"], "advantage", {not: {equals: {path: "attack.seenByTarget", value: true}}})
    ]
  },
  restrained: {
    id: "restrained",
    name: "WILDPATH.CONDITIONS.Restrained",
    summary: "WILDPATH.CONDITIONS.Summary.Restrained",
    img: "icons/svg/net.svg",
    ruleElements: [
      rollMode("restrained.own-attacks", ["attack"], "disadvantage"),
      rollMode("restrained.attacked", ["attacked"], "advantage"),
      rollMode("restrained.agility-saves", ["save.agility"], "disadvantage"),
      cap("restrained.speed-0", ["movement"])
    ]
  },
  stunned: {
    id: "stunned",
    name: "WILDPATH.CONDITIONS.Stunned",
    summary: "WILDPATH.CONDITIONS.Summary.Stunned",
    img: "icons/svg/daze.svg",
    endsConcentration: true,
    ruleElements: [rollMode("stunned.attacked", ["attacked"], "advantage"), cap("stunned.incapacitated", INCAPACITATED),
      rollMode("stunned.initiative", ["initiative"], "disadvantage"),
      outcome("stunned.fails-might-agility-saves", ["save.might", "save.agility"], "automatic-failure")]
  },
  unconscious: {
    id: "unconscious",
    name: "WILDPATH.CONDITIONS.Unconscious",
    summary: "WILDPATH.CONDITIONS.Summary.Unconscious",
    img: "icons/svg/unconscious.svg",
    // 2024: Unconscious includes Prone, which stays after waking; it is Incapacitated, so it ends concentration.
    implies: ["prone"],
    endsConcentration: true,
    ruleElements: [rollMode("unconscious.attacked", ["attacked"], "advantage"),
      cap("unconscious.incapacitated", INCAPACITATED), cap("unconscious.speed-0", ["movement"]),
      rollMode("unconscious.initiative", ["initiative"], "disadvantage"),
      outcome("unconscious.fails-might-agility-saves", ["save.might", "save.agility"], "automatic-failure"),
      outcome("unconscious.critical-within-5ft", ["attacked"], "critical-on-hit", adjacent(true))]
  },
  exhaustion: {
    id: "exhaustion",
    name: "WILDPATH.CONDITIONS.Exhaustion",
    summary: "WILDPATH.CONDITIONS.Summary.Exhaustion",
    img: "icons/svg/stoned.svg",
    stacking: true,
    maxLevel: 6,
    // 2024: d20 tests are reduced by 2 per level, and every Speed by 5 ft per level.
    ruleElements: [perLevel("exhaustion.d20-tests", ["attack", "save", "check"], -2),
      perLevel("exhaustion.speed", ["resources.movement.max", "speed"], -5)]
  },
  poisoned: {
    id: "poisoned",
    name: "WILDPATH.CONDITIONS.Poisoned",
    summary: "WILDPATH.CONDITIONS.Summary.Poisoned",
    img: "icons/svg/poison.svg",
    ruleElements: [rollMode("poisoned.own-rolls", ["attack", "check"], "disadvantage")]
  },
  incapacitated: {
    id: "incapacitated",
    name: "WILDPATH.CONDITIONS.Incapacitated",
    summary: "WILDPATH.CONDITIONS.Summary.Incapacitated",
    img: "icons/svg/sleep.svg",
    endsConcentration: true,
    ruleElements: [cap("incapacitated.no-actions", INCAPACITATED), rollMode("incapacitated.initiative", ["initiative"], "disadvantage")]
  },
  paralyzed: {
    id: "paralyzed",
    name: "WILDPATH.CONDITIONS.Paralyzed",
    summary: "WILDPATH.CONDITIONS.Summary.Paralyzed",
    img: "icons/svg/paralysis.svg",
    endsConcentration: true,
    ruleElements: [cap("paralyzed.incapacitated", INCAPACITATED), cap("paralyzed.speed-0", ["movement"]),
      rollMode("paralyzed.initiative", ["initiative"], "disadvantage"), rollMode("paralyzed.attacked", ["attacked"], "advantage"),
      outcome("paralyzed.fails-might-agility-saves", ["save.might", "save.agility"], "automatic-failure"),
      outcome("paralyzed.critical-within-5ft", ["attacked"], "critical-on-hit", adjacent(true))]
  },
  petrified: {
    id: "petrified",
    name: "WILDPATH.CONDITIONS.Petrified",
    summary: "WILDPATH.CONDITIONS.Summary.Petrified",
    img: "icons/svg/statue.svg",
    endsConcentration: true,
    ruleElements: [cap("petrified.incapacitated", INCAPACITATED), cap("petrified.speed-0", ["movement"]),
      rollMode("petrified.initiative", ["initiative"], "disadvantage"), rollMode("petrified.attacked", ["attacked"], "advantage"),
      outcome("petrified.fails-might-agility-saves", ["save.might", "save.agility"], "automatic-failure"),
      grant("petrified.resists-all-damage", "GrantResistance", {damageTypes: []}),
      grant("petrified.not-poisoned", "ConditionImmunity", {conditions: ["poisoned"]})]
  },
  invisible: {
    id: "invisible",
    name: "WILDPATH.CONDITIONS.Invisible",
    summary: "WILDPATH.CONDITIONS.Summary.Invisible",
    img: "icons/svg/invisible.svg",
    // Unless the other creature perceives it anyway (Truesight, Blindsight or Tremorsense within range: helpers/senses.mts).
    ruleElements: [rollMode("invisible.own-attacks", ["attack"], "advantage", {not: {equals: {path: "attack.seenByTarget", value: true}}}),
      rollMode("invisible.attacked", ["attacked"], "disadvantage", {not: {equals: {path: "attack.seesTarget", value: true}}}),
      rollMode("invisible.initiative", ["initiative"], "advantage")]
  },
  deafened: {
    id: "deafened",
    name: "WILDPATH.CONDITIONS.Deafened",
    summary: "WILDPATH.CONDITIONS.Summary.Deafened",
    img: "icons/svg/deaf.svg",
    ruleElements: []
  },
  frightened: {
    id: "frightened",
    name: "WILDPATH.CONDITIONS.Frightened",
    summary: "WILDPATH.CONDITIONS.Summary.Frightened",
    img: "icons/svg/terror.svg",
    // Only while the source of its fear is within line of sight (`fearSourceOutOfSight`, adapters/foundry-v14-fear.mts);
    // it can't willingly move closer to it (the movement authority's directed movement policy).
    ruleElements: [rollMode("frightened.own-rolls", ["attack", "check"], "disadvantage",
      {not: {equals: {path: "fearSourceOutOfSight", value: true}}})]
  },
  grappled: {
    id: "grappled",
    name: "WILDPATH.CONDITIONS.Grappled",
    summary: "WILDPATH.CONDITIONS.Summary.Grappled",
    img: "icons/svg/anchor.svg",
    // `attack.fromTarget` holds the conditions the attacker has from its target, so attacking the grappler is free.
    ruleElements: [cap("grappled.speed-0", ["movement"]), rollMode("grappled.attacks-other-targets", ["attack"], "disadvantage",
      {not: {equals: {path: "attack.fromTarget.grappled", value: true}}})]
  },
  // Charmed has no rules of its own: the authority refuses a harmful Action against the charmer (the effect's source).
  charmed: {
    id: "charmed",
    name: "WILDPATH.CONDITIONS.Charmed",
    summary: "WILDPATH.CONDITIONS.Summary.Charmed",
    img: "icons/svg/angel.svg",
    ruleElements: []
  },
  // Foundry's Defeated status (CONFIG.specialStatusEffects.DEFEATED): a dead creature neither acts nor moves.
  dead: {
    id: "dead",
    name: "WILDPATH.CONDITIONS.Dead",
    summary: "WILDPATH.CONDITIONS.Summary.Dead",
    img: "icons/svg/skull.svg",
    endsConcentration: true,
    ruleElements: [cap("dead.no-actions", [...INCAPACITATED, "movement"])]
  },
  // Poisoned's former damage each turn, kept by the maintainer (2026-10-14) as its own stacking condition.
  envenomed: damageOverTimeCondition({id: "envenomed", name: "WILDPATH.CONDITIONS.Envenomed", summary: "WILDPATH.CONDITIONS.Summary.Envenomed",
    img: "icons/skills/wounds/blood-cells-disease-green.webp", damageType: "poison", label: "WILDPATH.CONDITIONS.TurnDamageOf.Envenomed"}),
  bleeding: damageOverTimeCondition({id: "bleeding", name: "WILDPATH.CONDITIONS.Bleeding", summary: "WILDPATH.CONDITIONS.Summary.Bleeding",
    img: "icons/skills/wounds/blood-spurt-spray-red.webp", damageType: "bleeding", stacking: false,
    label: "WILDPATH.CONDITIONS.TurnDamageOf.Bleeding"})
};

/**
 * The 2014 conditions where they differ from the 2024 ones, for worlds playing by the 2014 rules (the
 * `rulesVersion` setting): no initiative effects, Stunned and Unconscious stop movement, Grappled only stops it,
 * Petrified is immune to poison, and Exhaustion is the six-level table (death at 6 is the dying rules').
 */
const conditions2024 = WILDPATH.CONDITIONS;
/** A 2024 condition without its initiative rule, plus `added` rules. */
const as2014 = (id, added=[]) => ({...conditions2024[id],
  ruleElements: [...conditions2024[id].ruleElements.filter(rule => !rule.id.endsWith(".initiative")), ...added]});
WILDPATH.CONDITIONS_2014 = {
  stunned: {...as2014("stunned", [cap("stunned.speed-0", ["movement"])]), summary: "WILDPATH.CONDITIONS.Summary.Stunned2014"},
  unconscious: as2014("unconscious"),
  incapacitated: as2014("incapacitated"),
  paralyzed: as2014("paralyzed"),
  petrified: as2014("petrified", [grant("petrified.poison-immunity", "GrantImmunity", {damageTypes: ["poison"]})]),
  invisible: as2014("invisible"),
  grappled: {...conditions2024.grappled, summary: "WILDPATH.CONDITIONS.Summary.Grappled2014", ruleElements: [cap("grappled.speed-0", ["movement"])]},
  exhaustion: {...conditions2024.exhaustion, summary: "WILDPATH.CONDITIONS.Summary.Exhaustion2014", ruleElements: [
    rollMode("exhaustion.checks", ["check"], "disadvantage"),
    // shortcut: halving caps every Speed at half the walking Speed's own maximum; upgrade with per-Speed caps.
    grant("exhaustion.speed-halved", "ResourceCap", {resources: ["movement"], maximum: half("movement")}, atLevels([2, 3, 4])),
    rollMode("exhaustion.attacks-saves", ["attack", "save"], "disadvantage", atLevels([3, 4, 5, 6])),
    grant("exhaustion.hit-point-maximum-halved", "ResourceCap", {resources: ["health"], maximum: half("health")}, atLevels([4, 5, 6])),
    grant("exhaustion.speed-0", "ResourceCap", {resources: ["movement"], maximum: 0}, atLevels([5, 6]))]}
};

/* -------------------------------------------- */
/*  Action Costs                                 */
/* -------------------------------------------- */

/**
 * The set of resource ids which Action items may reference in their `cost` schema shortcuts.
 * Kept separate from WILDPATH.RESOURCES so the Action cost UI can special-case these while
 * still allowing arbitrary custom resource costs via `cost.custom`.
 * @type {string[]}
 */
WILDPATH.ACTION_COST_RESOURCES = ["action", "bonus", "reaction", "movement"];

/* -------------------------------------------- */
/*  Action Economy                               */
/* -------------------------------------------- */

/**
 * Built-in economy capability identifiers. Custom resources may advertise these capabilities
 * or provide their own new capability strings; this is deliberately not a closed enum.
 * @type {Record<string, string>}
 */
WILDPATH.ECONOMY_CAPABILITIES = {
  action: "action",
  bonusAction: "bonus-action",
  reaction: "reaction",
  movement: "movement",
  legendaryAction: "legendary-action",
  lairAction: "lair-action"
};

/**
 * Built-in spendable economy resource definitions. The pure economy service accepts these
 * definitions plus arbitrary custom definitions with the same shape.
 * @type {Record<string, object>}
 */
WILDPATH.ECONOMY_RESOURCES = {
  "economy.action": {
    label: "WILDPATH.RESOURCES.Action",
    category: "action",
    unit: "uses",
    paymentCapabilities: ["action"],
    refreshPolicies: ["turnStart"]
  },
  "economy.bonus-action": {
    label: "WILDPATH.RESOURCES.BonusAction",
    category: "bonus-action",
    unit: "uses",
    paymentCapabilities: ["bonus-action"],
    refreshPolicies: ["turnStart"]
  },
  "economy.reaction": {
    label: "WILDPATH.RESOURCES.Reaction",
    category: "reaction",
    unit: "uses",
    paymentCapabilities: ["reaction"],
    refreshPolicies: ["turnStart"]
  },
  "economy.movement": {
    label: "WILDPATH.RESOURCES.Movement",
    category: "movement",
    unit: "movement",
    paymentCapabilities: ["movement"],
    refreshPolicies: ["turnStart"]
  },
  "economy.legendary-action": {
    label: "WILDPATH.RESOURCES.LegendaryAction",
    category: "legendary-action",
    unit: "points",
    paymentCapabilities: ["legendary-action"],
    refreshPolicies: ["turnStart"]
  },
  "economy.lair-action": {
    label: "WILDPATH.RESOURCES.LairAction",
    category: "lair-action",
    unit: "uses",
    paymentCapabilities: ["lair-action"],
    refreshPolicies: ["roundStart"]
  }
};

/* -------------------------------------------- */
/*  Movement Measurement                         */
/* -------------------------------------------- */

WILDPATH.MOVEMENT_MEASUREMENT_MODES = {
  distance: "distance",
  fields: "fields"
};

WILDPATH.DEFAULT_MOVEMENT_MEASUREMENT_MODE = "distance";
