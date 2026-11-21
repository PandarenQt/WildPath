/**
 * Companions, summons and sidekicks (maintainer decision, 2026-10-14). A companion lists the creatures that
 * control it in `system.companion.controllers`. Control is shared: every Player who owns one of those
 * controllers owns the companion too, so a large summoning can be split between Players. Only a GM may change
 * ownership, so a Player's change is asked of the active GM through a user query.
 */
import {effectGiverActor} from "../helpers/effect-sources.mjs";

type Data = Record<string, unknown>;
interface User {id: string; isGM?: boolean}
interface CompanionActor {
  uuid: string;
  ownership?: Record<string, number>;
  system?: {companion?: {kind?: string; controllers?: string[]}};
  testUserPermission?(user: unknown, level: string): boolean;
  update(data: Data): Promise<unknown>;
}

export const COMPANION_QUERY = "wildpath.companionControl";
export const COMPANION_KINDS = Object.freeze(["companion", "summon", "sidekick"]);
const OWNER = 3;
const INHERIT = -1;
const MAX_CONTROLLERS = 20;

/**
 * The ownership changes that make every Player who owns one of `controllers` an owner of the companion, and
 * return a Player who controlled it only through a removed controller to the default. GMs are left alone.
 */
export function companionOwnershipChanges({ownership={}, previous=[], controllers, users, owns}: {
  ownership?: Record<string, number> | undefined; previous?: readonly string[]; controllers: readonly string[];
  users: Iterable<User>; owns(userId: string, controllerRef: string): boolean;
}) {
  const changes: Record<string, number> = {};
  for ( const user of users ) {
    if ( user.isGM ) continue;
    const now = controllers.some(ref => owns(user.id, ref));
    const before = previous.some(ref => owns(user.id, ref));
    if ( now && (ownership[user.id] !== OWNER) ) changes[user.id] = OWNER;
    else if ( !now && before && (ownership[user.id] === OWNER) ) changes[user.id] = INHERIT;
  }
  return changes;
}

