import {sceneCollision} from "./foundry-v14-walls.mjs";
import {gmNotice} from "../helpers/gm-notice.mjs";
import {foundryPointInRange} from "./foundry-v14-area-placement.mjs";
import {evaluateValueExpression} from "../helpers/value-expressions.mjs";
import {resolveActorAttackStatistic} from "../helpers/combat-statistics.mjs";

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
  id: string; uuid: string; x: number; y: number; width?: number; height?: number; disposition?: number; hidden?: boolean;
  actorId?: string | null;
  parent?: SummonScene | null;
  actor?: {uuid: string; update?(data: Data): Promise<unknown>; createEmbeddedDocuments?(type: string, data: Data[]): Promise<unknown>;
    setFlag?(scope: string, key: string, value: unknown): Promise<unknown>; syncItemRecords?(): Promise<unknown>;
    system?: {resources?: {health?: {base?: number; value?: number}}; defenses?: {ac?: {value?: number}}}} | null;
  flags?: {wildpath?: {summon?: SummonFlag}};
  getOccupiedGridSpaceOffsets?(data?: {x: number; y: number}): Offset[];
  object?: {checkCollision?(destination: {x: number; y: number}, options: {type: string; mode: string}): boolean} | null;
}
interface SummonScene {
  id: string; grid: Grid; dimensions?: {sceneRect?: {contains(x: number, y: number): boolean}};
  tokens: Iterable<SummonToken> & {get(id: string): SummonToken | undefined};
  createEmbeddedDocuments(type: string, data: Data[]): Promise<SummonToken[]>;
  deleteEmbeddedDocuments(type: string, ids: string[]): Promise<unknown>;
}
interface SummonFlag {casterUuid: string; kind: string; rounds: number | null; createdAt: {combatId: string; round: number; turn: number | null} | null;
  /** The Action that summoned it and when (its `limit` counts them), and whether it goes when its caster dies. */
  actionId?: string | null; at?: number; endsWithSummoner?: boolean}
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
interface CasterActor {uuid: string; system?: unknown; createEmbeddedDocuments?(type: string, data: Data[]): Promise<Array<{uuid: string}>>}

const key = (offset: Offset) => `${offset.i},${offset.j}`;
const evaluate = evaluateValueExpression as unknown as (expression: unknown, context: Data) => {ok: boolean; value?: number};

/** An expression at the spell's cast level: its `castLevel` put in, and each dice count worked out to a number. */
function atLevel(expression: unknown, level: number): unknown {
  if ( !expression || (typeof expression !== "object") ) return expression;
  const node = expression as Data;
  if ( (node.type === "context") && (node.path === "castLevel") ) return {type: "constant", value: level};
  const next: Data = Object.fromEntries(Object.entries(node).map(([name, value]) => [name, Array.isArray(value)
    ? value.map(entry => atLevel(entry, level)) : atLevel(value, level)]));
  if ( (next.type === "dice") && next.number && (typeof next.number === "object") ) next.number = Math.max(0, evaluate(next.number, {}).value ?? 0);
  return next;
}

/**
 * What a summon gains with the spell's level (2024 Summon spells, dnd5e's bonuses), at `level`: Hit Points and AC as
 * numbers, and rules for its damage, on attacks (`attackDamage`) and on everything else, saves (`saveDamage`): a
 * Modifier for a number, an ExtraDamage for dice.
 */
export function summonBonusesAt(bonuses: Data | null | undefined, level: number, context: Data = {}) {
  // Its caster's own numbers too (`context`: a Steel Defender's Hit Points, Intelligence + 5 per artificer level).
  const number = (name: string) => (bonuses?.[name] ? evaluate(atLevel(bonuses[name], level), context).value ?? 0 : 0);
  const attack = {tagsAny: ["melee", "ranged"]};
  // A sum ("your spellcasting modifier + 2d12": Conjure Fey's) is its parts: the numbers worked out now with its caster's
  // own (never the summon's), as a Modifier; each dice part an ExtraDamage.
  const rules = (["attackDamage", "saveDamage"] as const).flatMap((name): Data[] => {
    const expression = bonuses?.[name] ? atLevel(bonuses[name], level) as Data : null;
    if ( !expression ) return [];
    const predicate = name === "attackDamage" ? attack : {not: attack};
    const parts = ((expression.type === "add") && Array.isArray(expression.terms) ? expression.terms : [expression]) as Data[];
    let flat = 0;
    const rolled: Data[] = [];
    for ( const part of parts ) {
      const value = (part.type === "dice") ? null : evaluate(part, context);
      if ( value?.ok ) flat += Number(value.value) || 0;
      else rolled.push(part);
    }
    return [...(flat ? [{schemaVersion: 1, id: `summon-${name}`, type: "Modifier", predicate,
      data: {domains: ["damage"], modifierType: "untyped", value: flat}}] : []),
      ...rolled.map((part, index) => ({schemaVersion: 1, id: `summon-${name}${index ? `-${index}` : ""}${flat ? "-dice" : ""}`, type: "ExtraDamage",
        predicate, data: {domains: ["damage"], expression: part}}))];
  });
  return {hp: number("hp"), ac: number("ac"), rules};
}

