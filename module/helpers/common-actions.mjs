/**
 * The 2024 actions every creature has, after Baldur's Gate 3's common actions: Dash, Disengage, Dodge, Hide,
 * Grapple, Shove, an Unarmed Strike, and the Opportunity Attack reaction. They are not Items. The authority builds
 * each from its id (an intent's `actionRef: "common:dash"`), so a client can name one but never supply its rules,
 * and no creature carries copies.
 */
import { actionDefinitionActivationCost, actionDefinitionFromAction } from "./action-definitions.mjs";
import { actorAbilityModifier, actorProficiencyBonus, resolveActorCheckStatistic } from "./combat-statistics.mjs";
import { WILDPATH } from "../config.mjs";
const definitionOf = actionDefinitionFromAction;
const costOf = actionDefinitionActivationCost;
const ACTION = { allOf: [{ capability: "action", amount: 1 }] };
const BONUS_ACTION = { allOf: [{ capability: "bonus-action", amount: 1 }] };
/** The shoves, a Bonus Action under Baldur's Gate 3's rule (`bonusShove`, the `bonusActionShove` world setting). */
const SHOVES = new Set(["shove", "push"]);
const SELF = { range: { type: "self" }, targeting: { type: "self" } };
const TOUCH = { range: { type: "reach", distance: { value: 5, unit: "ft" } }, targeting: { type: "single", required: true, count: 1 } };
/** Grapple and Shove (2024): "no more than one size larger than you". */
const GRAB = { ...TOUCH, targeting: { ...TOUCH.targeting, maxSizeAboveSource: 1 } };
const UNTIL_TURN_END = { value: 0, units: "turns", expiry: "turnEnd" };
/** Where 2024 Hide may be taken: Heavily Obscured, or no foe with a line to it at less than Three-Quarters Cover. */
const HIDDEN_PLACE = { any: [{ equals: { path: "obscured", value: "heavily" } }, { not: { oneOf: { path: "coverFromFoes", values: ["none", "half"] } } }] };
const UNTIL_NEXT_TURN = { value: 1, units: "rounds", expiry: "turnStart" };
/** An Unarmed Strike's save DC: 8 + Might modifier + Proficiency Bonus. */
const STRIKE_DC = { valueExpression: { type: "add", terms: [{ type: "constant", value: 8 }, { type: "ability-modifier", ability: "might" },
            { type: "proficiency-bonus" }] } };
// 2024: the target saves with Might or Agility, its choice: the one it is likelier to pass (`abilities`, the runtime).
const STRIKE_SAVE = { ability: "might", abilities: ["might", "agility"], dc: STRIKE_DC };
// 2024 escape: a check against the escape DC of a hold (any effect with `metadata.escapeDC`: a Grappled, a custom Net); a
// success ends that hold (escapable, commonAction).
const ESCAPE = { costs: ACTION, check: { skill: "athletics", dc: { value: 10 } },
    effects: [{ id: "escaped", type: "condition", conditionId: "grappled", levels: -1, checkOutcomePolicy: "success" }] };
const strikeSave = (effect) => ({ ...GRAB, save: STRIKE_SAVE,
    effects: [{ id: "on-fail", type: "condition", saveOutcomePolicy: "failure", ...effect }] });
/**
 * Help's Assisted, on an ability check: Advantage on its bearer's next check in `domain`, ending with it or at the start of
 * the helper's next turn (the 2024 Assist's skill, `check.{{skill}}`; the converter's 2014 Help, any `check`).
 */