export function createFoundryCompanions({game, fromUuid}: {
  game: {user: User; users?: Iterable<User> & {activeGM?: (User & {query?(name: string, data: Data,
    options: {timeout: number}): Promise<unknown>}) | null}};
  fromUuid: (uuid: string) => Promise<unknown> | unknown;
}) {
  const resolve = async (ref: string) => await fromUuid(ref) as CompanionActor | null;

  async function apply(companion: CompanionActor, {controllers, kind}: {controllers: readonly string[]; kind?: string | undefined}) {
    const refs = [...new Set(controllers.filter(ref => typeof ref === "string" && ref))].slice(0, MAX_CONTROLLERS);
    const current = companion.system?.companion ?? {};
    const previous = current.controllers ?? [];
    const documents = new Map<string, CompanionActor | null>();
    for ( const ref of new Set([...refs, ...previous]) ) documents.set(ref, await resolve(ref));
    const kept = refs.filter(ref => documents.get(ref));
    const users = [...(game.users ?? [])];
    const changes = companionOwnershipChanges({ownership: companion.ownership, previous, controllers: kept, users,
      owns: (userId, ref) => documents.get(ref)?.testUserPermission?.(users.find(user => user.id === userId), "OWNER") === true});
    await companion.update({
      "system.companion": {kind: COMPANION_KINDS.includes(String(kind)) ? kind : (current.kind ?? "companion"), controllers: kept},
      ...Object.fromEntries(Object.entries(changes).map(([id, level]) => [`ownership.${id}`, level]))
    });
    return {ok: true, controllers: kept};
  }

  /** Set who controls a companion. A GM applies it; a Player who owns the companion asks the active GM. */
  async function setControllers(companion: CompanionActor, options: {controllers: readonly string[]; kind?: string | undefined}) {
    if ( game.user.isGM ) return apply(companion, options);
    const gm = game.users?.activeGM;
    if ( !gm?.query ) return {ok: false, reason: "No GM is connected to change who controls this creature."};
    return gm.query(COMPANION_QUERY, {actorUuid: companion.uuid, controllers: [...options.controllers], kind: options.kind ?? null},
      {timeout: 15000});
  }

  /** The GM's handler: the server-attested sender must own the companion. */
  async function handleQuery(payload: Data = {}, {user=null}: {user?: unknown} = {}) {
    if ( !game.user.isGM || !user || (typeof payload.actorUuid !== "string") || !Array.isArray(payload.controllers) ) return {ok: false};
    const companion = await resolve(payload.actorUuid);
    if ( !companion?.testUserPermission?.(user, "OWNER") ) return {ok: false};
    return apply(companion, {controllers: payload.controllers.filter((ref): ref is string => typeof ref === "string"),
      kind: typeof payload.kind === "string" ? payload.kind : undefined});
  }

  const isActiveGM = () => Boolean(game.user.isGM) && (game.users?.activeGM?.id === game.user.id);
  const controls = (effect: ControlEffect) => effect.flags?.wildpath?.conditionEffect?.metadata?.control === true;
  const giverOf = (effect: ControlEffect) => (effectGiverActor as (effect: unknown) => CompanionActor | null)(effect);

  /**
   * An effect giving control (`metadata.control`: Pipes of the Sewers' Swayed, a homebrew domination) makes its creature
   * its giver's companion while it lasts: the active GM adds the giver to its controllers as the effect lands, and takes
   * it off when the last such effect holding it goes, however it ends (its duration, a Trigger's `ends`, the GM). Each such
   * effect notes the controller it holds (`flags.wildpath.controlRef`), so its end takes off only control such effects gave,
   * never a controller the creature had before (a summon's caster), even when its giver can no longer be found (a slain
   * piper's deleted Token).
   * shortcut: disabling such an effect by hand leaves the control; upgrade by answering updateActiveEffect too.
   */
  async function onEffectCreated(effect: ControlEffect) {
    const companion = effect.parent;
    if ( !controls(effect) || effect.disabled || !companion?.system?.companion || !isActiveGM() ) return null;
    const giver = giverOf(effect);
    const controllers = companion.system.companion.controllers ?? [];
    if ( !giver?.uuid || (giver.uuid === companion.uuid) ) return null;
    const held = controllers.includes(giver.uuid);
    // Already its controller by other means: this effect gives nothing, so its end takes nothing.
    if ( held && !heldBy(companion, giver.uuid, effect) ) return null;
    await effect.update?.({"flags.wildpath.controlRef": giver.uuid});
    return held ? null : apply(companion, {controllers: [...controllers, giver.uuid]});
  }

  async function onEffectDeleted(effect: ControlEffect) {
    const companion = effect.parent;
    const ref = effect.flags?.wildpath?.controlRef;
    if ( !ref || !companion?.system?.companion || !isActiveGM() ) return null;
    const controllers = companion.system.companion.controllers ?? [];
    // Another effect still holding it for the same controller keeps the control.
    if ( !controllers.includes(ref) || heldBy(companion, ref, effect) ) return null;
    return apply(companion, {controllers: controllers.filter(each => each !== ref)});
  }

  /** Whether another enabled control effect on `companion` than `effect` holds it for `ref`. */
  const heldBy = (companion: NonNullable<ControlEffect["parent"]>, ref: string, effect: ControlEffect) => [...(companion.effects ?? [])]
    .some(other => (other.id !== effect.id) && !other.disabled && (other.flags?.wildpath?.controlRef === ref));

  return {setControllers, handleQuery, onEffectCreated, onEffectDeleted};
}

interface ControlEffect {
  id?: string; disabled?: boolean; parent?: (CompanionActor & {effects?: Iterable<ControlEffect>}) | null;
  flags?: {wildpath?: {conditionEffect?: {metadata?: {control?: unknown}}; controlRef?: string}};
  update?(data: Data): Promise<unknown>;
}
