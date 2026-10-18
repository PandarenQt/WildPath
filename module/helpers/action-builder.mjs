/**
 * The Homebrew Builder's model of an ActionDefinition (homebrew-content-builder.md, second slice): the plain form
 * values the item sheet's Builder tab shows, and the writer that folds submitted values back into the stored
 * definition.
 *
 * Writing is an overlay. A field the user left unchanged writes nothing; a changed one is written over its stored
 * object, and rows are matched by their hidden id. So whatever the builder does not show survives, and
 * `builderToDefinition(definitionToBuilder(d), d)` gives back `d` unchanged.
 */
import { formatFormula, parseFormula } from "./formula.mjs";
import { validateActionDefinition } from "./action-definitions.mjs";
import { ruleGaps, rowsToRules, rulesToRows } from "./rule-builder.mjs";
const ROW_SECTIONS = ["costs", "restores", "damage", "healing", "effects"];
/** `{0: {...}, 1: {...}}` (a form's rows) or an array, as an array in index order. */
function rowsOf(value) {
    if (Array.isArray(value))
        return value;
    if (!value || (typeof value !== "object"))
        return [];
    return Object.keys(value).filter(key => /^\d+$/.test(key)).sort((a, b) => Number(a) - Number(b)).map(key => value[key]);
}
/** A form value as compared: "", null and undefined are all empty, and numeric text is its number. */
function loose(value) {
    if ((value === undefined) || (value === null) || (value === ""))
        return null;
    if ((typeof value === "string") && value.trim() && Number.isFinite(Number(value)))
        return Number(value);
    return value;
}
/** Whether a submitted value differs from the builder's own value; only fields the form sent are compared. */
function differs(submitted, model) {
    if (Array.isArray(model)) {
        const rows = rowsOf(submitted);
        return (rows.length !== model.length) || rows.some((row, index) => differs(row, model[index]));
    }
    if (submitted && (typeof submitted === "object")) {
        return Object.entries(submitted).some(([key, value]) => differs(value, model?.[key]));
    }
    return loose(submitted) !== loose(model);
}
const number = (value) => (loose(value) === null || !Number.isFinite(Number(value)) ? null : Number(value));
const clone = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
/** The DC as builder text: a number, a formula, or null when only Advanced can show it. */
function dcText(dc) {
    if (dc == null)
        return "";
    if (typeof dc === "number")
        return String(dc);
    const data = dc;
    if (Number.isFinite(Number(data.value ?? data.dc)) && ((data.value ?? data.dc) !== null))
        return String(Number(data.value ?? data.dc));
    return formatFormula(data.valueExpression ?? data.expression);
}
/** What a successful save does to the damage: "half", "none", "full", or "mixed" when the rows disagree. */
function saveSuccessDamage(damage) {
    const values = new Set(damage.map(component => {
        const policy = component.saveOutcomePolicy ?? component.savePolicy;
        if (!policy)
            return "full";
        return String(typeof policy === "object" ? (policy.success ?? policy.onSuccess ?? "full") : policy);
    }));
    return values.size > 1 ? "mixed" : ([...values][0] ?? "half");
}
/** A definition's costs as its ways to pay: each `anyOf` option, or `allOf` as the one way. */
function costGroups(costs) {
    if (Array.isArray(costs?.anyOf))
        return costs.anyOf.map((option) => [...(Array.isArray(option) ? option : [])]);
    return [[...(Array.isArray(costs?.allOf) ? costs.allOf : [])]];
}
/** Costs paying one of `groups`: `allOf` for a single way, `anyOf` for more; other stored keys are kept. */
function withCostGroups(costs, groups) {
    const { allOf: _allOf, anyOf: _anyOf, ...rest } = costs ?? {};
    const kept = groups.filter(group => group.length);
    return kept.length > 1 ? { ...rest, anyOf: kept } : { ...rest, allOf: kept[0] ?? [] };
}
/** Spell slot levels a resource choice offers, by `spell-slot.<level>` (Foundry may store the map nested). */
function slotLevels(map) {
    if (!map || (typeof map !== "object"))
        return [];
    const entries = Object.entries(map).flatMap(([key, value]) => (key === "spell-slot" && value && (typeof value === "object")
        ? Object.keys(value).map(level => `spell-slot.${level}`) : [key]));
    const levels = entries.map(key => /^spell-slot\.(\d)$/.exec(key)?.[1]).map(Number);
    return levels.every(level => level >= 1) ? levels : [];
}
/** The configuration choice that spends a spell slot, its levels and its damage scaling, when the Action has one. */
export function spellSlotChoice(configuration) {
    const list = Array.isArray(configuration) ? configuration : [];
    const index = list.findIndex(entry => (entry?.type === "resource") && slotLevels(entry.levelByResourceId).length);
    if (index < 0)
        return null;
    const entry = list[index];
    const scale = (entry.effects ?? []).find((effect) => ["scaleDamage", "scale-damage"].includes(effect?.type));
    return { index, entry, levels: slotLevels(entry.levelByResourceId), scale: scale ?? null };
}
const isFailureOnly = (policy) => ["failure", "failed", "fail"].includes(String(policy ?? "").toLowerCase());
/** The builder's form values for a stored definition, plus what the form needs to show (`readOnly`, counts). */
export function definitionToBuilder(definition, { abilities = null } = {}) {
    const d = definition ?? {};
    // Each way to pay is an option; rows of one option are paid together (Multiattack's attacks: its pool, or the Action).
    const groups = costGroups(d.costs);
    const simpleCosts = groups.flat().every(requirement => (typeof requirement?.capability === "string")
        && Object.keys(requirement).every(key => ["capability", "amount", "unit"].includes(key)));
    const range = d.range ?? null;
    const targeting = d.targeting ?? null;
    const area = d.area ?? null;
    const persistence = area?.persistence ?? null;
    const rolls = [d.attack && "attack", d.save && "save", d.check && "check"].filter(Boolean);
    const damage = Array.isArray(d.damage) ? d.damage : [];
    const dc = dcText(d.save?.dc ?? d.check?.dc);
    const slot = spellSlotChoice(d.configuration);
    const upcast = slot?.scale ? formatFormula({ type: "dice", number: slot.scale.dice?.number ?? 1, faces: slot.scale.dice?.faces }) : "";
    return {
        basics: { spell: (d.tags ?? []).includes("spell"), magical: (d.tags ?? []).includes("magical") },
        costs: simpleCosts ? groups.flatMap((group, option) => group.map(requirement => ({ capability: requirement.capability,
            amount: requirement.amount ?? 1, option: option + 1 }))) : [],
        costsReadOnly: !simpleCosts,
        costOptions: groups.length > 1,
        // Pools the Action refills when used (Multiattack refills its attacks' pools).
        restores: (Array.isArray(d.restores) ? d.restores : []).map((entry) => ({ resourceId: entry.resourceId ?? entry.resource ?? "",
            amount: entry.amount ?? 1 })),
        range: {
            type: range?.type ?? "",
            distance: (range?.type === "ranged" ? range?.normal?.value : range?.distance?.value) ?? null,
            long: range?.long?.value ?? null
        },
        targets: { type: targeting?.type ?? "", count: typeof targeting?.count === "number" ? targeting.count : null,
            // "Up to N": the user may choose fewer, down to this many.
            atLeast: targeting?.refinementPolicy?.minSelections ?? null },
        targetCountReadOnly: (targeting?.count != null) && (typeof targeting.count !== "number"),
        area: {
            shape: area?.shape ?? "",
            size: area?.size?.value ?? null,
            width: area?.width?.value ?? null,
            height: area?.height?.value ?? null,
            lasting: Boolean(persistence),
            rounds: persistence?.duration?.value ?? null,
            concentration: Boolean(persistence?.concentration)
        },
        areaTriggers: Array.isArray(persistence?.triggers) ? persistence.triggers.length : 0,
        roll: {
            kind: rolls.length > 1 ? "mixed" : (rolls[0] ?? "none"),
            attackType: d.attack?.type ?? "melee",
            statistic: d.attack?.statistic ?? "weapon",
            finesse: (d.attack?.properties ?? []).includes("finesse"),
            proficient: d.attack?.proficient === true,
            ability: d.attack?.ability ?? "",
            // A weapon attack's kind (Weapon Mastery needs its base weapon), and its mastery property.
            weaponCategory: d.attack?.weapon?.category ?? "",
            weaponBase: d.attack?.weapon?.base ?? "",
            mastery: d.attack?.weapon?.mastery ?? "",
            saveAbility: d.save?.ability ?? "",
            checkAbility: d.check?.ability ?? "",
            checkSkill: d.check?.skill ?? "",
            dc: dc ?? "",
            onSuccess: saveSuccessDamage(damage)
        },
        dcReadOnly: dc === null,
        // The creature it summons (by UUID), how many, for how long; one chosen when cast (`choiceId`) is Advanced only.
        summon: { creature: d.summon?.actorRef ?? "", count: d.summon?.count ?? 1, rounds: d.summon?.rounds ?? null,
            concentration: d.summon?.concentration === true },
        summonReadOnly: Boolean(d.summon?.choiceId),
        // Teleports its user up to this many feet (Misty Step).
        teleport: { distance: d.teleport?.distance ?? null },
        // Forced movement on a hit or a failed save (or, `onSuccess`, on a successful one); `toward` pulls.
        push: { distance: d.push?.distance ?? null, toward: d.push?.toward === true, maxSize: d.push?.maxSize ?? "",
            onSuccess: d.push?.on === "success" },
        slot: { level: slot ? Math.min(...slot.levels) : "", upcast: upcast ?? "" },
        upcastReadOnly: Boolean(slot?.scale) && ((upcast === null) || !slot.scale.dice),
        damage: damage.map(component => {
            const formula = formatFormula(component.expression);
            return { id: component.id ?? "", formula: formula ?? "", formulaReadOnly: formula === null,
                damageType: component.damageType ?? "", provenance: component.provenance ?? "" };
        }),
        healing: (Array.isArray(d.healing) ? d.healing : []).map((component) => {
            const formula = formatFormula(component.expression);
            return { id: component.id ?? "", formula: formula ?? "", formulaReadOnly: formula === null };
        }),
        effects: (Array.isArray(d.effects) ? d.effects : []).map((effect) => ({
            id: effect.id ?? "",
            kind: effect.type === "effect" ? "effect" : (effect.type === "condition" || effect.conditionId ? "condition" : String(effect.type ?? "")),
            conditionId: effect.conditionId ?? "",
            levels: effect.levels ?? 1,
            concentration: effect.concentration === true,
            onFailedSave: isFailureOnly(effect.saveOutcomePolicy),
            policyReadOnly: (effect.saveOutcomePolicy != null) && !isFailureOnly(effect.saveOutcomePolicy),
            name: effect.name ?? "",
            durationValue: effect.duration?.value ?? null,
            durationUnits: effect.duration?.units ?? "",
            expiry: effect.duration?.expiry ?? "",
            // A custom effect's own rules, as rule rows (rule-builder.mts).
            rules: rulesToRows(effect.ruleElements, { abilities })
        }))
    };
}
/**
 * Fold submitted builder values (`wildpath.builder.*`, expanded) into `stored`. Returns the new definition, or the
 * stored one unchanged when nothing changed; `errors` name the fields whose text could not be read (nothing else is
 * written then, so the sheet keeps the draft).
 */