export function assistedEffect(domain) {
    return { id: "assisted", type: "effect", name: "Assisted", slug: "assisted", img: "icons/svg/upgrade.svg",
        duration: { value: 1, units: "rounds", expiry: "sourceTurnStart" }, endsWhen: "checks",
        ruleElements: [{ schemaVersion: 1, id: "assist-check", type: "RollMode", data: { domains: [domain], mode: "advantage" } }] };
}
/** Each common action: its lang key, icon and definition (without id and label, which `commonAction` adds). */
const COMMON = {
    // 2024 Dash: "extra movement for the current turn ... equal to your Speed after applying any modifiers": its Speed
    // once more for each Dash this turn (`speed.dash`; a second, with Action Surge, three times in all), after its
    // Modifiers (Exhaustion, Slow) and with its other factors (Haste and a Dash: four times).
    dash: { name: "WILDPATH.COMMON.Dash", img: "icons/svg/wingfoot.svg", definition: { costs: ACTION, ...SELF,
            effects: [{ id: "dashing", type: "effect", name: "Dashing", slug: "dashing", img: "icons/svg/wingfoot.svg", duration: UNTIL_TURN_END,
                    stack: "separate",
                    ruleElements: [{ schemaVersion: 1, id: "dash", type: "Modifier", data: { domains: ["speed.dash"], modifierType: "untyped", value: 1 } }] }] } },
    disengage: { name: "WILDPATH.COMMON.Disengage", img: "icons/svg/walk.svg", definition: { costs: ACTION, ...SELF,
            effects: [{ id: "disengaged", type: "effect", name: "Disengaged", slug: "disengaged", img: "icons/svg/walk.svg",
                    duration: UNTIL_TURN_END, ruleElements: [] }] } },
    dodge: { name: "WILDPATH.COMMON.Dodge", img: "icons/svg/shield.svg", definition: { costs: ACTION, ...SELF,
            effects: [{ id: "dodging", type: "effect", name: "Dodging", slug: "dodging", img: "icons/svg/shield.svg", duration: UNTIL_NEXT_TURN,
                    ruleElements: [
                        { schemaVersion: 1, id: "dodge-attacked", type: "RollMode", data: { domains: ["attacked"], mode: "disadvantage" } },
                        { schemaVersion: 1, id: "dodge-agility", type: "RollMode", data: { domains: ["save.agility"], mode: "advantage" } }
                    ] }] } },
    // 2024 Help, assisting an attack: "the first attack roll that the ally makes against the enemy" beside you has
    // Advantage, until the start of your next turn: only an ally of the helper's (`attack.helpedByAlly`), and its attack
    // ends it (`attackedByAllyOfSource`).
    help: { name: "WILDPATH.COMMON.Help", img: "icons/svg/upgrade.svg", definition: { costs: ACTION, ...TOUCH,
            effects: [{ id: "helped", type: "effect", name: "Distracted", slug: "distracted", img: "icons/svg/upgrade.svg",
                    duration: UNTIL_NEXT_TURN, endsWhen: "attackedByAllyOfSource",
                    ruleElements: [{ schemaVersion: 1, id: "help-attacked", type: "RollMode", predicate: { equals: { path: "attack.helpedByAlly", value: true } },
                            data: { domains: ["attacked"], mode: "advantage" } }] }] } },
    // 2024 Help, assisting an ability check: an ally near enough (30 feet) has Advantage on its next check with one of the
    // helper's skills, until the start of the helper's next turn (`endsWhen: "checks"`). Its skill is chosen when used.
    assist: { name: "WILDPATH.COMMON.Assist", img: "icons/svg/upgrade.svg", definition: { costs: ACTION,
            range: { type: "ranged", normal: { value: 30, unit: "ft" } }, targeting: { type: "single", required: true, count: 1 },
            effects: [assistedEffect("check.{{skill}}")] } },
    // 2024 Hide: only while Heavily Obscured or behind Three-Quarters or Total Cover from every foe (Q118 (b) default; the
    // place's `obscured` and `coverFromFoes`, foundry-v14-senses.mts placeContext). A feature's own place requirement
    // replaces it (Nature's Mantle: Lightly Obscured), as the converter writes it. "Make note of your check's total, which is
    // the DC for a creature to find you with a Wisdom (Perception) check": its Invisible keeps the total (`foundDC`, Q18.2).
    hide: { name: "WILDPATH.COMMON.Hide", img: "icons/svg/cowled.svg", definition: { costs: ACTION, ...SELF, requires: HIDDEN_PLACE,
            check: { ability: "agility", skill: "stealth", dc: { value: 15 } },
            effects: [{ id: "hidden", type: "condition", conditionId: "invisible", checkOutcomePolicy: "success", metadata: { foundDC: "check" } }] } },
    grapple: { name: "WILDPATH.COMMON.Grapple", img: "icons/svg/anchor.svg", definition: { costs: ACTION, ...strikeSave({ conditionId: "grappled" }) } },
    // 2024 Shove: on a failed save, the target is pushed 5 feet away or has the Prone condition; one action for each.
    shove: { name: "WILDPATH.COMMON.Shove", img: "icons/svg/falling.svg", definition: { costs: ACTION, ...strikeSave({ conditionId: "prone" }) } },
    push: { name: "WILDPATH.COMMON.Push", img: "icons/svg/thrust.svg", definition: { costs: ACTION, ...GRAB,
            save: STRIKE_SAVE, push: { distance: 5 } } },
    unarmed: { name: "WILDPATH.COMMON.UnarmedStrike", img: "icons/svg/combat.svg", definition: { costs: ACTION, ...TOUCH, tags: ["unarmed"],
            attack: { type: "melee", statistic: "weapon", defenseKey: "ac", proficient: true },
            damage: [{ id: "unarmed", expression: { type: "constant", value: 1 }, damageType: "bludgeoning", provenance: "weapon-base" }] } },
    // 2024 Search, Study and Influence: the Action, then a check of one of its skills, which the GM judges (no DC). A check of
    // a skill it `finds` with also finds hidden creatures whose `foundDC` it meets (foundry-v14-search.mts).
    search: { name: "WILDPATH.COMMON.Search", img: "icons/svg/eye.svg", definition: { costs: ACTION, ...SELF,
            metadata: { test: { skills: ["insight", "medicine", "perception", "survival"], finds: ["perception"] } } } },
    study: { name: "WILDPATH.COMMON.Study", img: "icons/svg/book.svg", definition: { costs: ACTION, ...SELF,
            metadata: { test: { skills: ["arcana", "history", "investigation", "nature", "religion"] } } } },
    influence: { name: "WILDPATH.COMMON.Influence", img: "icons/svg/sound.svg", definition: { costs: ACTION, ...SELF,
            metadata: { test: { skills: ["deception", "intimidation", "performance", "persuasion", "animal-handling"] } } } },
    // The creature's own escape (Athletics or Acrobatics). Offered only while it has a hold with an escape DC (commonAction).
    escape: { name: "WILDPATH.COMMON.Escape", img: "icons/svg/net.svg", definition: { ...ESCAPE, ...SELF } },
    // A hold whose text lets another creature free its creature (`escapeByOthers`): the same check, by one within reach.
    // shortcut: 5 ft, not a longer reach; upgrade when range reads the creature's reach.
    free: { name: "WILDPATH.COMMON.Free", img: "icons/svg/net.svg", definition: { ...ESCAPE, ...TOUCH } },
    // 2024 Utilize: using an object that takes an action (a lever, a door's lock); the card says it was used.
    utilize: { name: "WILDPATH.COMMON.Utilize", img: "icons/svg/lever.svg", definition: { costs: ACTION, ...SELF } }
};
export const COMMON_ACTION_IDS = Object.freeze([...Object.keys(COMMON), "opportunity"]);
/**
 * The creature's Opportunity Attack: its first melee attack Action, else its Unarmed Strike, costing its Reaction.
 * The weapon's own definition id is kept, so the weapon's own modifiers still count.
 */