/**
 * A summon whose attack bonus equals its caster's spell attack modifier (dnd5e `match.attacks`: a Steel Defender's Rend,
 * a 2024 summoning spell's spirit): one Modifier making up the difference between its own attack bonus (its first
 * attack's) and its caster's (spellcasting modifier + Proficiency Bonus). shortcut: a creature whose attacks differ in
 * bonus gets the first one's difference on all; its damage's Proficiency Bonus stays its own.
 */
export function matchedAttack(caster: Data | null | undefined, summoned: Data | null | undefined): Data[] {
  if ( !caster || !summoned ) return [];
  const proficiency = (actor: Data) => Number(evaluate({type: "proficiency-bonus"}, {actor, actorSystem: actor.system}).value) || 0;
  const spell = Number(evaluate({type: "spellcasting-modifier"}, {actor: caster, actorSystem: caster.system}).value) || 0;
  type AttackItem = {system?: {definition?: {attack?: unknown}}};
  const attack = [...((summoned.items ?? []) as Iterable<AttackItem>)].find(item => item.system?.definition?.attack)?.system?.definition?.attack;
  const own = attack ? Number((resolveActorAttackStatistic as (actor: unknown, attack: unknown) => Data | null)(summoned, attack)?.totalModifier) || 0
    : proficiency(summoned);
  const value = spell + proficiency(caster) - own;
  return value ? [{schemaVersion: 1, id: "summon-match-attack", type: "Modifier", data: {domains: ["attack"], modifierType: "untyped", value}}] : [];
}

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
  const consider = (offset: Offset) => {
    const cells = footprint(offset).map(key);
    if ( cells.some(cell => taken.has(cell)) || !allowed(offset) ) return;
    free.push(offset);
    for ( const cell of cells ) taken.add(cell);
  };
  if ( count > 0 ) consider(start);
  while ( queue.length && (free.length < count) && (seen.size < limit) ) {
    const current = queue.shift()!;
    for ( const next of adjacent(current) ) {
      if ( seen.has(key(next)) ) continue;
      seen.add(key(next));
      queue.push(next);
      consider(next);
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

  async function afterResolution({options, state}: {options?: {actor?: CasterActor; summonPoints?: Array<{x: number; y: number}>};
    state?: Data}) {
    const definition = state?.actionDefinition as {label?: string; summon?: {actorRef?: string; choiceId?: string; count?: number;
      counts?: Array<{actorRef?: string; count?: unknown}>; rounds?: number; concentration?: boolean; bonuses?: Data; spellLevel?: number;
      limit?: number | Data; endsWithSummoner?: boolean; match?: {attacks?: boolean}};
      range?: {normal?: {value?: number}; distance?: {value?: number}} | null} | undefined;
    const spec = definition?.summon;
    const caster = options?.actor;
    if ( !spec || !caster || !isActiveGM() ) return [];
    const casterToken = await fromUuid(String((state?.source as Data | undefined)?.tokenRef ?? "")) as SummonToken | null;
    const scene = casterToken?.parent ?? null;
    if ( !casterToken || !scene ) {
      gmNotice("WILDPATH.NOTICE.SummonNoToken", {}, undefined, {logger});
      return [];
    }
    const choices = (state?.configuration as {choices?: unknown} | undefined)?.choices;
    const chosen = !spec.choiceId ? null : Array.isArray(choices) ? choices.find(entry => entry?.id === spec.choiceId) : null;
    const source = await fromUuid(String(spec.actorRef ?? chosen?.value ?? chosen?.optionId ?? "")) as SummonActor | null;
    const base = source ? await worldActor(source) : null;
    if ( !base ) {
      gmNotice("WILDPATH.NOTICE.SummonMissing", {}, spec, {logger});
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
    // Walls count on any Scene, viewed or not (foundry-v14-walls.mts), seen from the caster's centre.
    const collision = sceneCollision(scene as never);
    const eye = {x: (Number(casterToken.x) || 0) + (((Number(casterToken.width) || 1) * (scene.grid.sizeX ?? 0)) / 2),
      y: (Number(casterToken.y) || 0) + (((Number(casterToken.height) || 1) * (scene.grid.sizeY ?? 0)) / 2)};
    const collides = (point: {x: number; y: number}) => Boolean(collision(eye, point, {type: "sight"}));
    const seen = (point: {x: number; y: number}) => !collides(point);
    const centre = (offset: Offset) => {
      const {x, y} = scene.grid.getTopLeftPoint(offset);
      return {x: x + (((shape.width ?? 1) * (scene.grid.sizeX ?? 0)) / 2), y: y + (((shape.height ?? 1) * (scene.grid.sizeY ?? 0)) / 2)};
    };
    // 2024: on the Scene, within the Action's range, and seen by the caster.
    const onScene = (offset: Offset) => { const {x, y} = centre(offset); return scene.dimensions?.sceneRect?.contains(x, y) ?? true; };
    const allowed = (offset: Offset) => onScene(offset) && foundryPointInRange({definition: definition ?? {}, sourceToken: casterToken as never,
      point: centre(offset)}) && (!collides || [centre(offset), ...footprint(offset).map(cell => scene.grid.getCenterPoint?.(cell)
        ?? scene.grid.getTopLeftPoint(cell))].every(seen));
    // Its count: the chosen creature's own (`counts`, worked out at the cast level for its caster: Animate Dead's
    // slot, Animate Objects' spellcasting modifier), else `count`. Below 1, nothing comes.
    const castLevel = Number((state?.configuration as {castingLevel?: number | null} | undefined)?.castingLevel ?? spec.spellLevel) || 0;
    const ref = String(spec.actorRef ?? chosen?.value ?? chosen?.optionId ?? "");
    const byOption = spec.counts?.find(entry => entry.actorRef === ref)?.count;
    const counted = (byOption == null) ? (Number(spec.count) || 1)
      : Math.floor(Number((typeof byOption === "object") ? evaluate(atLevel(byOption, castLevel), {actor: caster, actorSystem: caster.system}).value
        : byOption) || 0);
    if ( counted < 1 ) {
      gmNotice("WILDPATH.NOTICE.SummonNone", {name: definition?.label ?? ""}, undefined, {logger});
      return [];
    }
    const count = Math.min(counted, 20);
    const taken = new Set(occupied);
    const place = (from: Offset, wanted: number) => {
      const found = summonPlacements({start: from, count: wanted, occupied: taken, footprint, allowed,
        adjacent: offset => scene.grid.getAdjacentOffsets(offset)});
      for ( const offset of found ) for ( const cell of footprint(offset) ) taken.add(key(cell));
      return found;
    };
    // Each clicked point is where one creature appears, or the nearest allowed place to it; the rest go near the caster.
    const offsets = (options?.summonPoints ?? []).slice(0, count).flatMap(point => place(scene.grid.getOffset(point), 1));
    offsets.push(...place(start, count - offsets.length));
    const combat = game.combat ?? null;
    const actionId = (definition as {id?: string} | undefined)?.id ?? null;
    const summon: SummonFlag = {casterUuid: caster.uuid, kind: "summon", rounds: Number(spec.rounds) || null,
      createdAt: combat ? {combatId: combat.id, round: combat.round, turn: combat.turn} : null, actionId, at: Date.now(),
      ...(spec.endsWithSummoner ? {endsWithSummoner: true} : {})};
    // At most `limit` of its caster's from this Action (a Steel Defender, two Eldritch Cannons): the oldest go first.
    const limit = (spec.limit && (typeof spec.limit === "object")) ? Number(evaluate(spec.limit, {actor: caster, actorSystem: caster.system}).value)
      : Number(spec.limit);
    if ( limit > 0 ) await dismissPastLimit(caster.uuid, actionId, Math.max(limit - count, 0));
    const data = await Promise.all(offsets.map(async offset => (await base.getTokenDocument({...scene.grid.getTopLeftPoint(offset),
      actorLink: false, disposition: casterToken.disposition ?? 0, flags: {wildpath: {summon}}}, {parent: scene})).toObject()));
    const tokens = await scene.createEmbeddedDocuments("Token", data);
    // Each summon is its caster's: every Player who owns the caster commands it.
    for ( const token of tokens ) if ( token.actor ) await companions.setControllers(token.actor, {controllers: [caster.uuid], kind: "summon"});
    // What it gains with the spell's level: the slot it was cast with, else the spell's own level.
    const level = Number((state?.configuration as {castingLevel?: number | null} | undefined)?.castingLevel ?? spec.spellLevel) || 0;
    // What it gains: a spell's by its level, a feature's by its caster (an artificer's level and Intelligence).
    if ( spec.bonuses || spec.match?.attacks ) for ( const token of tokens ) {
      const bonuses = summonBonusesAt(spec.bonuses ?? {}, level, {actor: caster, actorSystem: caster.system});
      if ( spec.match?.attacks ) bonuses.rules.push(...matchedAttack(caster as unknown as Data, token.actor as unknown as Data));
      await applySummonBonuses(token, bonuses, level);
    }
    // The level it was summoned at, which a spirit's own rules read (its Multiattack: half this spell's level).
    if ( level ) for ( const token of tokens ) {
      await token.actor?.setFlag?.("wildpath", "summonLevel", level);
      await token.actor?.syncItemRecords?.();
    }
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

  /** Its Hit Points and AC on the summoned Token's own Actor, and its damage rules as a feature of it. */
  async function applySummonBonuses(token: SummonToken, bonuses: ReturnType<typeof summonBonusesAt>, level: number) {
    const actor = token.actor;
    if ( !actor?.update ) return;
    const health = actor.system?.resources?.health ?? {};
    const updates: Data = {};
    if ( bonuses.hp ) Object.assign(updates, {"system.resources.health.base": (Number(health.base) || 0) + bonuses.hp,
      "system.resources.health.value": (Number(health.value) || 0) + bonuses.hp});
    // shortcut: a summon whose AC is worked out (not typed) does not gain the bonus; converted creatures' AC is typed.
    const typedAc = actor.system?.defenses?.ac?.value;
    if ( bonuses.ac && (typedAc != null) ) updates["system.defenses.ac.value"] = Number(typedAc) + bonuses.ac;
    if ( Object.keys(updates).length ) await actor.update(updates);
    if ( bonuses.rules.length ) await actor.createEmbeddedDocuments?.("Item", [{type: "feature", img: "icons/svg/upgrade.svg",
      name: game.i18n?.format("WILDPATH.SUMMON.Level", {level: String(level)}) ?? `Level ${level}`,
      system: {active: true, ruleElements: bonuses.rules}}]);
  }

  /** Its caster's summons from one Action, oldest first, beyond the `keep` newest: dismissed. */
  async function dismissPastLimit(casterUuid: string, actionId: string | null, keep: number) {
    const mine = [...(game.scenes ?? [])].flatMap(scene => [...scene.tokens].filter(token => {
      const flag = token.flags?.wildpath?.summon as SummonFlag | undefined;
      return (flag?.casterUuid === casterUuid) && ((flag.actionId ?? null) === actionId);
    }).map(token => ({scene, token, at: Number((token.flags?.wildpath?.summon as SummonFlag).at) || 0}))).sort((a, b) => a.at - b.at);
    for ( const {scene, token} of mine.slice(0, Math.max(mine.length - keep, 0)) ) await dismiss(scene, [token.id]);
  }

  /** Its caster dies (the Dead condition): the summons that go with it (a Homunculus Servant) are dismissed. */
  async function onCasterDead(effect: {statuses?: Iterable<string>; parent?: {uuid?: string} | null}) {
    if ( !isActiveGM() || ![...(effect.statuses ?? [])].includes("dead") || !effect.parent?.uuid ) return;
    for ( const scene of game.scenes ?? [] ) {
      const gone = [...scene.tokens].filter(token => {
        const flag = token.flags?.wildpath?.summon as SummonFlag | undefined;
        return flag?.endsWithSummoner && (flag.casterUuid === effect.parent!.uuid);
      }).map(token => token.id);
      if ( gone.length ) await dismiss(scene, gone);
    }
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

  return {afterResolution, onEffectDeleted, onTurnStart, onCasterDead};
}