export function builderToDefinition(submitted, stored, options = {}) {
    const model = definitionToBuilder(stored, options);
    const values = submitted ?? {};
    const sections = Object.keys(WRITERS).filter(section => (values[section] !== undefined)
        && differs(values[section], model[section]));
    if (!sections.length)
        return { changed: false, definition: stored, errors: [] };
    const next = clone(stored);
    const errors = [];
    for (const section of sections) {
        const writer = WRITERS[section];
        writer({ next, submitted: values[section], model: model[section], view: model, options, errors });
    }
    if (errors.length)
        return { changed: false, definition: stored, errors };
    if (!next.id && options.fallbackId)
        next.id = options.fallbackId;
    return { changed: true, definition: next, errors };
}
/** Field accessors over a submitted section: its value (or the model's), and whether the user changed it. */
function fields(submitted, model) {
    return {
        value: (field) => (submitted?.[field] !== undefined ? submitted[field] : model?.[field]),
        changed: (field) => (submitted?.[field] !== undefined) && differs(submitted[field], model?.[field])
    };
}
/** Read a formula field; a mistake is recorded against `field` and gives undefined. */
function readFormula(text, field, errors, options) {
    const result = parseFormula(String(text ?? ""), options);
    if (result.ok)
        return result.expression;
    errors.push({ field, key: result.key, data: result.data });
    return undefined;
}
const WRITERS = {
    basics({ next, submitted, model }) {
        const { value } = fields(submitted, model);
        const tags = (next.tags ?? []).filter((tag) => !["spell", "magical"].includes(tag));
        next.tags = [...tags, ...["spell", "magical"].filter(tag => value(tag))];
    },
    costs({ next, submitted, view }) {
        if (view.costsReadOnly)
            return;
        const stored = costGroups(next.costs).flat();
        const rows = rowsOf(submitted).map((row, index) => {
            const base = { ...(stored[index] ?? {}) };
            base.capability = String(row.capability ?? base.capability ?? "action").trim() || "action";
            base.amount = number(row.amount) ?? base.amount ?? 1;
            return { option: Math.max(1, Math.trunc(number(row.option) ?? 1)), base };
        });
        const options = [...new Set(rows.map(row => row.option))].sort((a, b) => a - b);
        next.costs = withCostGroups(next.costs, options.map(option => rows.filter(row => row.option === option).map(row => row.base)));
    },
    summon({ next, submitted, model, view }) {
        if (view.summonReadOnly)
            return;
        const { value } = fields(submitted, model);
        const creature = String(value("creature") ?? "").trim();
        if (!creature) {
            next.summon = null;
            return;
        }
        const summon = { ...(next.summon ?? {}), actorRef: creature,
            count: Math.min(20, Math.max(1, Math.trunc(number(value("count")) ?? 1))) };
        const rounds = Math.trunc(number(value("rounds")) ?? 0);
        if (rounds > 0)
            summon.rounds = rounds;
        else
            delete summon.rounds;
        if (value("concentration"))
            summon.concentration = true;
        else
            delete summon.concentration;
        next.summon = summon;
    },
    teleport({ next, submitted, model }) {
        const distance = number(fields(submitted, model).value("distance"));
        next.teleport = distance && (distance > 0) ? { ...(next.teleport ?? {}), distance } : null;
    },
    push({ next, submitted, model }) {
        const { value } = fields(submitted, model);
        const distance = number(value("distance"));
        if (!distance) {
            next.push = null;
            return;
        }
        const push = { ...(next.push ?? {}), distance };
        if (value("toward"))
            push.toward = true;
        else
            delete push.toward;
        if (value("maxSize"))
            push.maxSize = String(value("maxSize"));
        else
            delete push.maxSize;
        if (value("onSuccess"))
            push.on = "success";
        else
            delete push.on;
        next.push = push;
    },
    restores({ next, submitted }) {
        const stored = next.restores ?? [];
        next.restores = rowsOf(submitted).map((row, index) => ({ ...(stored[index] ?? {}),
            resourceId: String(row.resourceId ?? stored[index]?.resourceId ?? "").trim(), amount: Math.max(1, Math.trunc(number(row.amount) ?? 1)) }));
    },
    range({ next, submitted, model }) {
        const { value } = fields(submitted, model);
        const type = String(value("type") ?? "");
        if (!type) {
            next.range = null;
            return;
        }
        const range = { ...(next.range ?? {}), type };
        const distance = number(value("distance"));
        delete range.distance;
        delete range.normal;
        delete range.long;
        if (["touch", "reach"].includes(type))
            range.distance = { ...(next.range?.distance ?? {}), value: distance ?? 5, unit: "ft" };
        else if (type === "ranged") {
            range.normal = { ...(next.range?.normal ?? {}), value: distance ?? 60, unit: "ft" };
            const long = number(value("long"));
            if (long)
                range.long = { ...(next.range?.long ?? {}), value: long, unit: "ft" };
        }
        next.range = range;
    },
    targets({ next, submitted, model }) {
        const { value, changed } = fields(submitted, model);
        const type = String(value("type") ?? "");
        if (!type) {
            next.targeting = null;
            return;
        }
        const targeting = { ...(next.targeting ?? {}), type };
        if (type === "single")
            Object.assign(targeting, { required: true, count: 1 });
        else if (type === "multiple") {
            targeting.required = true;
            if (changed("count") || (targeting.count == null))
                targeting.count = number(value("count")) ?? 2;
            if (changed("atLeast")) {
                const least = Math.trunc(number(value("atLeast")) ?? 0);
                if (least >= 1)
                    targeting.refinementPolicy = { ...(targeting.refinementPolicy ?? {}), minSelections: least };
                else
                    delete targeting.refinementPolicy;
            }
        }
        else {
            delete targeting.required;
            delete targeting.count;
        }
        next.targeting = targeting;
        // Area targeting needs an area; an Action that stops targeting one keeps its area (and any lasting triggers).
        if ((type === "area") && !next.area)
            next.area = { shape: "radial", size: { value: 10, unit: "ft" } };
    },
    area({ next, submitted, model }) {
        const { value } = fields(submitted, model);
        const area = { ...(next.area ?? {}) };
        area.shape = String(value("shape") || "radial");
        area.size = { ...(area.size ?? {}), value: number(value("size")) ?? 10, unit: area.size?.unit ?? "ft" };
        if (area.shape === "line")
            area.width = { ...(area.width ?? {}), value: number(value("width")) ?? 5, unit: area.width?.unit ?? "ft" };
        else
            delete area.width;
        // A cylinder's or a wall's height (negative: it reaches down).
        const height = number(value("height"));
        if (height === null)
            delete area.height;
        else
            area.height = { ...(area.height ?? {}), value: height, unit: area.height?.unit ?? "ft" };
        if (value("lasting")) {
            area.persistence = { oncePerTurn: true, triggers: [], ...(area.persistence ?? {}),
                duration: { ...(area.persistence?.duration ?? {}), unit: "round", value: Math.max(1, Math.trunc(number(value("rounds")) ?? 10)) },
                concentration: Boolean(value("concentration")) };
        }
        else
            delete area.persistence;
        next.area = area;
    },
    roll({ next, submitted, model, options, errors }) {
        const { value, changed } = fields(submitted, model);
        const kind = String(value("kind") ?? "none");
        if ((kind === "mixed") || (model.kind === "mixed"))
            return;
        const kindChanged = changed("kind");
        const set = (field) => kindChanged || changed(field);
        const spell = (next.tags ?? []).includes("spell");
        for (const other of ["attack", "save", "check"])
            if (other !== kind)
                next[other] = null;
        if (kind === "attack") {
            // A new attack is one the creature is proficient with, as most are; the checkbox turns it off.
            const attack = (kindChanged || !next.attack) ? { type: "melee", statistic: spell ? "spell" : "weapon", defenseKey: "ac", proficient: true }
                : { ...next.attack };
            if (changed("proficient")) {
                if (value("proficient"))
                    attack.proficient = true;
                else
                    delete attack.proficient;
            }
            if (set("attackType"))
                attack.type = value("attackType") || "melee";
            if (changed("statistic"))
                attack.statistic = value("statistic") || "weapon";
            if (set("finesse")) {
                const properties = (attack.properties ?? []).filter((property) => property !== "finesse");
                if (value("finesse"))
                    properties.push("finesse");
                if (properties.length)
                    attack.properties = properties;
                else
                    delete attack.properties;
            }
            if (changed("ability")) {
                if (value("ability"))
                    attack.ability = value("ability");
                else
                    delete attack.ability;
            }
            if (["weaponCategory", "weaponBase", "mastery"].some(changed)) {
                const weapon = { ...(attack.weapon ?? {}) };
                for (const [field, key] of [["weaponCategory", "category"], ["weaponBase", "base"], ["mastery", "mastery"]]) {
                    const text = String(value(field) ?? "").trim().toLowerCase();
                    if (text)
                        weapon[key] = text;
                    else
                        delete weapon[key];
                }
                if (Object.keys(weapon).length)
                    attack.weapon = weapon;
                else
                    delete attack.weapon;
            }
            next.attack = attack;
            return;
        }
        if ((kind === "save") || (kind === "check")) {
            const roll = (kindChanged || !next[kind]) ? {} : { ...next[kind] };
            if (kind === "save") {
                if (set("saveAbility"))
                    roll.ability = value("saveAbility") || options.abilities?.[0] || "agility";
            }
            else {
                // Blank: the skill's own ability (a skill-only check keeps no ability).
                if (set("checkAbility")) {
                    if (value("checkAbility"))
                        roll.ability = String(value("checkAbility"));
                    else if (roll.skill || value("checkSkill"))
                        delete roll.ability;
                    else
                        roll.ability = options.abilities?.[0] || "might";
                }
                if (set("checkSkill")) {
                    if (value("checkSkill"))
                        roll.skill = String(value("checkSkill")).trim();
                    else
                        delete roll.skill;
                }
            }
            if (set("dc")) {
                // An empty DC becomes a valid default: a spell's save DC, or 13.
                const text = String(value("dc") ?? "").trim() || (spell ? "8 + prof + spellmod" : "13");
                const expression = readFormula(text, "roll.dc", errors, { dice: false, abilities: options.abilities ?? null });
                if (expression) {
                    const dc = { ...(roll.dc && typeof roll.dc === "object" ? roll.dc : {}) };
                    delete dc.value;
                    delete dc.dc;
                    delete dc.valueExpression;
                    delete dc.expression;
                    if (expression.type === "constant")
                        dc.value = expression.value;
                    else
                        dc.valueExpression = expression;
                    roll.dc = dc;
                }
            }
            next[kind] = roll;
            if ((kind === "save") && changed("onSuccess") && (value("onSuccess") !== "mixed")) {
                const success = String(value("onSuccess"));
                next.damage = (next.damage ?? []).map((component) => {
                    const { saveOutcomePolicy, savePolicy, ...rest } = component;
                    const policy = saveOutcomePolicy ?? savePolicy;
                    if (success === "full")
                        return rest;
                    return { ...rest, saveOutcomePolicy: { ...(policy && typeof policy === "object" ? policy : { failure: "full" }), success } };
                });
            }
        }
    },
    /** A spell slot of the chosen level or higher pays for it; each level above adds the upcast dice to the first damage row. */
    slot({ next, submitted, model, options, errors, view }) {
        const { value, changed } = fields(submitted, model);
        const level = Math.min(9, Math.max(0, Math.trunc(number(value("level")) ?? 0)));
        const configuration = [...(next.configuration ?? [])];
        const found = spellSlotChoice(configuration);
        if (!level) {
            if (found)
                configuration.splice(found.index, 1);
            next.configuration = configuration;
            return;
        }
        const id = found?.entry.id ?? "spell-slot";
        const entry = { ...(found?.entry ?? { id, type: "resource", label: "Spell slot", required: true }) };
        if (!found || changed("level")) {
            const levels = Array.from({ length: 10 - level }, (_, offset) => level + offset);
            entry.cost = { anyOf: levels.map(each => [{ capability: `spell-slot.${each}`, amount: 1 }]) };
            entry.levelByResourceId = Object.fromEntries(levels.map(each => [`spell-slot.${each}`, each]));
        }
        let scale = found?.scale ? { ...found.scale, baseLevel: level } : null;
        if (changed("upcast") && !view.upcastReadOnly) {
            const text = String(value("upcast") ?? "").trim();
            const expression = text ? readFormula(text, "slot.upcast", errors, { abilities: options.abilities ?? null }) : null;
            if (expression && (expression.type !== "dice"))
                errors.push({ field: "slot.upcast", key: "DiceOnly", data: {} });
            else if (!text)
                scale = null;
            else if (expression)
                scale = { ...(scale ?? { type: "scaleDamage", levelChoiceId: id, baseLevel: level }),
                    componentIds: [next.damage?.[0]?.id].filter(Boolean), dice: { number: expression.number, faces: expression.faces } };
        }
        const others = (entry.effects ?? []).filter((effect) => !["scaleDamage", "scale-damage"].includes(effect?.type));
        entry.effects = scale ? [...others, scale] : others;
        configuration[found ? found.index : configuration.length] = entry;
        next.configuration = configuration;
    },
    damage({ next, submitted, model, options, errors }) {
        const stored = new Map((next.damage ?? []).map((component) => [component.id, component]));
        next.damage = rowsOf(submitted).map((row, index) => {
            const modelRow = model.find(entry => entry.id === row.id) ?? null;
            const changed = (field) => (row[field] !== undefined) && (!modelRow || differs(row[field], modelRow[field]));
            const component = { ...(stored.get(row.id) ?? { id: row.id || `damage-${index + 1}` }) };
            if (changed("formula")) {
                const expression = readFormula(row.formula, `damage.${index}.formula`, errors, { abilities: options.abilities ?? null });
                if (expression)
                    component.expression = expression;
            }
            if (changed("damageType"))
                component.damageType = String(row.damageType || "untyped").trim().toLowerCase();
            if (changed("provenance"))
                component.provenance = row.provenance || "additional";
            return component;
        });
    },
    healing({ next, submitted, model, options, errors }) {
        const stored = new Map((next.healing ?? []).map((component) => [component.id, component]));
        next.healing = rowsOf(submitted).map((row, index) => {
            const modelRow = model.find(entry => entry.id === row.id) ?? null;
            const component = { ...(stored.get(row.id) ?? { id: row.id || `healing-${index + 1}`, healingType: "healing" }) };
            if ((row.formula !== undefined) && (!modelRow || differs(row.formula, modelRow.formula))) {
                const expression = readFormula(row.formula, `healing.${index}.formula`, errors, { abilities: options.abilities ?? null });
                if (expression)
                    component.expression = expression;
            }
            return component;
        });
    },
    effects({ next, submitted, model, options, errors }) {
        const stored = new Map((next.effects ?? []).map((effect) => [effect.id, effect]));
        next.effects = rowsOf(submitted).map((row, index) => {
            const modelRow = model.find(entry => entry.id === row.id) ?? null;
            const changed = (field) => (row[field] !== undefined) && (!modelRow || differs(row[field], modelRow[field]));
            const effect = { ...(stored.get(row.id) ?? { id: row.id || `effect-${index + 1}`, type: "condition" }) };
            if (changed("kind")) {
                if (row.kind === "effect") {
                    delete effect.conditionId;
                    delete effect.levels;
                    Object.assign(effect, { type: "effect", name: effect.name || row.name || "Effect", ruleElements: effect.ruleElements ?? [],
                        duration: effect.duration ?? { value: 1, units: "rounds" } });
                }
                else {
                    for (const key of ["name", "slug", "img", "ruleElements", "duration"])
                        delete effect[key];
                    Object.assign(effect, { type: "condition", conditionId: row.conditionId || options.conditions?.[0] || "prone" });
                }
            }
            if ((effect.type === "condition") && changed("conditionId") && row.conditionId)
                effect.conditionId = row.conditionId;
            if (changed("levels"))
                effect.levels = Math.max(1, Math.trunc(number(row.levels) ?? 1));
            if (changed("concentration")) {
                if (row.concentration)
                    effect.concentration = true;
                else
                    delete effect.concentration;
            }
            if (changed("onFailedSave")) {
                if (row.onFailedSave)
                    effect.saveOutcomePolicy = "failure";
                else
                    delete effect.saveOutcomePolicy;
            }
            if (effect.type === "effect") {
                if (changed("name"))
                    effect.name = String(row.name ?? "").trim() || "Effect";
                if (["durationValue", "durationUnits", "expiry"].some(changed)) {
                    const duration = { ...(effect.duration ?? {}) };
                    const assign = (key, field, read) => {
                        const value = read(row[field] !== undefined ? row[field] : modelRow?.[field]);
                        if (value === null || value === "")
                            delete duration[key];
                        else
                            duration[key] = value;
                    };
                    assign("value", "durationValue", number);
                    assign("units", "durationUnits", value => String(value ?? ""));
                    assign("expiry", "expiry", value => String(value ?? ""));
                    if (Object.keys(duration).length)
                        effect.duration = duration;
                    else
                        delete effect.duration;
                }
                if ((row.rules !== undefined) && !changed("kind")) {
                    const rules = rowsToRules(row.rules, effect.ruleElements ?? [], { field: `effects.${index}.rules`, abilities: options.abilities ?? null });
                    errors.push(...rules.errors);
                    if (rules.changed)
                        effect.ruleElements = rules.ruleElements;
                }
            }
            return effect;
        });
    }
};
/** A row id not yet used in `rows`: `<prefix>-<n>`. */
export function nextRowId(rows, prefix) {
    const used = new Set(rows.map(row => row?.id));
    let index = rows.length + 1;
    while (used.has(`${prefix}-${index}`))
        index += 1;
    return `${prefix}-${index}`;
}
/** The definition with one more row in `section`, filled with a valid default. */
export function addBuilderRow(definition, section, { conditions = null, alternative = false } = {}) {
    const next = clone(definition);
    const spell = (next.tags ?? []).includes("spell");
    if (section === "costs") {
        // A row of the last way to pay, or (`alternative`) a new way to pay.
        const groups = costGroups(next.costs);
        if (alternative && groups.at(-1)?.length)
            groups.push([]);
        groups.at(-1).push({ capability: "action", amount: 1 });
        next.costs = withCostGroups(next.costs, groups);
        return next;
    }
    if (section === "restores") {
        next.restores = [...(next.restores ?? []), { resourceId: "uses", amount: 1 }];
        return next;
    }
    const rows = next[section] ?? [];
    const id = nextRowId(rows, section === "effects" ? "effect" : section);
    if (section === "damage") {
        const first = rows[0];
        rows.push({ id, expression: { type: "dice", number: 1, faces: 6 }, damageType: first?.damageType ?? (spell ? "fire" : "slashing"),
            provenance: first ? "additional" : (spell ? "spell-base" : "weapon-base"),
            ...(first?.saveOutcomePolicy ? { saveOutcomePolicy: clone(first.saveOutcomePolicy) } : {}) });
    }
    else if (section === "healing")
        rows.push({ id, expression: { type: "dice", number: 1, faces: 8 }, healingType: "healing" });
    else
        rows.push({ id, type: "condition", conditionId: conditions?.[0] ?? "prone", ...(next.save ? { saveOutcomePolicy: "failure" } : {}) });
    next[section] = rows;
    return next;
}
/** The definition without row `index` of `section`. */
export function removeBuilderRow(definition, section, index) {
    const next = clone(definition);
    if (section === "costs") {
        // `index` counts rows across every way to pay, as the form lists them.
        const groups = costGroups(next.costs);
        let at = index;
        for (const group of groups) {
            if (at < group.length) {
                group.splice(at, 1);
                break;
            }
            at -= group.length;
        }
        next.costs = withCostGroups(next.costs, groups);
    }
    else if (Array.isArray(next[section]))
        next[section].splice(index, 1);
    return next;
}
const SECTION_OF_PATH = { costs: "costs", restores: "restores", range: "range", targeting: "targets", area: "area", attack: "roll",
    save: "roll", check: "roll", damage: "damage", healing: "healing", effects: "effects" };
