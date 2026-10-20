/**
 * The level-up dialog (G8, BG3-style): one form for what a class level (with its subclass's), a species or a
 * background asks; what it grants is added without asking. The rules are helpers/level-up.mts.
 */
import { hitPointsForLevel, improvementUpdates, levelSteps, multiclassShortfalls, poolOptions } from "../helpers/level-up.mjs";
import { hitDiePoolId } from "../helpers/spellcasting.mjs";
import { actorAbilityModifier } from "../helpers/combat-statistics.mjs";
import { classRecordsFromItems } from "../documents/actor.mjs";
const globals = () => globalThis;
const localize = (key) => globals().game.i18n.localize(key);
const format = (key, data) => globals().game.i18n.format(key, data);
const escape = (text) => globals().foundry.utils.escapeHTML(String(text ?? ""));
/** A size's Token footprint in grid spaces. */
const TOKEN_SIZES = { tiny: 0.5, small: 1, medium: 1, large: 2, huge: 3, gargantuan: 4 };
/** The feats an Ability Score Improvement may be instead (2024): Epic Boons from level 19. */
const FEATS = ["origin", "general"];
/** The 2024 label of a trait key: a skill, a save, or training ("Weapons: Martial"; within a choice, "Martial"). */
function traitLabel(key, { kindless = false } = {}) {
    const { ABILITIES, SKILLS } = globals().CONFIG.WILDPATH;
    const [kind = "", ...rest] = key.split(":");
    const value = rest.join(":");
    if (kind === "skills")
        return localize(SKILLS[value]?.label ?? value);
    if (kind === "saves")
        return format("WILDPATH.LEVELUP.Save", { ability: localize(ABILITIES[value]?.label ?? value) });
    if (kind === "languages") {
        const language = localize(`WILDPATH.LANGUAGES.${value}`);
        return kindless ? language : `${localize("WILDPATH.SHEET.Training.languages")}: ${language}`;
    }
    const name = value.split(/[-:]/u).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
    return kindless ? name : `${localize(`WILDPATH.SHEET.Training.${kind}`)}: ${name}`;
}
/** Whether a creature already has a trait, so a choice does not offer it again. */
function hasTrait(key, system) {
    const [kind = "", ...rest] = key.split(":");
    const value = rest.join(":");
    if (kind === "skills")
        return (system.skills?.[value]?.proficiency ?? 0) > 0;
    // Expertise is for a skill not yet expert; one not yet proficient waits for this dialog's pick (watchForm).
    if (kind === "expertise")
        return (system.skills?.[value]?.proficiency ?? 0) >= 2;
    if (kind === "saves")
        return system.abilities?.[value]?.saveProficient === true;
    return (system.training?.[kind] ?? []).includes(value);
}
const checkbox = (name, value, label, checked = false, needs = "") => `<label class="level-up-option"><input type="checkbox" name="${name}" value="${escape(value)}"${checked ? " checked" : ""}${needs ? ` data-needs="${escape(needs)}"` : ""}> ${escape(label)}</label>`;
const nameOf = (uuid) => globals().fromUuidSync(uuid)?.name ?? uuid;
/** One step's form section, or "" when it neither gives nor asks anything. */
function stepHtml(step, index, actor, view) {
    const { entry } = step;
    const name = `s${index}`;
    const legend = `<legend>${escape(step.title ?? localize(`WILDPATH.LEVELUP.Step.${step.kind}`))}</legend>`;
    switch (step.kind) {
        case "grant": {
            const items = entry.items ?? [];
            if (!items.length)
                return "";
            return `<fieldset>${legend}${items.map(uuid => (entry.optional ? checkbox(name, uuid, nameOf(uuid), true)
                : `<div class="level-up-option">${escape(nameOf(uuid))}</div>`)).join("")}</fieldset>`;
        }
        case "choice": {
            const items = entry.items ?? [];
            if (!items.length || !entry.count)
                return "";
            return `<fieldset data-count="${entry.count}">${legend}<p class="hint">${format("WILDPATH.LEVELUP.Choose", { count: entry.count })}</p>
        ${items.map(uuid => checkbox(name, uuid, nameOf(uuid))).join("")}</fieldset>`;
        }
        case "trait": {
            const skills = Object.keys(globals().CONFIG.WILDPATH.SKILLS);
            const grants = (entry.grants ?? []).map(key => `<div class="level-up-option" data-key="${escape(key)}">${escape(traitLabel(key))}</div>`).join("");
            const choices = (entry.choices ?? []).map((choice, at) => {
                // Not what it already has, nor what this step grants (the Acolyte's Common).
                const options = poolOptions(choice.pool, { skills }).filter(key => !hasTrait(key, actor.system) && !(entry.grants ?? []).includes(key));
                if (!options.length)
                    return "";
                return `<div data-count="${choice.count}"><p class="hint">${format("WILDPATH.LEVELUP.Choose", { count: choice.count })}</p>
          ${options.map(key => checkbox(`${name}.${at}`, key, traitLabel(key, { kindless: true }), false, (key.startsWith("expertise:")
                    && !((actor.system.skills?.[key.slice(10)]?.proficiency ?? 0) > 0)) ? `skills:${key.slice(10)}` : "")).join("")}</div>`;
            }).join("");
            return (grants || choices) ? `<fieldset>${legend}${grants}${choices}</fieldset>` : "";
        }
        case "improvement": {
            const { ABILITIES } = globals().CONFIG.WILDPATH;
            const inputs = (entry.abilities ?? []).map(ability => `<label class="level-up-ability">${escape(localize(ABILITIES[ability]?.label ?? ability))}
        <span>${actor.system.abilities?.[ability]?.value ?? 10}</span> +
        <input type="number" name="${name}.${ability}" value="0" min="0" max="${entry.cap ?? 2}" step="1"></label>`).join("");
            const feats = entry.feat ? `<label>${localize("WILDPATH.LEVELUP.Feat")} <select name="${name}.feat"><option value="">${localize("WILDPATH.LEVELUP.NoFeat")}</option>${view.feats.map(feat => `<option value="${escape(feat.uuid)}">${escape(feat.name)}</option>`).join("")}</select></label>` : "";
            return `<fieldset data-points="${entry.points ?? 0}">${legend}<p class="hint">${format("WILDPATH.LEVELUP.Increase", { points: entry.points ?? 0, cap: entry.cap ?? 2 })}</p><div class="level-up-abilities">${inputs}</div>${feats}</fieldset>`;
        }
        case "subclass": return `<fieldset>${legend}<select name="${name}" required><option value=""></option>${view.subclasses.map(entry => `<option value="${escape(entry.uuid)}">${escape(entry.name)}</option>`).join("")}</select></fieldset>`;
        case "size": {
            const sizes = entry.sizes ?? [];
            if (sizes.length < 2)
                return "";
            return `<fieldset>${legend}<select name="${name}">${sizes.map(size => `<option value="${size}"${size === "medium" ? " selected" : ""}>${escape(localize(`WILDPATH.SIZES.${size}`))}</option>`).join("")}</select></fieldset>`;
        }
        default: return "";
    }
}
/**
 * A count is met exactly, points are spent exactly (or a feat is taken), a required select is set: then OK. An option
 * that needs a trait (Expertise in a skill not yet proficient) waits until this dialog grants or picks it.
 */
