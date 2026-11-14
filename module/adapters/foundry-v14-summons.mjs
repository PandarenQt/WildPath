import { sceneCollision } from "./foundry-v14-walls.mjs";
import { gmNotice } from "../helpers/gm-notice.mjs";
import { foundryPointInRange } from "./foundry-v14-area-placement.mjs";
import { evaluateValueExpression } from "../helpers/value-expressions.mjs";
import { resolveActorAttackStatistic } from "../helpers/combat-statistics.mjs";
import { withGrantedCastingAbility } from "../helpers/action-definitions.mjs";
import { combatantOf, combatOf } from "./foundry-v14-creature-tokens.mjs";
const key = (offset) => `${offset.i},${offset.j}`;
const evaluate = evaluateValueExpression;
/** An expression at the spell's cast level: its `castLevel` put in, and each dice count worked out to a number. */
function atLevel(expression, level) {
    if (!expression || (typeof expression !== "object"))
        return expression;
    const node = expression;
    if ((node.type === "context") && (node.path === "castLevel"))
        return { type: "constant", value: level };
    const next = Object.fromEntries(Object.entries(node).map(([name, value]) => [name, Array.isArray(value)
            ? value.map(entry => atLevel(entry, level)) : atLevel(value, level)]));
    if ((next.type === "dice") && next.number && (typeof next.number === "object"))
        next.number = Math.max(0, evaluate(next.number, {}).value ?? 0);
    return next;
}
/**
 * An expression with a summoned spirit's numbers written in (`summon.level`: the level it was summoned at; `summon.mod`:
 * its summoner's spellcasting modifier), each dice count worked out; the same object when it has none.
 */
export function withSummonNumbers(expression, numbers) {
    if (!expression || (typeof expression !== "object"))
        return expression;
    const node = expression;
    if ((node.type === "context") && ((node.path === "summon.level") || (node.path === "summon.mod"))) {
        return { type: "constant", value: node.path === "summon.level" ? numbers.level : numbers.mod };
    }
    let changed = false;
    const next = Object.fromEntries(Object.entries(node).map(([name, value]) => {
        const filled = Array.isArray(value) ? value.map(entry => withSummonNumbers(entry, numbers)) : withSummonNumbers(value, numbers);
        if (Array.isArray(value) ? filled.some((entry, index) => entry !== value[index]) : (filled !== value))
            changed = true;
        return [name, filled];
    }));
    if (!changed)
        return expression;
    if ((next.type === "dice") && next.number && (typeof next.number === "object"))
        next.number = Math.max(0, evaluate(next.number, {}).value ?? 0);
    return next;
}
/**
 * What a summon gains with the spell's level (2024 Summon spells, dnd5e's bonuses), at `level`: Hit Points and AC as
 * numbers, and rules for its damage, on attacks (`attackDamage`) and on everything else, saves (`saveDamage`): a
 * Modifier for a number, an ExtraDamage for dice; and for its healing (`healing`), a Modifier.
 */
export function summonBonusesAt(bonuses, level, context = {}) {
    // Its caster's own numbers too (`context`: a Steel Defender's Hit Points, Intelligence + 5 per artificer level).
    const number = (name) => (bonuses?.[name] ? evaluate(atLevel(bonuses[name], level), context).value ?? 0 : 0);
    const attack = { tagsAny: ["melee", "ranged"] };
    // A sum ("your spellcasting modifier + 2d12": Conjure Fey's) is its parts: the numbers worked out now with its caster's
    // own (never the summon's), as a Modifier; each dice part an ExtraDamage.
    const rules = ["attackDamage", "saveDamage"].flatMap((name) => {
        const expression = bonuses?.[name] ? atLevel(bonuses[name], level) : null;
        if (!expression)
            return [];
        const predicate = name === "attackDamage" ? attack : { not: attack };
        const parts = ((expression.type === "add") && Array.isArray(expression.terms) ? expression.terms : [expression]);
        let flat = 0;
        const rolled = [];
        for (const part of parts) {
            const value = (part.type === "dice") ? null : evaluate(part, context);
            if (value?.ok)
                flat += Number(value.value) || 0;
            else
                rolled.push(part);
        }
        return [...(flat ? [{ schemaVersion: 1, id: `summon-${name}`, type: "Modifier", predicate,
                    data: { domains: ["damage"], modifierType: "untyped", value: flat } }] : []),
            ...rolled.map((part, index) => ({ schemaVersion: 1, id: `summon-${name}${index ? `-${index}` : ""}${flat ? "-dice" : ""}`, type: "ExtraDamage",
                predicate, data: { domains: ["damage"], expression: part } }))];
    });
    // Its healing (`healing`: a Find Steed steed's Healing Touch heals the spell's level more), a Modifier on its healing.
    const healing = number("healing");
    if (healing)
        rules.push({ schemaVersion: 1, id: "summon-healing", type: "Modifier",
            data: { domains: ["healing"], modifierType: "untyped", value: healing } });
    return { hp: number("hp"), ac: number("ac"), rules };
}
/**
 * A summon whose attack bonus equals its caster's spell attack modifier (dnd5e `match.attacks`: a Steel Defender's Rend,
 * a 2024 summoning spell's spirit): each of its attacks gains a Modifier, on that Action only (an Action's own rules
 * apply to it alone), making up the difference between its bonus and its caster's (spellcasting modifier +
 * Proficiency Bonus). Returns Item updates. shortcut: its damage's Proficiency Bonus stays its own.
 */
