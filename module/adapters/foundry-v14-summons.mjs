import { foundryPointInRange } from "./foundry-v14-area-placement.mjs";
const key = (offset) => `${offset.i},${offset.j}`;
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
    /** Summons leave the Scene, and the combat with them. */
    async function dismiss(scene, tokenIds) {
        const combat = game.combat;
        const combatantIds = [...(combat?.combatants ?? [])].filter(combatant => (combatant.sceneId === scene.id)
            && tokenIds.includes(combatant.tokenId ?? "")).map(combatant => combatant.id);
        if (combatantIds.length)
            await combat?.deleteEmbeddedDocuments?.("Combatant", combatantIds);
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
    async function afterResolution({ options, state }) {
        const definition = state?.actionDefinition;
        const spec = definition?.summon;
        const caster = options?.actor;
        if (!spec || !caster || !isActiveGM())
            return [];
        const casterToken = await fromUuid(String(state?.source?.tokenRef ?? ""));
        const scene = casterToken?.parent ?? null;
        if (!casterToken || !scene) {
            logger.warn("Wild Path | A summon needs its caster's Token on a Scene.");
            return [];
        }
        const choices = state?.configuration?.choices;
        const chosen = !spec.choiceId ? null : Array.isArray(choices) ? choices.find(entry => entry?.id === spec.choiceId) : null;
        const source = await fromUuid(String(spec.actorRef ?? chosen?.value ?? chosen?.optionId ?? ""));
        const base = source ? await worldActor(source) : null;
        if (!base) {
            logger.warn("Wild Path | The creature an Action summons could not be found", spec);
            return [];
        }
        const occupied = new Set([...scene.tokens].flatMap(token => (token.getOccupiedGridSpaceOffsets?.() ?? []).map(key)));
        const start = scene.grid.getOffset({ x: casterToken.x, y: casterToken.y });
        // The summon's own size and shape on this Scene's grid, and (2024) a space its caster can see.
        const shape = await base.getTokenDocument({ actorLink: false }, { parent: scene });
        const footprint = (offset) => {
            const cells = shape.getOccupiedGridSpaceOffsets?.(scene.grid.getTopLeftPoint(offset)) ?? [];
            return cells.length ? cells : [offset];
        };
        // The summon's centre and each of its fields must be in its caster's sight, so it never straddles a wall.
        // shortcut: walls are tested through the caster's placeable, so only when the GM is viewing the caster's Scene.
        const collides = casterToken.object?.checkCollision?.bind(casterToken.object);
        const seen = (point) => !collides?.(point, { type: "sight", mode: "any" });
        const centre = (offset) => {
            const { x, y } = scene.grid.getTopLeftPoint(offset);
            return { x: x + (((shape.width ?? 1) * (scene.grid.sizeX ?? 0)) / 2), y: y + (((shape.height ?? 1) * (scene.grid.sizeY ?? 0)) / 2) };
        };
        // 2024: on the Scene, within the Action's range, and seen by the caster.
        const onScene = (offset) => { const { x, y } = centre(offset); return scene.dimensions?.sceneRect?.contains(x, y) ?? true; };
        const allowed = (offset) => onScene(offset) && foundryPointInRange({ definition: definition ?? {}, sourceToken: casterToken,
            point: centre(offset) }) && (!collides || [centre(offset), ...footprint(offset).map(cell => scene.grid.getCenterPoint?.(cell)
                ?? scene.grid.getTopLeftPoint(cell))].every(seen));
        const count = Math.max(1, Math.min(Number(spec.count) || 1, 20));
        const taken = new Set(occupied);
        const place = (from, wanted) => {
            const found = summonPlacements({ start: from, count: wanted, occupied: taken, footprint, allowed,
                adjacent: offset => scene.grid.getAdjacentOffsets(offset) });
            for (const offset of found)
                for (const cell of footprint(offset))
                    taken.add(key(cell));
            return found;
        };
        // Each clicked point is where one creature appears, or the nearest allowed place to it; the rest go near the caster.
        const offsets = (options?.summonPoints ?? []).slice(0, count).flatMap(point => place(scene.grid.getOffset(point), 1));
        offsets.push(...place(start, count - offsets.length));
        const combat = game.combat ?? null;
        const summon = { casterUuid: caster.uuid, kind: "summon", rounds: Number(spec.rounds) || null,
            createdAt: combat ? { combatId: combat.id, round: combat.round, turn: combat.turn } : null };
        const data = await Promise.all(offsets.map(async (offset) => (await base.getTokenDocument({ ...scene.grid.getTopLeftPoint(offset),
            actorLink: false, disposition: casterToken.disposition ?? 0, flags: { wildpath: { summon } } }, { parent: scene })).toObject()));
        const tokens = await scene.createEmbeddedDocuments("Token", data);
        // Each summon is its caster's: every Player who owns the caster commands it.
        for (const token of tokens)
            if (token.actor)
                await companions.setControllers(token.actor, { controllers: [caster.uuid], kind: "summon" });
        // 2024: in combat a summon shares its caster's Initiative and takes its turn right after the caster's.
        // shortcut: a creature tied with the caster but sorted after it still goes before the summons; fine for whole-number initiative.
        const casterCombatant = [...(combat?.combatants ?? [])].find(entry => (entry.tokenId === casterToken.id) && (entry.sceneId === scene.id));
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
    return { afterResolution, onEffectDeleted, onTurnStart };
}
