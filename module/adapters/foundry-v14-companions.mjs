/**
 * Companions, summons and sidekicks (maintainer decision, 2026-10-14). A companion lists the creatures that
 * control it in `system.companion.controllers`. Control is shared: every Player who owns one of those
 * controllers owns the companion too, so a large summoning can be split between Players. Only a GM may change
 * ownership, so a Player's change is asked of the active GM through a user query.
 */
export const COMPANION_QUERY = "wildpath.companionControl";
export const COMPANION_KINDS = Object.freeze(["companion", "summon", "sidekick"]);
const OWNER = 3;
const INHERIT = -1;
const MAX_CONTROLLERS = 20;
/**
 * The ownership changes that make every Player who owns one of `controllers` an owner of the companion, and
 * return a Player who controlled it only through a removed controller to the default. GMs are left alone.
 */
export function companionOwnershipChanges({ ownership = {}, previous = [], controllers, users, owns }) {
    const changes = {};
    for (const user of users) {
        if (user.isGM)
            continue;
        const now = controllers.some(ref => owns(user.id, ref));
        const before = previous.some(ref => owns(user.id, ref));
        if (now && (ownership[user.id] !== OWNER))
            changes[user.id] = OWNER;
        else if (!now && before && (ownership[user.id] === OWNER))
            changes[user.id] = INHERIT;
    }
    return changes;
}
export function createFoundryCompanions({ game, fromUuid }) {
    const resolve = async (ref) => await fromUuid(ref);
    async function apply(companion, { controllers, kind }) {
        const refs = [...new Set(controllers.filter(ref => typeof ref === "string" && ref))].slice(0, MAX_CONTROLLERS);
        const current = companion.system?.companion ?? {};
        const previous = current.controllers ?? [];
        const documents = new Map();
        for (const ref of new Set([...refs, ...previous]))
            documents.set(ref, await resolve(ref));
        const kept = refs.filter(ref => documents.get(ref));
        const users = [...(game.users ?? [])];
        const changes = companionOwnershipChanges({ ownership: companion.ownership, previous, controllers: kept, users,
            owns: (userId, ref) => documents.get(ref)?.testUserPermission?.(users.find(user => user.id === userId), "OWNER") === true });
        await companion.update({
            "system.companion": { kind: COMPANION_KINDS.includes(String(kind)) ? kind : (current.kind ?? "companion"), controllers: kept },
            ...Object.fromEntries(Object.entries(changes).map(([id, level]) => [`ownership.${id}`, level]))
        });
        return { ok: true, controllers: kept };
    }
    /** Set who controls a companion. A GM applies it; a Player who owns the companion asks the active GM. */
    async function setControllers(companion, options) {
        if (game.user.isGM)
            return apply(companion, options);
        const gm = game.users?.activeGM;
        if (!gm?.query)
            return { ok: false, reason: "No GM is connected to change who controls this creature." };
        return gm.query(COMPANION_QUERY, { actorUuid: companion.uuid, controllers: [...options.controllers], kind: options.kind ?? null }, { timeout: 15000 });
    }
    /** The GM's handler: the server-attested sender must own the companion. */
    async function handleQuery(payload = {}, { user = null } = {}) {
        if (!game.user.isGM || !user || (typeof payload.actorUuid !== "string") || !Array.isArray(payload.controllers))
            return { ok: false };
        const companion = await resolve(payload.actorUuid);
        if (!companion?.testUserPermission?.(user, "OWNER"))
            return { ok: false };
        return apply(companion, { controllers: payload.controllers.filter((ref) => typeof ref === "string"),
            kind: typeof payload.kind === "string" ? payload.kind : undefined });
    }
    return { setControllers, handleQuery };
}