export function matchedAttacks(caster, summoned) {
    if (!caster || !summoned)
        return [];
    const proficiency = (actor) => Number(evaluate({ type: "proficiency-bonus" }, { actor, actorSystem: actor.system }).value) || 0;
    const target = proficiency(caster) + (Number(evaluate({ type: "spellcasting-modifier" }, { actor: caster, actorSystem: caster.system }).value) || 0);
    const statistic = resolveActorAttackStatistic;
    return [...(summoned.items ?? [])].filter(item => item.system?.definition?.attack).flatMap(item => {
        const definition = item.system.definition;
        const value = target - (Number(statistic(summoned, definition.attack, { item, tags: definition.tags ?? [] })?.totalModifier) || 0);
        return value ? [{ _id: item.id, "system.ruleElements": [...(item.system.ruleElements ?? []),
                    { schemaVersion: 1, id: "summon-match-attack", type: "Modifier", data: { domains: ["attack"], modifierType: "untyped", value } }] }] : [];
    });
}
/** A copy of a definition with every save's DC (`save.dc`) and grapple escape DC (`escapeDC`) in it set to `dc`. */
function withSaveDC(node, dc) {
    if (Array.isArray(node))
        return node.map(entry => withSaveDC(entry, dc));
    if (!node || (typeof node !== "object"))
        return node;
    return Object.fromEntries(Object.entries(node).map(([name, value]) => [name,
        ((name === "save") && value && (typeof value === "object") && ("dc" in value))
            ? withSaveDC({ ...value, dc: { value: dc } }, dc)
            : (name === "escapeDC") ? dc : withSaveDC(value, dc)]));
}
/** A spell's own save DC, as the converter writes it: 8 + Proficiency Bonus + spellcasting modifier. */
const SPELL_SAVE_DC = { type: "add", terms: [{ type: "constant", value: 8 }, { type: "proficiency-bonus" }, { type: "spellcasting-modifier" }] };
/**
 * A summon whose save DCs are its caster's spell save DC (dnd5e `match.saves`: Arcane Hand's Grasping Hand, a Flaming
 * Sphere's Roll, a Draconic Spirit's Breath Weapon): every save DC and escape DC of its Actions and of its features'
 * Trigger Actions becomes that DC as it appears. It is read as the summoning Action (`item`, `tags`) reads its own: the
 * casting ability a granting feature gives it (withGrantedCastingAbility) and its caster's `dc.spell` statistic
 * (Innate Sorcery, a Robe of the Archmagi), so the creature's saves and its spell's own never differ. Returns Item updates.
 */
export function matchedSaves(caster, summoned, { item = null, tags = [] } = {}) {
    if (!caster || !summoned)
        return [];
    const context = { actor: caster, actorSystem: caster.system };
    const expression = withGrantedCastingAbility({ tags, dc: SPELL_SAVE_DC }, item).dc;
    const statistic = caster.getStatistic;
    const dc = (Number(evaluate(expression, context).value) || 0)
        + (Number(statistic?.call(caster, "dc.spell", { item, tags })?.totalModifier) || 0);
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    return [...(summoned.items ?? [])].flatMap(item => {
        const definition = item.system?.definition;
        const filled = definition ? withSaveDC(definition, dc) : definition;
        const rules = item.system?.ruleElements ?? [];
        const triggers = rules.map(rule => ((rule?.type === "Trigger") ? withSaveDC(rule, dc) : rule));
        const update = { _id: item.id, ...(same(filled, definition) ? {} : { "system.definition": filled }),
            ...(same(triggers, rules) ? {} : { "system.ruleElements": triggers }) };
        return (Object.keys(update).length > 1) ? [update] : [];
    });
}
/**
 * The `count` nearest places around `start` where a summon fits, nearest first (a breadth-first search over the
 * grid's own adjacency, so it holds for square and hex grids alike). A place fits when every field of the
 * summon's `footprint` there is free, including of the summons placed before it, and it is `allowed` (seen).
 */