function opportunityDefinition(actor) {
    const weapon = [...(actor.items ?? [])].find(item => (item.type === "action") && (item.system?.active !== false)
        && (definitionOf(item).definition?.attack?.type === "melee"));
    const definition = weapon ? definitionOf(weapon).definition : { schemaVersion: 1, id: "common:unarmed", ...structuredClone(COMMON.unarmed.definition) };
    // Tagged as one (Sentinel's Halt answers its hits).
    return { weapon: weapon?.name ?? null, definition: { ...definition, costs: { allOf: [{ capability: "reaction", amount: 1 }] },
            tags: [...new Set([...(definition.tags ?? []), "opportunity"])] } };
}
/** Which use gave a condition effect: the same Action's effects from the same source share it (a repeated save, an escape). */
export function effectGroupKey(effect) {
    const flag = effect.flags?.wildpath?.conditionEffect;
    return `${String(flag?.metadata?.actionDefinitionId ?? effect.id)}|${String(flag?.sourceRef ?? "")}`;
}
/**
 * What the creature can escape: each enabled effect with a finite escape DC (`metadata.escapeDC`) is a hold, a
 * condition (a Grappled, a Restrained, a Blinded) or a custom effect (a hold of its own, without a status). Of one
 * kind (a condition, else the effect itself) only the instance with the highest DC is escaped (one instance per source,
 * Q19 (a)), the higher DC first (a Grappled first among equals). Each has the skills it may roll (`metadata.escapeSkills`, Web's Athletics
 * only; else Athletics or Acrobatics), and with `metadata.escapeEndsAll` ("On a success, the spell ends": Ensnaring
 * Strike) the ids of the other effects the same Action gave it from the same source (effectGroupKey, as
 * repeatSaveGroups), which a success ends too; a custom hold, which no removal row can name, puts its own id first. With
 * `byOthers`, only a hold another creature may free it from (`metadata.escapeByOthers`: a Net's "the target or a
 * creature within 5 feet"). A hold `attempter` is barred from (a Forbid on `escape:<the hold's Action id>`: a lockout
 * after a failed try) is left out, unless the Action itself is barred, which the bar then shows as forbidden.
 */