function watchForm(form, ok) {
    const check = () => {
        let valid = true;
        const given = new Set([...form.querySelectorAll("[data-key]")].map(element => element.dataset.key)
            .concat([...form.querySelectorAll("input[type=checkbox]:checked:not([data-needs])")].map(box => box.value)));
        const blocked = (box) => !!box.dataset.needs && !given.has(box.dataset.needs);
        for (const group of form.querySelectorAll("[data-count]")) {
            const boxes = [...group.querySelectorAll(":scope > label > input[type=checkbox]")];
            for (const box of boxes)
                if (blocked(box))
                    box.checked = false;
            const wanted = Math.min(Number(group.dataset.count) || 0, boxes.filter(box => !blocked(box)).length);
            const checked = boxes.filter(box => box.checked).length;
            for (const box of boxes)
                box.disabled = blocked(box) || (!box.checked && (checked >= wanted));
            valid &&= checked === wanted;
        }
        for (const group of form.querySelectorAll("[data-points]")) {
            const feat = group.querySelector("select")?.value;
            const inputs = [...group.querySelectorAll("input[type=number]")];
            for (const input of inputs)
                input.disabled = !!feat;
            const spent = inputs.reduce((sum, input) => sum + (Number(input.value) || 0), 0);
            valid &&= !!feat || (spent === Number(group.dataset.points));
        }
        for (const select of form.querySelectorAll("select[required]"))
            valid &&= !!select.value;
        if (ok)
            ok.disabled = !valid;
    };
    form.addEventListener("change", check);
    form.addEventListener("input", check);
    check();
}
/** The feats and subclasses the compendiums offer. */
async function compendiumOptions(item, totalLevel) {
    const feats = new Map();
    const subclasses = new Map();
    const categories = totalLevel >= 19 ? [...FEATS, "epicBoon"] : FEATS;
    for (const pack of globals().game.packs) {
        if (pack.documentName !== "Item")
            continue;
        for (const entry of await pack.getIndex({ fields: ["flags.wildpath.source.feat", "system.classIdentifier"] })) {
            if (categories.includes(entry.flags?.wildpath?.source?.feat ?? "") && !feats.has(entry.name))
                feats.set(entry.name, entry);
            if ((entry.type === "subclass") && item.system.identifier && (entry.system?.classIdentifier === item.system.identifier)
                && !subclasses.has(entry.name))
                subclasses.set(entry.name, entry);
        }
    }
    const byName = (a, b) => a.name.localeCompare(b.name);
    return { feats: [...feats.values()].sort(byName), subclasses: [...subclasses.values()].sort(byName) };
}
/** Compendium Items onto the creature, as given by `item` (they go when it goes). */
async function addItems(actor, uuids, item) {
    const { foundry: { utils }, game } = globals();
    const documents = (await Promise.all(uuids.map(uuid => globals().fromUuid(uuid)))).filter(Boolean);
    if (!documents.length)
        return [];
    return actor.createEmbeddedDocuments("Item", documents.map(document => utils.mergeObject(game.items.fromCompendium(document), { "flags.wildpath.grantedBy": item.id })));
}
/**
 * Apply `level` of a class (with its subclass's steps), or a species or background (level 0), to a creature: ask what
 * it asks (`confirm`: also when it asks nothing), then add its features, skills, training, ability increases, hit
 * points and Hit Die. A class's `levels` becomes `level`. Returns whether it was applied.
 */