export function summonPlacements({ start, count, occupied, adjacent, footprint = offset => [offset], allowed = () => true, limit = 400 }) {
    const taken = new Set(occupied);
    const seen = new Set([key(start)]);
    const queue = [start];
    const free = [];
    const consider = (offset) => {
        const cells = footprint(offset).map(key);
        if (cells.some(cell => taken.has(cell)) || !allowed(offset))
            return;
        free.push(offset);
        for (const cell of cells)
            taken.add(cell);
    };
    if (count > 0)
        consider(start);
    while (queue.length && (free.length < count) && (seen.size < limit)) {
        const current = queue.shift();
        for (const next of adjacent(current)) {
            if (seen.has(key(next)))
                continue;
            seen.add(key(next));
            queue.push(next);
            consider(next);
            if (free.length >= count)
                break;
        }
    }
    return free;
}
/** Whether a summon's rounds have run out at this combat turn (N rounds after the turn it arrived on). */
export function summonExpired(flag, combat) {
    const rounds = Number(flag?.rounds);
    const created = flag?.createdAt;
    if (!combat || !created || (created.combatId !== combat.id) || !(rounds > 0))
        return false;
    const end = created.round + rounds;
    return (combat.round > end) || ((combat.round === end) && ((combat.turn ?? 0) >= (created.turn ?? 0)));
}
export function createFoundrySummons({ game, companions, fromUuid, logger = globalThis.console }) {
    const isActiveGM = () => game.users?.activeGM?.id === game.user.id;
    /** Summons leave the Scene, and every combat with them. */
    async function dismiss(scene, tokenIds) {
        for (const combat of game.combats ?? []) {
            const combatantIds = [...(combat.combatants ?? [])].filter(combatant => (combatant.sceneId === scene.id)
                && tokenIds.includes(combatant.tokenId ?? "")).map(combatant => combatant.id);
            if (combatantIds.length)
                await combat.deleteEmbeddedDocuments?.("Combatant", combatantIds);
        }
        await scene.deleteEmbeddedDocuments("Token", tokenIds);
    }
    /** A summon from a compendium is imported once into the world, so its Tokens have an Actor to stand for. */
    async function worldActor(source) {
        if (!source.pack)
            return source;
        const existing = [...(game.actors ?? [])].find(actor => actor.flags?.wildpath?.summonSource === source.uuid);
        if (existing)
            return existing;
        const ActorClass = globalThis.CONFIG?.Actor
            ?.documentClass;
        const data = source.toObject();
        return ActorClass?.create({ ...data, flags: { ...(data.flags ?? {}), wildpath: { summonSource: source.uuid } } }) ?? null;
    }
    async function afterResolution({ options, state, killed: killedRefs = [] }) {
        const definition = state?.actionDefinition;
        const spec = definition?.summon;
        const caster = options?.actor;
        if (!spec || !caster || !isActiveGM())
            return [];
        const casterToken = await fromUuid(String(state?.source?.tokenRef ?? ""));
        const scene = casterToken?.parent ?? null;
        if (!casterToken || !scene) {
            gmNotice("WILDPATH.NOTICE.SummonNoToken", {}, undefined, { logger });
            return [];
        }
        // `fromKilled` (Finger of Death's Zombie): each target of a listed creature type this Action killed (`killed`, the
        // dying adapter's: a corpse hit again, even one healed since, is not killed twice) rises as the summon, in its corpse's space.
        // shortcut: it rises at once, not "at the start of your next turn", upgrade with a turn-start trigger if the delay matters.
        const killed = !spec.fromKilled ? null : [...new Set((state?.mutationPlans ?? [])
                .map(entry => String(entry.target?.tokenId ?? "")))].map(id => scene.tokens.get(id))
            .filter((token) => Boolean(token?.actor && killedRefs.includes(String(token.actor.uuid))
            && (spec.fromKilled?.types ?? []).includes(String(token.actor.system?.details?.type ?? ""))));
        if (killed && !killed.length)
            return [];
        const choices = state?.configuration?.choices;
        const chosen = !spec.choiceId ? null : Array.isArray(choices) ? choices.find(entry => entry?.id === spec.choiceId) : null;
        const source = await fromUuid(String(spec.actorRef ?? chosen?.value ?? chosen?.optionId ?? ""));
        const base = source ? await worldActor(source) : null;
        if (!base) {
            gmNotice("WILDPATH.NOTICE.SummonMissing", {}, spec, { logger });
            return [];
        }
        // A corpse it rises from is no obstacle.
        const occupied = new Set([...scene.tokens].filter(token => !killed?.includes(token)).flatMap(token => (token.getOccupiedGridSpaceOffsets?.() ?? []).map(key)));
        const start = scene.grid.getOffset({ x: casterToken.x, y: casterToken.y });
        // The summon's own size and shape on this Scene's grid, and (2024) a space its caster can see.
        const shape = await base.getTokenDocument({ actorLink: false }, { parent: scene });
        const footprint = (offset) => {
            const cells = shape.getOccupiedGridSpaceOffsets?.(scene.grid.getTopLeftPoint(offset)) ?? [];
            return cells.length ? cells : [offset];
        };
        // The summon's centre and each of its fields must be in its caster's sight, so it never straddles a wall.
        // Walls count on any Scene, viewed or not (foundry-v14-walls.mts), seen from the caster's centre.
        const collision = sceneCollision(scene);
        const eye = { x: (Number(casterToken.x) || 0) + (((Number(casterToken.width) || 1) * (scene.grid.sizeX ?? 0)) / 2),
            y: (Number(casterToken.y) || 0) + (((Number(casterToken.height) || 1) * (scene.grid.sizeY ?? 0)) / 2) };
        const collides = (point) => Boolean(collision(eye, point, { type: "sight" }));
        const seen = (point) => !collides(point);
        const centre = (offset) => {
            const { x, y } = scene.grid.getTopLeftPoint(offset);
            return { x: x + (((shape.width ?? 1) * (scene.grid.sizeX ?? 0)) / 2), y: y + (((shape.height ?? 1) * (scene.grid.sizeY ?? 0)) / 2) };
        };
        // 2024: on the Scene, within the Action's range, and seen by the caster.
        const onScene = (offset) => { const { x, y } = centre(offset); return scene.dimensions?.sceneRect?.contains(x, y) ?? true; };
        const allowed = (offset) => onScene(offset) && foundryPointInRange({ definition: definition ?? {}, sourceToken: casterToken,
            point: centre(offset) }) && (!collides || [centre(offset), ...footprint(offset).map(cell => scene.grid.getCenterPoint?.(cell)
                ?? scene.grid.getTopLeftPoint(cell))].every(seen));
        // Its count: the chosen creature's own (`counts`, worked out at the cast level for its caster: Animate Dead's
        // slot, Animate Objects' spellcasting modifier), else `count`. Below 1, nothing comes.
        const castLevel = Number(state?.configuration?.castingLevel ?? spec.spellLevel) || 0;
        const ref = String(spec.actorRef ?? chosen?.value ?? chosen?.optionId ?? "");
        const byOption = spec.counts?.find(entry => entry.actorRef === ref)?.count;
        const counted = killed ? killed.length : (byOption == null) ? (Number(spec.count) || 1)
            : Math.floor(Number((typeof byOption === "object") ? evaluate(atLevel(byOption, castLevel), { actor: caster, actorSystem: caster.system }).value
                : byOption) || 0);
        if (counted < 1) {
            gmNotice("WILDPATH.NOTICE.SummonNone", { name: definition?.label ?? "" }, undefined, { logger });
            return [];
        }
        const count = Math.min(counted, 20);
        const taken = new Set(occupied);
        const place = (from, wanted) => {
            // A risen corpse stands where it lies, whatever the caster's range or sight.
            const found = summonPlacements({ start: from, count: wanted, occupied: taken, footprint, allowed: killed ? onScene : allowed,
                adjacent: offset => scene.grid.getAdjacentOffsets(offset) });
            for (const offset of found)
                for (const cell of footprint(offset))
                    taken.add(key(cell));
            return found;
        };
        // Each clicked point (or corpse) is where one creature appears, or the nearest allowed place to it; the rest go near the caster.
        const points = killed ? killed.map(token => ({ x: token.x, y: token.y })) : (options?.summonPoints ?? []);
        const offsets = points.slice(0, count).flatMap(point => place(scene.grid.getOffset(point), 1));
        offsets.push(...place(start, count - offsets.length));
        // Its caster's combat, not the one the GM's tracker shows: its rounds pass, and the summons join, there.
        // shortcut: a caster that is no Combatant counts rounds in the tracker's combat; upgrade with the turn-clock question.
        const combat = combatOf(casterToken, game) ?? game.combat ?? null;
        const actionId = definition?.id ?? null;
        const summon = { casterUuid: caster.uuid, kind: "summon", rounds: Number(spec.rounds) || null,
            createdAt: combat ? { combatId: combat.id, round: combat.round, turn: combat.turn } : null, actionId, at: Date.now(),
            ...(spec.endsWithSummoner ? { endsWithSummoner: true } : {}) };
        // At most `limit` of its caster's from this Action (a Steel Defender, two Eldritch Cannons): the oldest go first.
        const limit = (spec.limit && (typeof spec.limit === "object")) ? Number(evaluate(spec.limit, { actor: caster, actorSystem: caster.system }).value)
            : Number(spec.limit);
        if (limit > 0)
            await dismissPastLimit(caster.uuid, actionId, Math.max(limit - count, 0));
        const data = await Promise.all(offsets.map(async (offset) => (await base.getTokenDocument({ ...scene.grid.getTopLeftPoint(offset),
            actorLink: false, disposition: casterToken.disposition ?? 0, flags: { wildpath: { summon } } }, { parent: scene })).toObject()));
        const tokens = await scene.createEmbeddedDocuments("Token", data);
        // Each summon is its caster's: every Player who owns the caster commands it.
        for (const token of tokens)
            if (token.actor)
                await companions.setControllers(token.actor, { controllers: [caster.uuid], kind: "summon" });
        // What it gains with the spell's level: the slot it was cast with, else the spell's own level.
        const level = Number(state?.configuration?.castingLevel ?? spec.spellLevel) || 0;
        // What it gains: a spell's by its level, a feature's by its caster (an artificer's level and Intelligence).
        if (spec.bonuses || spec.match?.attacks || spec.match?.saves)
            for (const token of tokens) {
                if (spec.bonuses)
                    await applySummonBonuses(token, summonBonusesAt(spec.bonuses, level, { actor: caster, actorSystem: caster.system }), level);
                // One after the other: an attack with a save is updated by both, the second reading the first's result.
                for (const match of [spec.match?.attacks && matchedAttacks, spec.match?.saves && matchedSaves]) {
                    const matched = match ? match(caster, token.actor, { item: options?.action ?? null, tags: definition?.tags ?? [] }) : [];
                    if (matched.length)
                        await token.actor
                            .updateEmbeddedDocuments("Item", matched);
                }
            }
        // The level it was summoned at, which a spirit's own rules read (its Multiattack: half this spell's level), and its
        // Actions' damage with that level and its summoner's spellcasting modifier written in (withSummonNumbers).
        const mod = Number(evaluate({ type: "spellcasting-modifier" }, { actor: caster, actorSystem: caster.system }).value) || 0;
        if (level)
            for (const token of tokens) {
                await token.actor?.setFlag?.("wildpath", "summonLevel", level);
                const items = [...(token.actor?.items ?? [])];
                const updates = items.filter(item => item.type === "action").flatMap(item => {
                    const definition = item.system?.definition;
                    const filled = withSummonNumbers(definition, { level, mod });
                    return (filled !== definition) ? [{ _id: item.id, "system.definition": filled }] : [];
                });
                if (updates.length)
                    await token.actor
                        .updateEmbeddedDocuments("Item", updates);
                await token.actor?.syncItemRecords?.();
            }
        // 2024: in combat a summon shares its caster's Initiative and takes its turn right after the caster's.
        // shortcut: a creature tied with the caster but sorted after it still goes before the summons; fine for whole-number initiative.
        const casterCombatant = combatantOf(casterToken, combat);
        if (casterCombatant)
            await combat?.createEmbeddedDocuments?.("Combatant", tokens.map((token, index) => ({ tokenId: token.id,
                sceneId: scene.id, actorId: token.actorId ?? null, hidden: token.hidden ?? false,
                initiative: typeof casterCombatant.initiative === "number" ? casterCombatant.initiative - ((index + 1) / 1000) : null })));
        if (spec.concentration)
            await caster.createEmbeddedDocuments?.("ActiveEffect", [{ type: "effect", system: {},
                    name: game.i18n?.format("WILDPATH.AREA.Concentrating", { area: definition?.label ?? base.name ?? "" }) ?? "",
                    flags: { wildpath: { summonTokens: { sceneId: scene.id, tokenIds: tokens.map(token => token.id) },
                            conditionEffect: { concentration: { sourceRef: `token:${casterToken.id}` } } } } }]);
        return tokens;
    }
    /** Its Hit Points and AC on the summoned Token's own Actor, and its damage rules as a feature of it. */
    async function applySummonBonuses(token, bonuses, level) {
        const actor = token.actor;
        if (!actor?.update)
            return;
        const health = actor.system?.resources?.health ?? {};
        const updates = {};
        if (bonuses.hp)
            Object.assign(updates, { "system.resources.health.base": (Number(health.base) || 0) + bonuses.hp,
                "system.resources.health.value": (Number(health.value) || 0) + bonuses.hp });
        // shortcut: a summon whose AC is worked out (not typed) does not gain the bonus; converted creatures' AC is typed.
        const typedAc = actor.system?.defenses?.ac?.value;
        if (bonuses.ac && (typedAc != null))
            updates["system.defenses.ac.value"] = Number(typedAc) + bonuses.ac;
        if (Object.keys(updates).length)
            await actor.update(updates);
        if (bonuses.rules.length)
            await actor.createEmbeddedDocuments?.("Item", [{ type: "feature", img: "icons/svg/upgrade.svg",
                    name: game.i18n?.format("WILDPATH.SUMMON.Level", { level: String(level) }) ?? `Level ${level}`,
                    system: { active: true, ruleElements: bonuses.rules } }]);
    }
    /** Its caster's summons from one Action, oldest first, beyond the `keep` newest: dismissed. */
    async function dismissPastLimit(casterUuid, actionId, keep) {
        const mine = [...(game.scenes ?? [])].flatMap(scene => [...scene.tokens].filter(token => {
            const flag = token.flags?.wildpath?.summon;
            return (flag?.casterUuid === casterUuid) && ((flag.actionId ?? null) === actionId);
        }).map(token => ({ scene, token, at: Number((token.flags?.wildpath?.summon).at) || 0 }))).sort((a, b) => a.at - b.at);
        for (const { scene, token } of mine.slice(0, Math.max(mine.length - keep, 0)))
            await dismiss(scene, [token.id]);
    }
    /** Its caster dies (the Dead condition): the summons that go with it (a Homunculus Servant) are dismissed. */
    async function onCasterDead(effect) {
        if (!isActiveGM() || ![...(effect.statuses ?? [])].includes("dead") || !effect.parent?.uuid)
            return;
        for (const scene of game.scenes ?? []) {
            const gone = [...scene.tokens].filter(token => {
                const flag = token.flags?.wildpath?.summon;
                return flag?.endsWithSummoner && (flag.casterUuid === effect.parent.uuid);
            }).map(token => token.id);
            if (gone.length)
                await dismiss(scene, gone);
        }
    }
    /** A concentration summon's marker ending (concentration broken, or removed by hand) dismisses its summons. */
    async function onEffectDeleted(effect) {
        const link = effect.flags?.wildpath?.summonTokens;
        if (!link || !isActiveGM())
            return;
        const scene = [...(game.scenes ?? [])].find(entry => entry.id === link.sceneId);
        const present = link.tokenIds.filter(id => scene?.tokens.get(id));
        if (scene && present.length)
            await dismiss(scene, present);
    }
    /** At a turn's start, summons whose rounds have run out leave. */
    async function onTurnStart(combat) {
        if (!isActiveGM())
            return;
        for (const scene of game.scenes ?? []) {
            const expired = [...scene.tokens].filter(token => summonExpired(token.flags?.wildpath?.summon, combat)).map(token => token.id);
            if (expired.length)
                await dismiss(scene, expired);
        }
    }
    return { afterResolution, onEffectDeleted, onTurnStart, onCasterDead, dismiss };
}