function escapable(actor, { byOthers = false, attempter = actor, query = {} } = {}) {
    const effects = [...(actor.effects ?? [])].filter(effect => !effect.disabled);
    const forbids = (tags) => Boolean(attempter.forbiddingRule?.({ ...query, tags }));
    let whole; // asked only once a hold is found: the bar builds Escape and Free on every render
    const barred = (actionId) => Boolean(actionId) && !(whole ??= forbids([])) && forbids([`escape:${String(actionId)}`]);
    return effects.map(effect => ({ effect, metadata: effect.flags?.wildpath?.conditionEffect?.metadata ?? {},
        conditionId: effect.system?.type ?? "", dc: effect.flags?.wildpath?.conditionEffect?.metadata?.escapeDC }))
        // A number only: a hand-written null or "" (Number() makes 0) is no hold.
        .filter((entry) => (typeof entry.dc === "number") && Number.isFinite(entry.dc))
        .filter(entry => !byOthers || (entry.metadata.escapeByOthers === true))
        .filter(entry => !barred(entry.metadata.actionDefinitionId))
        .sort((a, b) => (b.dc - a.dc) || (((a.conditionId === "grappled") ? 0 : 1) - ((b.conditionId === "grappled") ? 0 : 1)))
        // Of one kind's holds only the highest DC's is escaped (Q19 (a)); the choice is across kinds (Q93 (a)).
        .filter((held, index, all) => all.findIndex(other => (other.conditionId || other.effect) === (held.conditionId || held.effect)) === index)
        .map(held => {
        const skills = (held.metadata.escapeSkills ?? []).filter(skill => typeof skill === "string");
        const group = (held.metadata.escapeEndsAll === true) ? effects.filter(effect => (effect !== held.effect)
            && (effectGroupKey(effect) === effectGroupKey(held.effect)) && effect.id).map(effect => effect.id) : [];
        return { effectId: held.effect.id ?? null, conditionId: held.conditionId, name: held.effect.name ?? "", dc: held.dc,
            skills: skills.length ? skills : ["athletics", "acrobatics"], actionId: held.metadata.actionDefinitionId ?? null,
            endsEffects: (!held.conditionId && held.effect.id) ? [held.effect.id, ...group] : group, adds: held.metadata.escapeAdds ?? {} };
    });
}
/** An Action ref naming a common action, `common:<id>`; its id, or null. */
export function commonActionId(ref) {
    const match = /^common:([a-z]+)$/.exec(String(ref ?? ""));
    return match && COMMON_ACTION_IDS.includes(match[1]) ? match[1] : null;
}
/**
 * The common action `id` as an Action Item of `actor`, built fresh: `{id, uuid: "common:<id>", type: "action",
 * name, img, system: {definition}, actor}`. `localize` turns its lang key into its name. Its reaction setting
 * (Always, Ask, Never) is the creature's own, `flags.wildpath.commonPolicies.<id>`. With `bonusShove`, Shove costs a
 * Bonus Action. Free needs `target`, the held creature it would free (its first target).
 */