/**
 * What is wrong with a definition, by builder section: the engine validator's errors, and warnings for things that
 * are valid but probably not meant (it deals damage but has no targets).
 */
export function builderIssues(definition) {
    const validation = validateActionDefinition(definition);
    const issues = (validation.errors ?? []).map(error => ({ level: "error", section: SECTION_OF_PATH[error.path.split(".")[0] ?? ""]
            ?? "advanced", path: error.path, text: error.reason }));
    const outcomes = (definition.damage?.length ?? 0) + (definition.healing?.length ?? 0) + (definition.effects?.length ?? 0);
    if (outcomes && !definition.targeting)
        issues.push({ level: "warning", section: "targets", key: "NoTargets" });
    if ((definition.attack || definition.save) && !definition.damage?.length && !definition.effects?.length) {
        issues.push({ level: "warning", section: "roll", key: "NothingHappens" });
    }
    if (["single", "multiple"].includes(definition.targeting?.type) && !definition.range)
        issues.push({ level: "warning", section: "range", key: "NoRange" });
    return issues;
}
export { ROW_SECTIONS };
/** The area shapes the Builder offers. */
export const AREA_SHAPES = Object.freeze(["radial", "emanation", "cone", "line", "cube", "wall"]);
const gapIf = (gap) => (gap ? [""] : []);
const distance = { value: true, unit: true };
const formulaSpec = (value) => gapIf(formatFormula(value) === null);
const dcSpec = (dc) => gapIf(dcText(dc) === null);
const GAP_SPEC = {
    schemaVersion: true, id: true, label: true, slug: true, description: true, img: true, metadata: true, policies: true,
    category: (category) => gapIf(category !== "action"),
    // Only "spell" and "magical" have a checkbox.
    tags: (tags) => (Array.isArray(tags) ? tags : []).filter(tag => !["spell", "magical"].includes(String(tag))).map(tag => `.${tag}`),
    costs: { allOf: [{ capability: true, amount: true, unit: true }], anyOf: [[{ capability: true, amount: true, unit: true }]] },
    restores: [{ resourceId: true, resource: true, amount: true }],
    range: { type: true, distance, normal: distance, long: distance },
    targeting: { type: true, required: true, count: (count) => gapIf(typeof count !== "number"), refinementPolicy: { minSelections: true } },
    push: { distance: true, toward: true, maxSize: true, on: (on) => gapIf(!["failure", "success"].includes(String(on))) },
    teleport: { distance: true },
    // `spellLevel` is the cast level its bonuses read when no slot is chosen.
    summon: { actorRef: true, count: (count) => gapIf(!Number.isInteger(count)), rounds: true, concentration: true, spellLevel: true },
    area: { shape: (shape) => gapIf(!AREA_SHAPES.includes(shape)), size: distance, width: distance, height: distance,
        persistence: { oncePerTurn: true, duration: { value: true, unit: true }, concentration: true,
            triggers: (triggers) => gapIf(Array.isArray(triggers) && (triggers.length > 0)) } },
    attack: { type: true, statistic: true, defenseKey: true, proficient: true, ability: true, weapon: { category: true, base: true, mastery: true },
        properties: (properties) => gapIf((properties ?? []).some(property => property !== "finesse")) },
    save: { ability: true, dc: dcSpec },
    check: { ability: true, skill: true, dc: dcSpec },
    damage: [{ id: true, expression: formulaSpec, damageType: true, provenance: true, saveOutcomePolicy: true }],
    healing: [{ id: true, expression: formulaSpec, healingType: true }],
    effects: [{ id: true, type: (type) => gapIf(!["condition", "effect"].includes(type)), conditionId: true, levels: true, concentration: true,
            saveOutcomePolicy: (policy) => gapIf(!isFailureOnly(policy)), name: true, slug: true, img: true,
            duration: { value: true, units: true, expiry: true },
            ruleElements: (rules, { abilities }) => ruleGaps(rules, { abilities: abilities ?? null }).map(gap => `.${gap}`) }],
    // The spell slot choice is checked whole, below.
    configuration: true
};
function specGaps(value, spec, path, gaps, options) {
    if ((value == null) || (spec === true))
        return;
    if (typeof spec === "function") {
        for (const gap of spec(value, options))
            gaps.add(`${path}${gap}`);
        return;
    }
    if (Array.isArray(spec)) {
        for (const entry of (Array.isArray(value) ? value : []))
            specGaps(entry, spec[0], path, gaps, options);
        return;
    }
    if (typeof value !== "object") {
        gaps.add(path);
        return;
    }
    for (const [key, entry] of Object.entries(value)) {
        const child = path ? `${path}.${key}` : key;
        // Nothing stored (null, false, "", an empty list or object: the data model's defaults) is nothing to rebuild.
        if ((entry == null) || (entry === false) || (entry === "") || ((typeof entry === "object") && !Object.keys(entry).length))
            continue;
        if (!(key in spec))
            gaps.add(child);
        else
            specGaps(entry, spec[key], child, gaps, options);
    }
}
/**
 * What of a stored definition the Builder (and its rule rows) cannot show or edit, as dotted part names
 * ("costs.anyOf", "attack.weapon", "effects.ruleElements.ArmorClass"). Empty when a homebrewer could rebuild the
 * whole Action in the Builder; the homebrew census (scripts/content/homebrew-census.mjs) counts these.
 */