export async function levelUp(actor, item, { level, confirm = true }) {
    const { foundry: { applications: { api: { DialogV2 } } }, game } = globals();
    const classes = actor.items.filter(entry => entry.type === "class");
    const isClass = item.type === "class";
    const original = isClass ? (classRecordsFromItems(classes)[classes.indexOf(item)]?.original ?? true) : true;
    const subclasses = isClass ? actor.items.filter(entry => (entry.type === "subclass")
        && (entry.system.classIdentifier === item.system.identifier)) : [];
    const steps = [...levelSteps(item.system.advancement ?? [], level, { original }),
        ...subclasses.flatMap(subclass => levelSteps(subclass.system.advancement ?? [], level).map(step => ({ ...step, source: subclass })))];
    const otherLevels = classes.filter(entry => entry !== item).reduce((sum, entry) => sum + (Number(entry.system.levels) || 0), 0);
    const first = isClass && !otherLevels && (level === 1);
    const scores = Object.fromEntries(Object.entries(actor.system.abilities ?? {}).map(([key, ability]) => [key, Number(ability.value) || 10]));
    // A new class beside others: warn when either side's primary abilities fall short (2024), but do not block.
    if (isClass && otherLevels && (level === 1)) {
        const short = multiclassShortfalls(classes.map(entry => ({ name: entry.name, ...(entry.system.primaryAbility ? { primaryAbility: entry.system.primaryAbility } : {}) })), scores);
        if (short.length)
            globals().ui.notifications.warn(format("WILDPATH.LEVELUP.Multiclass", { classes: short.join(", ") }));
    }
    const hitDie = Number(item.system.hitDie) || 8;
    const fortitude = actorAbilityModifier(actor, "fortitude") ?? 0;
    const rolled = isClass && !first && (game.settings.get("wildpath", "rollHitPoints") === true);
    const view = { ...await compendiumOptions(item, otherLevels + level),
        hitPoints: isClass ? (rolled ? format("WILDPATH.LEVELUP.HitPointsRolled", { die: `d${hitDie}`, fortitude })
            : format("WILDPATH.LEVELUP.HitPoints", { value: hitPointsForLevel({ hitDie, first, fortitude }) })) : null };
    const sections = steps.map((step, index) => stepHtml(step, index, actor, view)).join("");
    if (!confirm && !/<(?:input|select)\b/u.test(sections) && !view.hitPoints)
        return apply(actor, item, { level, steps, form: new FormData(), first, hitDie, fortitude, rolled });
    const content = `<div class="wildpath level-up">${view.hitPoints ? `<p class="level-up-hp">${escape(view.hitPoints)}</p>` : ""}${sections || `<p>${localize("WILDPATH.LEVELUP.Nothing")}</p>`}</div>`;
    const form = await DialogV2.wait({
        window: { title: isClass ? format("WILDPATH.LEVELUP.Title", { name: item.name, level }) : format("WILDPATH.LEVELUP.Origin", { name: item.name }) },
        position: { width: 520 },
        content,
        buttons: [{ action: "ok", label: localize("WILDPATH.LEVELUP.Confirm"), default: true,
                callback: (_event, button) => (button.form ? new FormData(button.form) : null) }],
        render: (_event, dialog) => {
            const element = dialog.element.querySelector("form");
            if (element)
                watchForm(element, element.querySelector('button[data-action="ok"]'));
        },
        rejectClose: false
    });
    if (!(form instanceof FormData))
        return false;
    return apply(actor, item, { level, steps, form, first, hitDie, fortitude, rolled });
}
/** What the answered steps change, in order: the class's level, the creature, its new Items, then a subclass's own steps. */
async function apply(actor, item, { level, steps, form, first, hitDie, fortitude, rolled }) {
    const picked = (name) => form.getAll(name).map(String).filter(Boolean);
    const uuids = [];
    // What each step's Item gives (its picks too), recorded on that Item (`flags.wildpath.training`), not on the creature.
    const traits = new Map();
    const abilities = Object.fromEntries(Object.entries(actor.system.abilities ?? {}).map(([key, ability]) => [key, { value: Number(ability.value) || 10 }]));
    let size = null;
    let subclass = null;
    for (const [index, { kind, entry, source }] of steps.entries()) {
        const name = `s${index}`;
        if (kind === "grant")
            uuids.push(...(entry.optional ? picked(name) : (entry.items ?? [])));
        else if (kind === "choice")
            uuids.push(...picked(name));
        else if (kind === "trait") {
            const owner = source ?? item;
            traits.set(owner, [...(traits.get(owner) ?? []), ...(entry.grants ?? []), ...(entry.choices ?? []).flatMap((_choice, at) => picked(`${name}.${at}`))]);
        }
        else if (kind === "improvement") {
            for (const [ability, value] of Object.entries(entry.fixed ?? {})) {
                if (abilities[ability])
                    abilities[ability].value = Math.min(abilities[ability].value + value, 20);
            }
            const feat = picked(`${name}.feat`)[0];
            if (feat)
                uuids.push(feat);
            else {
                const chosen = Object.fromEntries((entry.abilities ?? []).map(ability => [ability, Number(form.get(`${name}.${ability}`)) || 0]));
                for (const [path, value] of Object.entries(improvementUpdates(chosen, { abilities }, { cap: entry.cap ?? 2, points: entry.points ?? 0 }))) {
                    const ability = abilities[path.split(".")[2] ?? ""];
                    if (ability)
                        ability.value = Number(value);
                }
            }
        }
        else if (kind === "subclass")
            subclass = picked(name)[0] ?? null;
        else if (kind === "size")
            size = picked(name)[0] ?? entry.sizes?.[0] ?? null;
    }
    for (const [owner, keys] of traits) {
        const known = (owner.flags?.wildpath?.training) ?? [];
        if (keys.length)
            await owner.update({ "flags.wildpath.training": [...new Set([...known, ...keys])] });
    }
    const updates = { ...Object.fromEntries(Object.entries(abilities)
            .filter(([key, ability]) => ability.value !== Number(actor.system.abilities?.[key]?.value))
            .map(([key, ability]) => [`system.abilities.${key}.value`, ability.value])) };
    const footprint = size ? TOKEN_SIZES[size] : undefined;
    if (footprint)
        Object.assign(updates, { "prototypeToken.width": footprint, "prototypeToken.height": footprint });
    if (item.type === "class") {
        // shortcut: a later Fortitude increase does not raise earlier levels' hit points; edit the maximum if it should.
        let gained = hitPointsForLevel({ hitDie, first, fortitude });
        if (rolled) {
            const roll = await new (globals().Roll)(`1d${hitDie}`).evaluate();
            await roll.toMessage({ flavor: format("WILDPATH.LEVELUP.HitPointsRoll", { name: actor.name, class: item.name, level }) });
            gained = Math.max(1, roll.total + fortitude);
        }
        const health = actor.system.resources.health;
        updates["system.resources.health.base"] = first ? gained : health.base + gained;
        updates["system.resources.health.value"] = first ? gained : health.value + gained;
        if (level > (Number(item.system.levels) || 1))
            await item.update({ "system.levels": level });
        // One more Hit Die to spend (a new class's pool starts full; the maximum is its classes' levels), read once the
        // Actor has stored what the new level makes of it (its class records and pools), so this write isn't stale.
        await actor.recordsSettled?.();
        const pools = actor.toObject(true).system.pools;
        const pool = pools.find(entry => entry.id === hitDiePoolId(hitDie));
        const count = actor.items.filter(entry => (entry.type === "class") && (Number(entry.system.hitDie) === hitDie))
            .reduce((sum, entry) => sum + (Number(entry.system.levels) || 0), 0);
        if (pool && (pool.value < count)) {
            pool.value += 1;
            updates["system.pools"] = pools;
        }
    }
    await actor.update(updates);
    if (footprint)
        await Promise.all(actor.getActiveTokens(false, true).map(token => token.update({ width: footprint, height: footprint })));
    await addItems(actor, uuids, item);
    if (subclass) {
        const [created] = await addItems(actor, [subclass], item);
        if (created)
            await levelUp(actor, created, { level, confirm: false });
    }
    return true;
}
