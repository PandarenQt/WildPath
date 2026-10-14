/**
 * Summoning from an Action (M5, companions.md): when an Action with `summon` completes, the active GM places
 * unlinked Tokens of the summoned creature on the nearest free fields around the caster. Each is a summon its
 * caster controls (shared control, as for companions). A concentration summon ends with its caster's
 * concentration marker; one with rounds expires at the start of a turn, like a lasting area.
 */
const key = (offset) => `${offset.i},${offset.j}`;
/**
 * The `count` nearest fields around `start` that no Token occupies, nearest first (a breadth-first search
 * over the grid's own adjacency, so it holds for square and hex grids alike).
 */
export function summonPlacements({ start, count, occupied, adjacent, limit = 400 }) {
    const seen = new Set([key(start)]);
    const queue = [start];
    const free = [];
    while (queue.length && (free.length < count) && (seen.size < limit)) {
        const current = queue.shift();
        for (const next of adjacent(current)) {
            if (seen.has(key(next)))
                continue;
            seen.add(key(next));
            if (!occupied.has(key(next)))
                free.push(next);
            queue.push(next);
            if (free.length >= count)
                break;
        }
    }
    return free.slice(0, count);
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
        const offsets = summonPlacements({ start, count: Math.max(1, Math.min(Number(spec.count) || 1, 20)), occupied,
            adjacent: offset => scene.grid.getAdjacentOffsets(offset) });
        const combat = game.combat ?? null;
        const summon = { casterUuid: caster.uuid, kind: "summon", rounds: Number(spec.rounds) || null,
            createdAt: combat ? { combatId: combat.id, round: combat.round, turn: combat.turn } : null };
        const data = await Promise.all(offsets.map(async (offset) => (await base.getTokenDocument({ ...scene.grid.getTopLeftPoint(offset),
            actorLink: false, disposition: casterToken.disposition ?? 0, flags: { wildpath: { summon } } })).toObject()));
        const tokens = await scene.createEmbeddedDocuments("Token", data);
        // Each summon is its caster's: every Player who owns the caster commands it.
        for (const token of tokens)
            if (token.actor)
                await companions.setControllers(token.actor, { controllers: [caster.uuid], kind: "summon" });
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
            await scene.deleteEmbeddedDocuments("Token", present);
    }
    /** At a turn's start, summons whose rounds have run out leave. */
    async function onTurnStart(combat) {
        if (!isActiveGM())
            return;
        for (const scene of game.scenes ?? []) {
            const expired = [...scene.tokens].filter(token => summonExpired(token.flags?.wildpath?.summon, combat)).map(token => token.id);
            if (expired.length)
                await scene.deleteEmbeddedDocuments("Token", expired);
        }
    }
    return { afterResolution, onEffectDeleted, onTurnStart };
}
