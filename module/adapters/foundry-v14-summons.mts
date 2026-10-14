/**
 * Summoning from an Action (M5, companions.md): when an Action with `summon` completes, the active GM places
 * unlinked Tokens of the summoned creature on the nearest free fields around the caster. Each is a summon its
 * caster controls (shared control, as for companions). A concentration summon ends with its caster's
 * concentration marker; one with rounds expires at the start of a turn, like a lasting area.
 */

type Data = Record<string, unknown>;
interface Offset {i: number; j: number}
interface Grid {
  getOffset(point: {x: number; y: number}): Offset;
  getAdjacentOffsets(offset: Offset): Offset[];
  getTopLeftPoint(offset: Offset): {x: number; y: number};
  getCenterPoint?(offset: Offset): {x: number; y: number};
  sizeX?: number; sizeY?: number;
}
interface SummonToken {
  id: string; uuid: string; x: number; y: number; disposition?: number; hidden?: boolean; actorId?: string | null;
  parent?: SummonScene | null;
  actor?: {uuid: string; update?(data: Data): Promise<unknown>} | null;
  flags?: {wildpath?: {summon?: SummonFlag}};
  getOccupiedGridSpaceOffsets?(data?: {x: number; y: number}): Offset[];
  object?: {checkCollision?(destination: {x: number; y: number}, options: {type: string; mode: string}): boolean} | null;
}
interface SummonScene {
  id: string; grid: Grid;
  tokens: Iterable<SummonToken> & {get(id: string): SummonToken | undefined};
  createEmbeddedDocuments(type: string, data: Data[]): Promise<SummonToken[]>;
  deleteEmbeddedDocuments(type: string, ids: string[]): Promise<unknown>;
}
interface SummonFlag {casterUuid: string; kind: string; rounds: number | null; createdAt: {combatId: string; round: number; turn: number | null} | null}
interface Combatant {id: string; tokenId?: string | null; sceneId?: string | null; initiative?: number | null}
interface Combat {
  id: string; round: number; turn: number | null;
  combatants?: Iterable<Combatant>;
  createEmbeddedDocuments?(type: string, data: Data[]): Promise<unknown>;
  deleteEmbeddedDocuments?(type: string, ids: string[]): Promise<unknown>;
}
interface SummonActor {uuid: string; name?: string; prototypeToken?: unknown; toObject(): Data; pack?: string | null;
  getTokenDocument(data: Data, options?: {parent?: unknown}): Promise<{toObject(): Data; width?: number; height?: number;
    getOccupiedGridSpaceOffsets?(data?: {x: number; y: number}): Offset[]}>}
interface CasterActor {uuid: string; createEmbeddedDocuments?(type: string, data: Data[]): Promise<Array<{uuid: string}>>}

const key = (offset: Offset) => `${offset.i},${offset.j}`;

/**
 * The `count` nearest places around `start` where a summon fits, nearest first (a breadth-first search over the
 * grid's own adjacency, so it holds for square and hex grids alike). A place fits when every field of the
 * summon's `footprint` there is free, including of the summons placed before it, and it is `allowed` (seen).
 */
export function summonPlacements({start, count, occupied, adjacent, footprint=offset => [offset], allowed=() => true, limit=400}: {
  start: Offset; count: number; occupied: ReadonlySet<string>; adjacent(offset: Offset): Offset[];
  footprint?(offset: Offset): Offset[]; allowed?(offset: Offset): boolean; limit?: number}): Offset[] {
  const taken = new Set(occupied);
  const seen = new Set([key(start)]);
  const queue: Offset[] = [start];
  const free: Offset[] = [];
  while ( queue.length && (free.length < count) && (seen.size < limit) ) {
    const current = queue.shift()!;
    for ( const next of adjacent(current) ) {
      if ( seen.has(key(next)) ) continue;
      seen.add(key(next));
      queue.push(next);
      const cells = footprint(next).map(key);
      if ( cells.some(cell => taken.has(cell)) || !allowed(next) ) continue;
      free.push(next);
      for ( const cell of cells ) taken.add(cell);
      if ( free.length >= count ) break;
    }
  }
  return free;
}