export function commonAction(actor, id, { localize = (key) => key, bonusShove = false, target = null } = {}) {
    const creature = (actor ?? {});
    const flags = { wildpath: { reactionPolicy: creature.flags?.wildpath?.commonPolicies?.[id] } };
    if (id === "opportunity") {
        const { weapon, definition } = opportunityDefinition(creature);
        const name = `${localize("WILDPATH.COMMON.OpportunityAttack")}${weapon ? ` (${weapon})` : ""}`;
        return { id: "common-opportunity", uuid: "common:opportunity", type: "action", name, img: "icons/svg/sword.svg", flags,
            activationCost: costOf(definition), system: { active: true, definition: { ...definition, label: name } }, actor };
    }
    const entry = COMMON[id];
    if (!entry)
        return null;
    // Free: another creature's hold that allows it (`target`, the creature it would free; never itself, which Escapes).
    const other = target;
    // The attempter (itself for Escape, the helper for Free) asks its Forbids about this Action and each hold.
    const query = { ...entry.definition, id: `common:${id}` };
    const holds = (id === "escape") ? escapable(creature, { query })
        : ((id === "free") && other && (other.uuid !== creature.uuid)) ? escapable(other, { byOthers: true, attempter: creature, query }) : [];
    if (["escape", "free"].includes(id) && !holds.length)
        return null;
    // Assist: one of its skill proficiencies, chosen when used; none, no Assist.
    const skills = (id === "assist") ? Object.entries(creature.system?.skills ?? {})
        .filter(([, skill]) => (Number(skill?.proficiency) || 0) > 0).map(([key]) => key) : [];
    if ((id === "assist") && !skills.length)
        return null;
    const name = localize(entry.name);
    const definition = { schemaVersion: 1, id: `common:${id}`, label: name, ...structuredClone(entry.definition),
        ...((bonusShove && SHOVES.has(id)) ? { costs: structuredClone(BONUS_ACTION) } : {}) };
    // What it applies came from its creature, as an Item's Action names its Actor: a Grapple's Grappled names its grappler.
    if (creature.uuid)
        definition.source = { type: "actor", ref: `uuid:${creature.uuid}`, uuid: creature.uuid };
    if (holds.length) {
        // Whichever of its skills is better for it (2024 lets it choose Athletics or Acrobatics), against that escape DC: one
        // whose total floor reaches the DC can't fail (Indomitable Might's Athletics), else the larger bonus.
        const escapeFrom = (held) => {
            const bonus = (skill) => {
                const statistic = resolveActorCheckStatistic(creature, { skill });
                return (Number(statistic?.totalMinimum) >= held.dc) ? Infinity : (statistic?.totalModifier ?? -Infinity);
            };
            // What it escapes, a condition (Powerful Build reads `grappled`), else null (a custom hold).
            return { skill: held.skills.reduce((best, skill) => (bonus(skill) > bonus(best) ? skill : best)), dc: { value: held.dc },
                escapes: held.conditionId || null, ...(held.endsEffects.length ? { endsEffects: held.endsEffects } : {}) };
        };
        // A success ends a condition hold alone, named by its effect id: another source's keeps holding it (Q19 (a)). A custom
        // hold has no row: its own id in `check.endsEffects` ends it.
        const removal = (held, id) => (held.conditionId ? [{ ...definition.effects[0], id,
                conditionId: held.conditionId, ...(held.effectId ? { metadata: { effectId: held.effectId } } : {}) }] : []);
        // What an attempt at a hold adds (`metadata.escapeAdds.<escape | free>`): effect rows (a failed try's lockout on its
        // `appliesTo: "source"`) and damage to the attempter (`sourceDamage`: a puller's acid). Each of several holds' rows
        // is prefixed by its option's id, so two holds never share a row id.
        const added = (held, prefix) => {
            const adds = held.adds[id];
            const rows = (Array.isArray(adds?.effects) ? adds.effects : []).map((row, index) => (prefix
                ? { ...structuredClone(row), id: `${prefix}:${String(row?.id ?? index)}` } : structuredClone(row)));
            return { rows, damage: Array.isArray(adds?.sourceDamage) ? structuredClone(adds.sourceDamage) : [] };
        };
        definition.check = escapeFrom(holds[0]);
        // The holds it may be used on, for Forbids and predicates (`escape:<the hold's Action id>`).
        const tags = [...new Set(holds.filter(held => held.actionId).map(held => `escape:${String(held.actionId)}`))];
        if (tags.length)
            definition.tags = tags;
        // Several holds: the player picks which, the highest DC preselected (Q93 (a) default). The required choice keeps that
        // hold's removal (keep-effect; none for a custom hold) and sets its check (set-check); the base check is the hardest's.
        if (holds.length > 1) {
            const ids = holds.map((_held, index) => `escaped-${index + 1}`);
            const holdName = (held) => (held.conditionId
                ? localize(WILDPATH.CONDITIONS?.[held.conditionId]?.name ?? held.conditionId)
                : held.name);
            // An added row is kept with its hold's removal (keep-effect's `keep`); its damage is the option's add-source-damage.
            const adds = holds.map((held, index) => added(held, ids[index]));
            const addedIds = adds.map(add => add.rows.map(row => String(row.id)));
            definition.effects = holds.flatMap((held, index) => [...removal(held, ids[index]), ...adds[index].rows]);
            const keep = addedIds.flat().length ? { keep: Object.fromEntries(ids.map((value, index) => [value, [value, ...addedIds[index]]])) } : {};
            definition.configuration = [{ id: "hold", type: "select-one", label: "WILDPATH.COMMON.EscapeHold", required: true,
                    defaultValue: ids[0], effects: [{ type: "keep-effect", effectIds: [...ids, ...addedIds.flat()], ...keep }],
                    options: holds.map((held, index) => ({ id: ids[index], value: ids[index], label: "WILDPATH.COMMON.EscapeHoldOption",
                        labelData: { condition: holdName(held), dc: held.dc }, effects: [{ type: "set-check", check: escapeFrom(held) },
                            ...(adds[index].damage.length ? [{ type: "add-source-damage", damage: adds[index].damage }] : [])] })) }];
        }
        else {
            const { rows, damage } = added(holds[0], null);
            definition.effects = [...removal(holds[0], "escaped"), ...rows];
            if (damage.length)
                definition.sourceDamage = damage;
        }
    }
    if (skills.length)
        definition.configuration = [{ id: "skill", type: "select-one", label: "WILDPATH.COMMON.AssistSkill", required: true,
                options: skills.map(skill => ({ id: skill, value: skill, label: localize(WILDPATH.SKILLS?.[skill]?.label
                        ?? skill) })), effects: [{ type: "bindChoice" }] }];
    // A grapple's escape DC is the grappler's own: 8 + Might modifier + Proficiency Bonus (2024), kept on its Grappled.
    if (id === "grapple") {
        const might = actorAbilityModifier(creature, "might");
        const proficiency = actorProficiencyBonus(creature);
        if (Number.isFinite(might) && Number.isFinite(proficiency)) {
            definition.effects[0].metadata = { escapeDC: 8 + Number(might) + Number(proficiency) };
        }
    }
    const action = { id: `common-${id}`, uuid: `common:${id}`, type: "action", name, img: entry.img, flags, activationCost: {},
        system: { active: true, definition }, actor };
    // What it costs, as the action bar reads it (an Item's data model would give `getActivationCost()`): as its creature
    // can pay it now (an Unarmed Strike from Extra Attack's pool).
    action.activationCost = costOf(definitionOf(action).definition ?? definition);
    return action;
}
