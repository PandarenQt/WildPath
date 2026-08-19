/**
 * Core system configuration object for WildPath.
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
 * @property {function} [generator]      Optional (actor, options) => partial ActiveEffect data,
 *                                       used to auto-attach mechanical payloads (e.g. damage-over-time)
 *                                       when the condition is applied.
 */

/**
 * WildPath condition definitions. Populates CONFIG.statusEffects at init time (see wildpath.mjs)
 * so conditions are togglable from the Token HUD like any other Foundry status.
 * @type {Record<string, WildPathConditionConfig>}
 */
WILDPATH.CONDITIONS = {
  prone: {
    id: "prone",
    name: "WILDPATH.CONDITIONS.Prone",
    img: "icons/svg/falling.svg"
  },
  blinded: {
    id: "blinded",
    name: "WILDPATH.CONDITIONS.Blinded",
    img: "icons/svg/blind.svg"
  },
  restrained: {
    id: "restrained",
    name: "WILDPATH.CONDITIONS.Restrained",
    img: "icons/svg/net.svg"
  },
  stunned: {
    id: "stunned",
    name: "WILDPATH.CONDITIONS.Stunned",
    img: "icons/svg/daze.svg"
  },
  unconscious: {
    id: "unconscious",
    name: "WILDPATH.CONDITIONS.Unconscious",
    img: "icons/svg/unconscious.svg"
  },
  exhaustion: {
    id: "exhaustion",
    name: "WILDPATH.CONDITIONS.Exhaustion",
    img: "icons/svg/stoned.svg",
    stacking: true,
    maxLevel: 6
  },
  poisoned: {
    id: "poisoned",
    name: "WILDPATH.CONDITIONS.Poisoned",
    img: "icons/svg/poison.svg",
    generator: (actor, {amount=1}={}) => ({
      dot: [{resource: "health", amount, restoration: false}]
    })
  },
  bleeding: {
    id: "bleeding",
    name: "WILDPATH.CONDITIONS.Bleeding",
    img: "icons/skills/wounds/blood-spurt-spray-red.webp",
    generator: (actor, {amount=1}={}) => ({
      dot: [{resource: "health", amount, restoration: false}]
    })
  }
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