/** Whether a summon's rounds have run out at this combat turn (N rounds after the turn it arrived on). */
export function summonExpired(flag: SummonFlag | undefined, combat: Combat | null | undefined) {
  const rounds = Number(flag?.rounds);
  const created = flag?.createdAt;
  if ( !combat || !created || (created.combatId !== combat.id) || !(rounds > 0) ) return false;
  const end = created.round + rounds;
  return (combat.round > end) || ((combat.round === end) && ((combat.turn ?? 0) >= (created.turn ?? 0)));
}

export function createFoundrySummons({game, companions, fromUuid, logger=globalThis.console}: {
  game: {user: {id: string}; users?: {activeGM?: {id: string} | null}; combat?: Combat | null;
    scenes?: Iterable<SummonScene>; actors?: Iterable<SummonActor & {flags?: {wildpath?: {summonSource?: string}}}>;
    i18n?: {format(key: string, data: Data): string}};
  companions: {setControllers(companion: unknown, options: {controllers: string[]; kind?: string}): Promise<unknown>};
  fromUuid: (uuid: string) => Promise<unknown> | unknown;
  logger?: {warn(...args: unknown[]): void};
}) {
  const isActiveGM = () => game.users?.activeGM?.id === game.user.id;

  /** Summons leave the Scene, and the combat with them. */
  async function dismiss(scene: SummonScene, tokenIds: string[]) {
    const combat = game.combat;
    const combatantIds = [...(combat?.combatants ?? [])].filter(combatant => (combatant.sceneId === scene.id)
      && tokenIds.includes(combatant.tokenId ?? "")).map(combatant => combatant.id);
    if ( combatantIds.length ) await combat?.deleteEmbeddedDocuments?.("Combatant", combatantIds);
    await scene.deleteEmbeddedDocuments("Token", tokenIds);
  }

  /** A summon from a compendium is imported once into the world, so its Tokens have an Actor to stand for. */
  async function worldActor(source: SummonActor): Promise<SummonActor | null> {
    if ( !source.pack ) return source;
    const existing = [...(game.actors ?? [])].find(actor => actor.flags?.wildpath?.summonSource === source.uuid);
    if ( existing ) return existing;
    const ActorClass = (globalThis as {CONFIG?: {Actor?: {documentClass?: {create(data: Data): Promise<SummonActor>}}}}).CONFIG?.Actor
      ?.documentClass;
    const data = source.toObject();
    return ActorClass?.create({...data, flags: {...((data.flags as Data) ?? {}), wildpath: {summonSource: source.uuid}}}) ?? null;
  }

  async function afterResolution({options, state}: {options?: {actor?: CasterActor}; state?: Data}) {
    const definition = state?.actionDefinition as {label?: string; summon?: {actorRef?: string; choiceId?: string; count?: number;
      rounds?: number; concentration?: boolean}} | undefined;
    const spec = definition?.summon;
    const caster = options?.actor;
    if ( !spec || !caster || !isActiveGM() ) return [];
    const casterToken = await fromUuid(String((state?.source as Data | undefined)?.tokenRef ?? "")) as SummonToken | null;
    const scene = casterToken?.parent ?? null;
    if ( !casterToken || !scene ) {
      logger.warn("Wild Path | A summon needs its caster's Token on a Scene.");
      return [];
    }
    const choices = (state?.configuration as {choices?: unknown} | undefined)?.choices;
    const chosen = !spec.choiceId ? null : Array.isArray(choices) ? choices.find(entry => entry?.id === spec.choiceId) : null;
    const source = await fromUuid(String(spec.actorRef ?? chosen?.value ?? chosen?.optionId ?? "")) as SummonActor | null;
    const base = source ? await worldActor(source) : null;
    if ( !base ) {
      logger.warn("Wild Path | The creature an Action summons could not be found", spec);
      return [];
    }
    const occupied = new Set([...scene.tokens].flatMap(token => (token.getOccupiedGridSpaceOffsets?.() ?? []).map(key)));
    const start = scene.grid.getOffset({x: casterToken.x, y: casterToken.y});
    // The summon's own size and shape on this Scene's grid, and (2024) a space its caster can see.
    const shape = await base.getTokenDocument({actorLink: false}, {parent: scene});
    const footprint = (offset: Offset) => {
      const cells = shape.getOccupiedGridSpaceOffsets?.(scene.grid.getTopLeftPoint(offset)) ?? [];
      return cells.length ? cells : [offset];
    };
    // The summon's centre and each of its fields must be in its caster's sight, so it never straddles a wall.
    // shortcut: walls are tested through the caster's placeable, so only when the GM is viewing the caster's Scene.
    const collides = casterToken.object?.checkCollision?.bind(casterToken.object);
    const seen = (point: {x: number; y: number}) => !collides?.(point, {type: "sight", mode: "any"});
    const centre = (offset: Offset) => {
      const {x, y} = scene.grid.getTopLeftPoint(offset);
      return {x: x + (((shape.width ?? 1) * (scene.grid.sizeX ?? 0)) / 2), y: y + (((shape.height ?? 1) * (scene.grid.sizeY ?? 0)) / 2)};
    };
    const offsets = summonPlacements({start, count: Math.max(1, Math.min(Number(spec.count) || 1, 20)), occupied,
      adjacent: offset => scene.grid.getAdjacentOffsets(offset), footprint,
      allowed: offset => !collides || [centre(offset), ...footprint(offset).map(cell => scene.grid.getCenterPoint?.(cell)
        ?? scene.grid.getTopLeftPoint(cell))].every(seen)});
    const combat = game.combat ?? null;
    const summon: SummonFlag = {casterUuid: caster.uuid, kind: "summon", rounds: Number(spec.rounds) || null,
      createdAt: combat ? {combatId: combat.id, round: combat.round, turn: combat.turn} : null};
    const data = await Promise.all(offsets.map(async offset => (await base.getTokenDocument({...scene.grid.getTopLeftPoint(offset),
      actorLink: false, disposition: casterToken.disposition ?? 0, flags: {wildpath: {summon}}}, {parent: scene})).toObject()));
    const tokens = await scene.createEmbeddedDocuments("Token", data);
    // Each summon is its caster's: every Player who owns the caster commands it.
    for ( const token of tokens ) if ( token.actor ) await companions.setControllers(token.actor, {controllers: [caster.uuid], kind: "summon"});
    // 2024: in combat a summon shares its caster's Initiative and takes its turn right after the caster's.
    // shortcut: a creature tied with the caster but sorted after it still goes before the summons; fine for whole-number initiative.
    const casterCombatant = [...(combat?.combatants ?? [])].find(entry => (entry.tokenId === casterToken.id) && (entry.sceneId === scene.id));
    if ( casterCombatant ) await combat?.createEmbeddedDocuments?.("Combatant", tokens.map((token, index) => ({tokenId: token.id,
      sceneId: scene.id, actorId: token.actorId ?? null, hidden: token.hidden ?? false,
      initiative: typeof casterCombatant.initiative === "number" ? casterCombatant.initiative - ((index + 1) / 1000) : null})));
    if ( spec.concentration ) await caster.createEmbeddedDocuments?.("ActiveEffect", [{type: "effect", system: {},
      name: game.i18n?.format("WILDPATH.AREA.Concentrating", {area: definition?.label ?? base.name ?? ""}) ?? "",
      flags: {wildpath: {summonTokens: {sceneId: scene.id, tokenIds: tokens.map(token => token.id)},
        conditionEffect: {concentration: {sourceRef: `token:${casterToken.id}`}}}}}]);
    return tokens;
  }

  /** A concentration summon's marker ending (concentration broken, or removed by hand) dismisses its summons. */
  async function onEffectDeleted(effect: {flags?: {wildpath?: {summonTokens?: {sceneId: string; tokenIds: string[]}}}}) {
    const link = effect.flags?.wildpath?.summonTokens;
    if ( !link || !isActiveGM() ) return;
    const scene = [...(game.scenes ?? [])].find(entry => entry.id === link.sceneId);
    const present = link.tokenIds.filter(id => scene?.tokens.get(id));
    if ( scene && present.length ) await dismiss(scene, present);
  }

  /** At a turn's start, summons whose rounds have run out leave. */
  async function onTurnStart(combat: Combat | null) {
    if ( !isActiveGM() ) return;
    for ( const scene of game.scenes ?? [] ) {
      const expired = [...scene.tokens].filter(token => summonExpired(token.flags?.wildpath?.summon, combat)).map(token => token.id);
      if ( expired.length ) await dismiss(scene, expired);
    }
  }

  return {afterResolution, onEffectDeleted, onTurnStart};
}