export function builderGaps(definition, options = {}) {
    const d = definition ?? {};
    const gaps = new Set();
    specGaps(d, GAP_SPEC, "", gaps, options);
    const damage = Array.isArray(d.damage) ? d.damage : [];
    if (d.save && (saveSuccessDamage(damage) === "mixed"))
        gaps.add("damage.saveOutcomePolicy");
    const slot = spellSlotChoice(d.configuration);
    if ((d.configuration?.length ?? 0) > (slot ? 1 : 0))
        gaps.add("configuration");
    if (slot) {
        for (const effect of (slot.entry.effects ?? []))
            if (effect !== slot.scale)
                gaps.add(`configuration.${effect?.type}`);
        const scale = slot.scale;
        const first = [damage[0]?.id].filter(Boolean).join();
        if (scale && (!scale.dice || (scale.perLevel != null) || ((scale.componentIds ?? []).join() !== first)))
            gaps.add("configuration.upcast");
    }
    return [...gaps].sort();
}
const ACTION = { allOf: [{ capability: "action", amount: 1 }] };
const SPELL_DC = { valueExpression: { type: "add", terms: [{ type: "constant", value: 8 }, { type: "proficiency-bonus" }, { type: "spellcasting-modifier" }] } };
const dice = (count, faces) => ({ type: "dice", number: count, faces });
/** Starting points for a new Action; applying one replaces everything but the Action's identity. */
export const ACTION_TEMPLATES = {
    melee: { costs: ACTION, targeting: { type: "single", required: true, count: 1 }, range: { type: "reach", distance: { value: 5, unit: "ft" } },
        attack: { type: "melee", statistic: "weapon", defenseKey: "ac", proficient: true },
        damage: [{ id: "damage-1", expression: dice(1, 8), damageType: "slashing", provenance: "weapon-base" }] },
    ranged: { costs: ACTION, targeting: { type: "single", required: true, count: 1 },
        range: { type: "ranged", normal: { value: 80, unit: "ft" }, long: { value: 320, unit: "ft" } },
        attack: { type: "ranged", statistic: "weapon", defenseKey: "ac", proficient: true },
        damage: [{ id: "damage-1", expression: dice(1, 6), damageType: "piercing", provenance: "weapon-base" }] },
    spellAttack: { tags: ["spell"], costs: ACTION, targeting: { type: "single", required: true, count: 1 },
        range: { type: "ranged", normal: { value: 120, unit: "ft" } }, attack: { type: "ranged", statistic: "spell", defenseKey: "ac", proficient: true },
        damage: [{ id: "damage-1", expression: dice(1, 10), damageType: "fire", provenance: "spell-base" }] },
    save: { tags: ["spell"], costs: ACTION, targeting: { type: "single", required: true, count: 1 },
        range: { type: "ranged", normal: { value: 60, unit: "ft" } }, save: { ability: "fortitude", dc: SPELL_DC },
        damage: [{ id: "damage-1", expression: dice(2, 6), damageType: "poison", provenance: "spell-base",
                saveOutcomePolicy: { success: "half", failure: "full" } }] },
    areaSave: { tags: ["spell"], costs: ACTION, targeting: { type: "area" }, range: { type: "ranged", normal: { value: 150, unit: "ft" } },
        area: { shape: "radial", size: { value: 20, unit: "ft" } }, save: { ability: "agility", dc: SPELL_DC },
        damage: [{ id: "damage-1", expression: dice(8, 6), damageType: "fire", provenance: "spell-base",
                saveOutcomePolicy: { success: "half", failure: "full" } }] },
    healing: { tags: ["spell"], costs: ACTION, targeting: { type: "single", required: true, count: 1 },
        range: { type: "touch", distance: { value: 5, unit: "ft" } },
        healing: [{ id: "healing-1", expression: { type: "add", terms: [dice(2, 8), { type: "spellcasting-modifier" }] }, healingType: "healing" }] },
    buff: { tags: ["spell"], costs: ACTION, targeting: { type: "multiple", required: true, count: 3 }, range: { type: "ranged", normal: { value: 30, unit: "ft" } },
        effects: [{ id: "effect-1", type: "effect", name: "Inspired", duration: { value: 10, units: "rounds" },
                ruleElements: [{ schemaVersion: 1, id: "rule-1", type: "Modifier", data: { domains: ["attack"], value: 1, modifierType: "status" } },
                    { schemaVersion: 1, id: "rule-2", type: "Modifier", data: { domains: ["save"], value: 1, modifierType: "status" } }] }] },
    debuff: { tags: ["spell"], costs: ACTION, targeting: { type: "single", required: true, count: 1 }, range: { type: "ranged", normal: { value: 60, unit: "ft" } },
        save: { ability: "wits", dc: SPELL_DC },
        effects: [{ id: "effect-1", type: "effect", name: "Hexed", saveOutcomePolicy: "failure", duration: { value: 10, units: "rounds" },
                ruleElements: [{ schemaVersion: 1, id: "rule-1", type: "RollMode", data: { domains: ["attack"], mode: "disadvantage" } }] }] },
    aura: { tags: ["spell"], costs: ACTION, targeting: { type: "self" }, range: { type: "self" },
        effects: [{ id: "effect-1", type: "effect", name: "Warding Aura", duration: { value: 10, units: "rounds" },
                ruleElements: [{ schemaVersion: 1, id: "rule-1", type: "Aura", data: { radius: 10, affects: "allies",
                            ruleElements: [{ schemaVersion: 1, id: "rule-1-1", type: "Modifier", data: { domains: ["defense.ac"], value: 1, modifierType: "untyped" } }] } }] }] },
    reaction: { tags: ["spell"], costs: { allOf: [{ capability: "reaction", amount: 1 }] }, targeting: { type: "self" }, range: { type: "self" },
        effects: [{ id: "effect-1", type: "effect", name: "Shield", duration: { value: 1, units: "rounds", expiry: "turnStart" },
                ruleElements: [{ schemaVersion: 1, id: "rule-1", type: "Modifier", data: { domains: ["defense.ac"], value: 5, modifierType: "untyped" } }] }] },
    legendary: { costs: { allOf: [{ capability: "legendary-action", amount: 1 }] }, targeting: { type: "single", required: true, count: 1 },
        range: { type: "reach", distance: { value: 10, unit: "ft" } }, attack: { type: "melee", statistic: "weapon", defenseKey: "ac", proficient: true },
        damage: [{ id: "damage-1", expression: dice(2, 8), damageType: "bludgeoning", provenance: "weapon-base" }] },
    custom: { costs: ACTION }
};
/** A fresh definition from template `key`, keeping the stored definition's id and label. */
export function applyActionTemplate(stored, key, { fallbackId = null } = {}) {
    const template = ACTION_TEMPLATES[key];
    if (!template)
        return null;
    return { schemaVersion: 1, id: stored?.id || fallbackId || "", label: stored?.label ?? "", ...clone(template) };
}
