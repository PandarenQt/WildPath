/**
 * The 2024 actions every creature has, after Baldur's Gate 3's common actions: Dash, Disengage, Dodge, Hide,
 * Grapple, Shove and an Unarmed Strike. They are not Items. The authority builds each from its id (an intent's
 * `actionRef: "common:dash"`), so a client can name one but never supply its rules, and no creature carries copies.
 */
const ACTION = { allOf: [{ capability: "action", amount: 1 }] };
const SELF = { range: { type: "self" }, targeting: { type: "self" } };
const TOUCH = { range: { type: "reach", distance: { value: 5, unit: "ft" } }, targeting: { type: "single", required: true, count: 1 } };
const UNTIL_TURN_END = { value: 0, units: "turns", expiry: "turnEnd" };
const UNTIL_NEXT_TURN = { value: 1, units: "rounds", expiry: "turnStart" };
/** An Unarmed Strike's save DC: 8 + Might modifier + Proficiency Bonus. */
const STRIKE_DC = { valueExpression: { type: "add", terms: [{ type: "constant", value: 8 }, { type: "ability-modifier", ability: "might" },
            { type: "proficiency-bonus" }] } };
// shortcut: the target saves with Might; 2024 lets it choose Might or Agility. Upgrade with a target's choice of save.
const strikeSave = (effect) => ({ ...TOUCH, save: { ability: "might", dc: STRIKE_DC },
    effects: [{ id: "on-fail", type: "condition", saveOutcomePolicy: "failure", ...effect }] });
/** Each common action: its lang key, icon and definition (without id and label, which `commonAction` adds). */
const COMMON = {
    dash: { name: "WILDPATH.COMMON.Dash", img: "icons/svg/wingfoot.svg", definition: { costs: ACTION, ...SELF,
            // shortcut: the extra movement is the Speed before Modifiers (Exhaustion is not doubled); upgrade with a Speed snapshot.
            effects: [{ id: "dashing", type: "effect", name: "Dashing", slug: "dashing", img: "icons/svg/wingfoot.svg", duration: UNTIL_TURN_END,
                    ruleElements: [{ schemaVersion: 1, id: "dash", type: "Modifier", data: { domains: ["resources.movement.max"], modifierType: "untyped",
                                valueExpression: { type: "add", terms: [{ type: "context", path: "actorSystem.resources.movement.base" },
                                        { type: "context", path: "actorSystem.resources.movement.bonus" }] } } }] }] } },
    disengage: { name: "WILDPATH.COMMON.Disengage", img: "icons/svg/walk.svg", definition: { costs: ACTION, ...SELF,
            effects: [{ id: "disengaged", type: "effect", name: "Disengaged", slug: "disengaged", img: "icons/svg/walk.svg",
                    duration: UNTIL_TURN_END, ruleElements: [] }] } },
    dodge: { name: "WILDPATH.COMMON.Dodge", img: "icons/svg/shield.svg", definition: { costs: ACTION, ...SELF,
            effects: [{ id: "dodging", type: "effect", name: "Dodging", slug: "dodging", img: "icons/svg/shield.svg", duration: UNTIL_NEXT_TURN,
                    ruleElements: [
                        { schemaVersion: 1, id: "dodge-attacked", type: "RollMode", data: { domains: ["attacked"], mode: "disadvantage" } },
                        { schemaVersion: 1, id: "dodge-agility", type: "RollMode", data: { domains: ["save.agility"], mode: "advantage" } }
                    ] }] } },
    hide: { name: "WILDPATH.COMMON.Hide", img: "icons/svg/cowled.svg", definition: { costs: ACTION, ...SELF,
            check: { ability: "agility", skill: "stealth", dc: { value: 15 } },
            effects: [{ id: "hidden", type: "condition", conditionId: "invisible", checkOutcomePolicy: "success" }] } },
    grapple: { name: "WILDPATH.COMMON.Grapple", img: "icons/svg/anchor.svg", definition: { costs: ACTION, ...strikeSave({ conditionId: "grappled" }) } },
    // Push is not here yet: it needs forced movement (roadmap G6).
    shove: { name: "WILDPATH.COMMON.Shove", img: "icons/svg/falling.svg", definition: { costs: ACTION, ...strikeSave({ conditionId: "prone" }) } },
    unarmed: { name: "WILDPATH.COMMON.UnarmedStrike", img: "icons/svg/combat.svg", definition: { costs: ACTION, ...TOUCH,
            attack: { type: "melee", statistic: "weapon", defenseKey: "ac", proficient: true },
            damage: [{ id: "unarmed", expression: { type: "constant", value: 1 }, damageType: "bludgeoning", provenance: "weapon-base" }] } }
};
export const COMMON_ACTION_IDS = Object.freeze(Object.keys(COMMON));
/** An Action ref naming a common action, `common:<id>`; its id, or null. */
export function commonActionId(ref) {
    const match = /^common:([a-z]+)$/.exec(String(ref ?? ""));
    return match && Object.hasOwn(COMMON, match[1]) ? match[1] : null;
}
/**
 * The common action `id` as an Action Item of `actor`, built fresh: `{id, uuid: "common:<id>", type: "action",
 * name, img, system: {definition}, actor}`. `localize` turns its lang key into its name.
 */
export function commonAction(actor, id, { localize = (key) => key } = {}) {
    const entry = COMMON[id];
    if (!entry)
        return null;
    const name = localize(entry.name);
    return { id: `common-${id}`, uuid: `common:${id}`, type: "action", name, img: entry.img, flags: {},
        system: { active: true, definition: { schemaVersion: 1, id: `common:${id}`, label: name, ...structuredClone(entry.definition) } },
        actor };
}
