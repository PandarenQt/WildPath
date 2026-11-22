import {createFoundryV14TacticalGridAdapter, foundryOffsetToGridField, gridFieldToFoundryCenterPoint, gridFieldToFoundryOffset}
  from "./foundry-v14-tactical-grid-adapter.mjs";
import {createReachFootprint, fieldDistance, fieldKey, footprintDistance} from "../helpers/grid-footprints.mjs";
import {AREA_SHAPES, suggestLanes, wallSections} from "../helpers/tactical-areas.mjs";
import {rollAmount} from "./foundry-digital-roll-provider.mjs";
import {customEffectId, damageExpressionOf} from "../helpers/action-definitions.mjs";
import {runAuthorityAction} from "./foundry-v14-automation-dispatcher.mjs";
import {difficultTerrainBehavior} from "./foundry-v14-terrain.mjs";
import {combatOf, combatStart, deadCreature, planeOf, roundsPassed} from "./foundry-v14-creature-tokens.mjs";
import type {CombatStart} from "./foundry-v14-creature-tokens.mjs";
import {damageTaken} from "../resolvers/action-pipeline-resolver.mjs";
import {ineligibleTarget} from "./foundry-v14-senses.mjs";
import {AUTOMATION_EVENT_TYPES} from "../helpers/automation-events.mjs";
import {parseEntityRef} from "../helpers/entity-refs.mjs";
import {sharingSpace} from "./foundry-v14-occupancy.mjs";
import {brokenConcentrationTargets} from "../helpers/forced-movement.mjs";
import {areaWallData, cellPolygons, outlineEdges, sectionWallData, segmentOutside, wallSenses} from "./foundry-v14-walls.mjs";
import type {WallSense} from "./foundry-v14-walls.mjs";
import {stepOut} from "./foundry-v14-forced-movement.mjs";
import {gmNotice} from "../helpers/gm-notice.mjs";
import {OBJECT_RULE} from "../helpers/rule-elements.mjs";

type Data = Record<string, unknown>;
interface Field {[key: string]: unknown}
interface Grid {distance: number}
interface Level {elevation?: {bottom?: number | null}}
interface Effect {uuid: string; flags?: {wildpath?: {areaRegion?: {sceneId: string; regionId: string}}}; delete(): Promise<unknown>}
interface Actor {uuid: string; id: string; statuses?: Iterable<string>; createEmbeddedDocuments?(type: string, data: Data[]): Promise<unknown[]>;
  unaffectingRule?(definition: Data, options?: {except?: string[]}): unknown;
  effects?: Iterable<{id: string; system?: {type?: string}; statuses?: Iterable<string>;
    flags?: {wildpath?: {conditionEffect?: {metadata?: {regionId?: string}}}}}>;
  deleteEmbeddedDocuments?(type: string, ids: string[]): Promise<unknown>;
  updateEmbeddedDocuments?(type: string, updates: Data[]): Promise<unknown>}
export interface AreaToken {
  id: string; uuid: string; name?: string; actor: Actor | null; elevation?: number; depth?: number; level?: string | null;
  parent: AreaScene; x?: number; y?: number; width?: number; height?: number; disposition?: number;
  flags?: {wildpath?: {sunlight?: boolean; removed?: unknown; section?: {regionId: string; index: number}}};
  toObject?(): Data;
  update?(data: Data): Promise<unknown>;
}
export interface AreaRegion {
  id: string; flags?: {wildpath?: {area?: AreaFlag}}; parent?: AreaScene | null; levels?: Iterable<string> | null;
  shapes?: Array<{type?: string; offsets?: Data[]}>;
  update(data: Data, operation?: Data): Promise<unknown>;
  delete(): Promise<unknown>;
}
export interface AreaScene {
  id: string; grid: Grid;
  tokens: {get(id: string): AreaToken | undefined} & Iterable<AreaToken>;
  regions?: Iterable<AreaRegion>;
  lights?: {get(id: string): {delete(): Promise<unknown>} | undefined};
  walls?: Iterable<AreaWall>;
  deleteEmbeddedDocuments?(type: string, ids: string[]): Promise<unknown>;
  updateEmbeddedDocuments?(type: string, updates: Data[]): Promise<unknown>;
  levels?: {get(id: string): Level | undefined; keys?(): Iterable<string>};
  createEmbeddedDocuments(type: string, data: Data[]): Promise<unknown[]>;
}
/**
 * A Wall document as the areas read it. `areaRegion`: an area raised it (blocks). An original an opening area hides keeps
 * the Regions opening it (`openedBy`) and its own senses (`senses`); a `pieceOf` wall is part of one, outside those areas.
 */
interface AreaWall {id: string; c?: number[]; door?: number; levels?: Iterable<string> | null; move?: number; sight?: number;
  light?: number; sound?: number; toObject?(): Data;
  flags?: {wildpath?: {areaRegion?: string; section?: number; openedBy?: string[] | null; senses?: Record<WallSense, number> | null;
    pieceOf?: string}}}
/** What a ram reads of its creature: its `occupancy.ram` Modifier and its movement, which the ram spends. */
interface RamActor {getStatistic?(domains: string[]): {totalModifier?: number} | null;
  system?: {resources?: {movement?: {spent?: number; max?: number}}}; update?(data: Data): Promise<unknown>}
interface Combat {id: string; round: number; turn: number | null; scene?: AreaScene | null; started?: boolean;
  combatant?: {id?: string} | null; turns?: Array<{id?: string}> | null;
  combatants?: Iterable<{tokenId?: string | null; sceneId?: string | null}>}
/**
 * `once: "turn"`: once a combat turn on a record of its own, whatever the area's `oncePerTurn` (areas.md "Once per turn");
 * outside combat once while its creature stays in the area (dueRuns).
 * `once: "area"`: once in the area's life, for whichever creatures it first runs on (`applied.area-<index>`).
 * `per`: on `area.moved`, its damage once for every `per` feet moved in the area (Spike Growth's 2d4 per 5 feet).
 * `turnOf: "source"`: its `turn.started` and `turn.ended` are its caster's turn, not the turn of a creature in it (runSourceTriggers).
 */
interface Trigger {on: string[]; action: Data; once?: "turn" | "area" | null; per?: number; turnOf?: "source" | null}
/** A trigger due to act on a creature (dueRuns): its Action (or only what it holds), `count` times. */
interface Run {token: AreaToken & {actor: Actor}; trigger: Trigger; index: number; action: Data; count: number}
export interface AreaFlag {
  schemaVersion: 1;
  actionDefinitionId: string | null; label: string;
  sourceActorRef: string; sourceTokenId: string | null;
  topology: string; fields: Field[]; shape: string; size: number; attached: boolean;
  band: {bottom: number | null; top: number | null};
  persistence: {oncePerTurn: boolean; concentration: boolean; duration: {unit: string; value: number} | null; triggers: Trigger[];
    light?: AreaLight | null; affects?: "enemies" | null; obscures?: Obscurity | null;
    /** It ends once its triggers have dealt this much damage in all (Guardian of Faith's 60). */
    budget?: {damage: number} | null;
    /** `"sourceDies"`: it ends when its caster dies (endWithSource). */
    endsWhen?: "sourceDies" | null;
    /** The senses the walls raised on its outline stop (`move`, `sight`, `light`, `sound`): it stays where it was made. */
    blocks?: string[] | null;
    /** Its fields as object sections, `size` feet each, each a Token of one Actor with this AC, HP and rules (raiseSections). */
    sections?: Sections | null;
    /** `"open"`: the walls under it are hidden while it lasts, standing only outside it (syncOpenedWalls). */
    walls?: "open" | null;
    /** An attached area also covers the Token it surrounds (Antimagic Field's caster), wherever it steps (areaCovers). */
    includesAnchor?: boolean | null};
  /** The damage its triggers have dealt so far, for a `budget`. */
  dealt?: number;
  /** Its space is Difficult Terrain (Web, Spike Growth), of these kinds (`web`, `ice`): its Region's movement cost. */
  difficultTerrain?: {types: string[]} | null;
  createdAt: CombatStart | null;
  applied: Record<string, string>;
  /** The caster's concentration marker, for a concentration area (its uuid). */
  concentrationEffect?: string | null;
  /** The ambient light the area sheds (its id on the Scene). */
  lightId?: string | null;
  /** The Token whose own light the area sheds while it lasts, and that light as it was before. */
  lightToken?: {id: string; previous: {light: Data | null; sunlight: boolean}} | null;
  /** The Token an attached area surrounds and follows, when not its caster's (Daylight cast on an object). */
  anchorTokenId?: string | null;
  /** The level the spell was cast at, for spells that end it (Daylight ends Darkness of level 3 or lower). */
  castLevel?: number | null;
  /** The world Actor its sections' Tokens stand for (`persistence.sections`), deleted with it. */
  sectionActorId?: string | null;
  /** The area an opened section of it left this one in (`sections.leaves`): each ends with the other (leaveBehind). */
  parentRegionId?: string | null;
  /** An opening laid out for the GM to confirm (`opens`): seen by the GM only, answering nothing and opening no walls. */
  pending?: boolean | null;
  /** Its depth in feet (`persistence.depth`, or an opening's rolled `opens.depth`): how far a `fall` with no feet drops into it. */
  depth?: number | null;
}
/** A GM card's roll entry for an Action's `opens` (gm-prompts): the openings, the area that ran it, and the Action's own. */
interface OpeningsEntry {opens: {label?: string; count: unknown; depth: unknown; width?: {value?: number}; persistence: Data};
  parentArea: ParentArea; actionId: string; name: string; tags?: string[] | null}
/** The lasting area whose trigger ran an Action, as it stood then (parentAreaOf). */
export interface ParentArea {sceneId: string; regionId: string; topology: string; fields: Field[]; castLevel: number | null; depth?: number}
/** `leaves`: a lasting area's persistence each opened section leaves in its space (Wall of Ice's Frigid Air; leaveBehind). */
interface Sections {size: number; ac: number; hp: number; ruleElements?: Data[]; leaves?: Data | null; img?: string}
/** A section Token's image when its `sections` names none: a standing object, not Foundry's creature silhouette. */
export const OBJECT_IMG = "icons/svg/obelisk.svg";
/**
 * The Region colours of an area made from another (an `opens` opening, a `sections.leaves` child), fixed rather than the
 * casting user's, so it never looks like its parent: `pending` while laid out for the GM's Open, `derived` once in effect.
 */
export const DERIVED_AREA_COLORS = Object.freeze({pending: "#ffd21f", derived: "#e0561b"});
interface SectionActor {id: string; getTokenDocument(data: Data, options: {parent: unknown}): Promise<{toObject(): Data}>}

/**
 * An object's world Actor (an area's sections, a statue, a crate): an `npc` of threat 0 with its AC and Hit Points typed,
 * and one feature carrying the object rule (`OBJECT_RULE`) and its own rules (Wall of Ice's Immunity to Cold, Vulnerability
 * to Fire). An unlinked Token of it keeps its own Hit Points; at 0 it dies, as any npc does.
 */
export function objectActorData(object: {ac: number; hp: number; ruleElements?: Data[]; img?: string}, label: string) {
  // shortcut: a definition cannot drop the object rule (the GM can, on the Actor); upgrade if Q141's answer wants that.
  const img = object.img || OBJECT_IMG;
  return {name: label, type: "npc", img,
    system: {details: {threat: 0}, defenses: {ac: {value: object.ac}},
      resources: {health: {base: object.hp, value: object.hp}}},
    prototypeToken: {actorLink: false, disposition: (globalThis as {CONST?: {TOKEN_DISPOSITIONS?: {NEUTRAL: number}}}).CONST
      ?.TOKEN_DISPOSITIONS?.NEUTRAL ?? 0, texture: {src: img}},
    items: [{type: "feature", name: label, system: {active: true, ruleElements: [structuredClone(OBJECT_RULE),
      ...structuredClone(object.ruleElements ?? [])]}}]};
}

/**
 * Where a section's Token stands and its size in squares: over the whole section when its fields fill a rectangle (a
 * straight 10-foot section on a 5-foot grid is 2x1 or 1x2), else 1x1 on its first field (a diagonal one).
 */
export function sectionTokenPlacement(scene: {grid: {getTopLeftPoint(offset: unknown): {x: number; y: number}}}, fields: readonly Field[]) {
  const points = fields.map(field => scene.grid.getTopLeftPoint(toOffset(field, {grid: scene.grid}).offset));
  const xs = [...new Set(points.map(point => point.x))];
  const ys = [...new Set(points.map(point => point.y))];
  return (xs.length * ys.length === points.length)
    ? {x: Math.min(...xs), y: Math.min(...ys), width: xs.length, height: ys.length}
    : {...points[0]!, width: 1, height: 1};
}
/** A sectioned area's fields, section by section (`ceil(size / grid distance)` fields each, wallSections). */
const sectionFields = (flag: AreaFlag, sections: Sections, scene: AreaScene) => wallSections(flag.fields,
  Math.ceil(Number(sections.size) / (Number(scene.grid.distance) || 5))) as Field[][];
/**
 * The light a lasting area sheds from its center, in the Scene's units: Daylight's is bright 60, dim 120, sunlight;
 * Darkness's is darkness. `dispels` ends overlapping areas of the opposite kind cast at that level or lower;
 * `spellLevel` is the spell's own level, when the cast level is not known.
 */
interface AreaLight {bright?: number; dim?: number; sunlight?: boolean; darkness?: boolean; dispels?: number; spellLevel?: number}

/** The Token an attached area surrounds and follows: the object it was cast on, else its caster. */
const anchorOf = (flag: AreaFlag) => flag.anchorTokenId ?? flag.sourceTokenId;
interface Placement {footprint: {topology: string; fields: Field[]}; definition: Data; sourceTokenId: string; sceneId: string}

export const AREA_EVENTS = Object.freeze({CREATED: "area.created", ENTERED: "area.entered", EXITED: "area.exited", MOVED: "area.moved",
  RAMMED: "area.rammed", TURN_STARTED: "turn.started", TURN_ENDED: "turn.ended"});
const TURN_EVENTS: readonly string[] = [AREA_EVENTS.TURN_STARTED, AREA_EVENTS.TURN_ENDED];
const selfTargeted = (action: Data) => (action.targeting as Data | undefined)?.type === "self";
/**
 * A trigger's action with its damage `count` times over, in one roll: 2d4 three times is 6d4. Any other expression
 * (dice counted or bonused by an expression, a constant, a sum) is added to itself.
 */
const repeatedDamage = (action: Data, count: number) => ((count === 1) ? action : {...action,
  damage: ((action.damage ?? []) as Data[]).map(part => {
    const expression = damageExpressionOf(part) as Data | null;
    const dice = expression?.number ?? expression?.count ?? 1;
    const plain = (expression?.type === "dice") && (typeof dice === "number")
      && ((expression.bonus == null) || (typeof expression.bonus === "number"));
    return {...part, expression: plain
      ? {...expression, number: count * dice, ...((expression.bonus == null) ? {} : {bonus: count * (expression.bonus as number)})}
      : {type: "add", terms: Array.from({length: count}, () => expression)}};
  })});
/** An effect its trigger gives only while its creature is in the area (`metadata.endsWhen: "leavesArea"`: Web's Restrained). */
const leavesArea = (effect: Data) => (effect.metadata as Data | undefined)?.endsWhen === "leavesArea";
/**
 * Its Action with only what it gives while in the area whatever a save does (Spirit Guardians' Half Speed: `leavesArea`, no
 * outcome policy), else null. That is on every creature in the area: given again on each entering, though once a turn has
 * spent the save and damage, and as the area appears around it.
 */
const heldOnly = (action: Data) => {
  const gated = (effect: Data) => (effect.saveOutcomePolicy ?? effect.savePolicy ?? effect.checkOutcomePolicy
    ?? (effect.application as Data | undefined)?.saveOutcomePolicy) != null;
  const effects = ((action.effects ?? []) as Data[]).filter(effect => leavesArea(effect) && !gated(effect));
  return (effects.length && !action.attack) ? {schemaVersion: action.schemaVersion, id: action.id, label: action.label,
    costs: {allOf: []}, ...(action.tags ? {tags: action.tags} : {}), effects} : null;
};
/** An area that affects only its caster's enemies (Spirit Guardians) leaves the caster and its side alone. */
function spares(flag: AreaFlag, token: AreaToken) {
  const caster = flag.sourceTokenId ? token.parent.tokens.get(flag.sourceTokenId) : null;
  return (flag.persistence.affects === "enemies") && (!caster || (caster.id === token.id) || (caster.disposition === token.disposition));
}
/**
 * Whether an area's trigger may act on a creature, on every event: not one its rules leave untouched by the area's spell
 * (`Unaffected`; its caster's own excepted), nor one the trigger's `targeting.eligible` leaves out, judged with the caster
 * as source (2024 Conjure Animals' "a creature you can see": `seenBySource`, Q30), nor one on another plane than its
 * caster (an Ethereal one, a Trapped prisoner's hidden Token; planeOf), which the authority would leave out of the run
 * anyway, leaving it an empty target prompt. `except`: ids of the creature's effects whose rules count for nothing here
 * (release: what the area it leaves gave it, which is going).
 */
function reaches(flag: AreaFlag, trigger: Trigger, token: AreaToken, except: string[] = []) {
  const caster = flag.sourceTokenId ? token.parent.tokens.get(flag.sourceTokenId) : null;
  // shortcut: no exception for a creature its caster holds there (`targeting.sourceCondition`, the runtime's heldThere): an
  // area trigger never carries one to the authority (runAuthorityAction sets its own targeting); add both when one must.
  return (planeOf(token.actor) === planeOf(caster?.actor))
    && !((token.actor?.uuid !== flag.sourceActorRef) && token.actor?.unaffectingRule?.(trigger.action, {except}))
    && !ineligibleTarget((trigger.action.targeting as Data | undefined)?.eligible, token as never, caster as never);
}
const releases = (flag: AreaFlag) => flag.persistence.triggers.some(trigger => ((trigger.action.effects ?? []) as Data[]).some(leavesArea));
/** Whether an area answers `event`: a trigger on it, or for leaving, effects that end on leaving (release). */
const answers = (flag: AreaFlag, event: string) => flag.persistence.triggers.some(trigger => trigger.on.includes(event))
  || ((event === AREA_EVENTS.EXITED) && releases(flag));
/**
 * Its trigger's Action, each effect that ends on leaving naming its Region (`metadata.regionId`), so release finds it.
 * A condition is its own instance per source (Q19), so the webs' Restrained is stamped beside a Net's and leaving ends only
 * the webs'. A custom effect is still one effect (Q93 (d)): applied again it refreshes the one its creature holds, known
 * by its status, its custom id (it has no condition type, so any other custom effect would otherwise look like it), and
 * keeps that one's stamp: none when given from elsewhere, another area's when held from it (two Antimagic Fields
 * overlapping), which hands it over on leaving (release).
 */
const stamped = (action: Data, region: AreaRegion, actor: Actor) => {
  const regionOf = (effect: Data) => {
    const held = (effect.type === "effect") ? [...(actor.effects ?? [])].find(held =>
      [...(held.statuses ?? [])].includes(customEffectId(String(action.id), effect))) : undefined;
    return held ? held.flags?.wildpath?.conditionEffect?.metadata?.regionId : region.id;
  };
  return ((action.effects ?? []) as Data[]).some(leavesArea) ? {...action, effects: (action.effects as Data[]).map(effect => {
    const regionId = leavesArea(effect) ? regionOf(effect) : null;
    return regionId ? {...effect, metadata: {...(effect.metadata as Data), regionId}} : effect;
  })} : action;
};
const reachFootprint = createReachFootprint as unknown as (options: Data) => {fields: Field[]};
const keyOf = fieldKey as unknown as (field: Field, topology?: string) => string;
const distanceOf = fieldDistance as unknown as (a: Field, b: Field, topology?: string) => number;
const toOffset = gridFieldToFoundryOffset as unknown as (field: Field, options: {grid: unknown}) => {offset?: Data};
const laneFields = suggestLanes as unknown as (options: {fields: Field[]; topology: string; gridDistance: number; width: number;
  count: number; cost(field: Field): number}) => Field[][];
const toCenter = gridFieldToFoundryCenterPoint as unknown as (field: Field, options: {scene: unknown; grid: unknown}) => {point?: {x: number; y: number}};

/**
 * A lasting area is a Foundry Region (V14's template successor) whose `flags.wildpath.area` holds the rules:
 * the covered fields, the caster, the vertical band and the triggers. Foundry draws the exact fields as a
 * `grid` shape and keeps an emanation's Region attached to its caster's Token; WildPath decides who is inside.
 */
export function persistentAreaRegionData({placement, sourceToken, combat, color}: {
  placement: Placement; sourceToken: AreaToken; combat: Combat | null; color?: unknown;
}) {
  const definition = placement.definition as {id?: string; label?: string; area?: {shape?: string; size?: {value?: number};
    persistence?: Data}};
  const area = definition.area ?? {};
  const persistence = (area.persistence ?? {}) as {oncePerTurn?: boolean; concentration?: boolean;
    duration?: {unit: string; value: number}; elevation?: {bottom?: number | null; top?: number | null}; triggers?: Trigger[];
    light?: AreaLight; affects?: string; difficultTerrain?: {types?: string[]}; obscures?: string; budget?: {damage?: number};
    endsWhen?: string; blocks?: string[]; sections?: Sections; walls?: string; includesAnchor?: boolean; depth?: number};
  const scene = sourceToken.parent;
  // Bands are authored relative to the floor of the caster's Level; a missing bound is open.
  const floor = Number(scene.levels?.get(String(sourceToken.level))?.elevation?.bottom) || 0;
  const bound = (value: number | null | undefined) => (value === null) || (value === undefined) ? null : floor + Number(value);
  const band = {bottom: bound(persistence.elevation?.bottom), top: bound(persistence.elevation?.top)};
  const attached = area.shape === AREA_SHAPES.EMANATION;
  const offsets = placement.footprint.fields.map(field => toOffset(field, {grid: scene.grid}).offset).filter(Boolean);
  const flag: AreaFlag = {
    schemaVersion: 1,
    actionDefinitionId: definition.id ?? null, label: definition.label ?? "Area",
    sourceActorRef: sourceToken.actor?.uuid ?? "", sourceTokenId: sourceToken.id,
    topology: placement.footprint.topology, fields: placement.footprint.fields, shape: String(area.shape),
    size: Number(area.size?.value) || 0, attached, band,
    persistence: {oncePerTurn: persistence.oncePerTurn !== false, concentration: persistence.concentration === true,
      duration: persistence.duration ?? null, triggers: persistence.triggers ?? [], light: persistence.light ?? null,
      ...(persistence.affects === "enemies" ? {affects: "enemies" as const} : {}),
      ...(OBSCURITIES.includes(persistence.obscures as Obscurity) ? {obscures: persistence.obscures as Obscurity} : {}),
      ...(persistence.budget ? {budget: {damage: Number(persistence.budget.damage) || 0}} : {}),
      ...(persistence.endsWhen === "sourceDies" ? {endsWhen: "sourceDies" as const} : {}),
      ...(persistence.blocks?.length ? {blocks: [...persistence.blocks]} : {}),
      ...(persistence.sections ? {sections: structuredClone(persistence.sections)} : {}),
      ...(persistence.walls === "open" ? {walls: "open" as const} : {}),
      ...(persistence.includesAnchor === true ? {includesAnchor: true} : {})},
    createdAt: combatStart(combat),
    applied: {},
    // How deep it is (a pit's floor), for a `fall` with no feet that its trigger runs; an opening's rolled depth replaces it.
    ...((Number(persistence.depth) > 0) ? {depth: Number(persistence.depth)} : {}),
    ...(persistence.difficultTerrain ? {difficultTerrain: {types: [...(persistence.difficultTerrain.types ?? [])]}} : {})
  };
  return {
    name: flag.label,
    ...(color === undefined ? {} : {color}),
    shapes: [{type: "grid", offsets}],
    // Difficult Terrain costs its movement twice over (foundry-v14-terrain.mts); Foundry's ruler shows that too.
    ...(flag.difficultTerrain ? {behaviors: [difficultTerrainBehavior()]} : {}),
    elevation: {bottom: band.bottom, top: band.top},
    ...(sourceToken.level ? {levels: [sourceToken.level]} : {}),
    attachment: {token: attached ? sourceToken.id : null},
    // Everyone sees a known hazard; V14's default would show it only on the Regions layer.
    visibility: (globalThis as {CONST?: {REGION_VISIBILITY?: {ALWAYS?: number}}}).CONST?.REGION_VISIBILITY?.ALWAYS ?? 2,
    highlightMode: "coverage",
    flags: {wildpath: {area: flag}}
  };
}

/**
 * The fields an area covers: an emanation is recomputed around its caster's footprint, now or at `position`
 * (where a step takes it).
 */
export function areaFields(flag: AreaFlag, scene: AreaScene, {position=null}: {position?: Data | null}={}): Field[] {
  if ( !flag.attached ) return flag.fields;
  const anchor = anchorOf(flag);
  const caster = anchor ? scene.tokens.get(anchor) : null;
  if ( !caster ) return [];
  const footprint = createFoundryV14TacticalGridAdapter({scene}).tokenToFootprint(caster, position ? {position} : {}) as {
    ok: boolean; footprint?: Data};
  if ( !footprint.ok || !footprint.footprint ) return [];
  return reachFootprint({source: footprint.footprint, reachDistance: flag.size, gridDistance: scene.grid.distance}).fields;
}

/** Whether a Token stands in an area: any of its fields is covered and its height overlaps the area's band. */
export function areaCovers(flag: AreaFlag, token: AreaToken, {fields=null, position=null}: {fields?: Field[] | null; position?: Data | null}={}) {
  // An emanation surrounds its caster (or object), outside it unless it `includesAnchor`: then inside wherever it steps.
  if ( (token.id === anchorOf(flag)) && flag.attached ) return flag.persistence?.includesAnchor === true;
  const scene = token.parent;
  const covered = new Set((fields ?? areaFields(flag, scene)).map(field => keyOf(field, flag.topology)));
  if ( !covered.size ) return false;
  const adapter = createFoundryV14TacticalGridAdapter({scene});
  const footprint = adapter.tokenToFootprint(token, position ? {position} : {}) as {ok: boolean; footprint?: {fields: Field[]}};
  if ( !footprint.ok || !footprint.footprint?.fields.some(field => covered.has(keyOf(field, flag.topology))) ) return false;
  const feet = Number((position as {elevation?: number} | null)?.elevation ?? token.elevation ?? 0);
  const head = feet + ((Number(token.depth) || 0) * scene.grid.distance);
  return ((flag.band.bottom === null) || (head >= flag.band.bottom)) && ((flag.band.top === null) || (feet <= flag.band.top));
}

/** Every lasting area on a Scene, with its Region. */
/** The center of an area's fields, in pixels; null when none resolve. */
function areaCenter(flag: AreaFlag, scene: AreaScene) {
  const points = flag.fields.map(field => toCenter(field, {scene, grid: scene.grid}).point).filter(Boolean) as Array<{x: number; y: number}>;
  if ( !points.length ) return null;
  return {x: points.reduce((sum, point) => sum + point.x, 0) / points.length, y: points.reduce((sum, point) => sum + point.y, 0) / points.length};
}

/** The Token standing on a point (its rectangle holds it), or null. */
function tokenAt(scene: AreaScene, point: {x: number; y: number} | null) {
  const size = Number((scene.grid as {size?: number}).size) || 100;
  if ( !point ) return null;
  return [...scene.tokens].find(token => {
    const [x, y] = [Number(token.x) || 0, Number(token.y) || 0];
    return (point.x >= x) && (point.x < x + ((Number(token.width) || 1) * size)) && (point.y >= y) && (point.y < y + ((Number(token.height) || 1) * size));
  }) ?? null;
}

/** How obscured a place is, the strongest first. */
export type Obscurity = "heavily" | "lightly";
export const OBSCURITIES: readonly Obscurity[] = Object.freeze(["heavily", "lightly"]);

/** The most a lasting area a Token stands in obscures it (Fog Cloud "heavily", Web "lightly"), or null. */
export function areaObscurityAt(token: AreaToken | null | undefined): Obscurity | null {
  if ( !token?.parent ) return null;
  const levels = new Set(sceneAreas(token.parent).filter(({flag}) => flag.persistence?.obscures && areaCovers(flag, token))
    .map(({flag}) => flag.persistence.obscures));
  return OBSCURITIES.find(level => levels.has(level)) ?? null;
}

/** Whether a Token stands in a Heavily Obscured lasting area (Fog Cloud, Cloudkill): no sight sees it, or out. */
export function heavilyObscuredAt(token: AreaToken | null | undefined) {
  return areaObscurityAt(token) === "heavily";
}

/**
 * Whether a Token carries `flags.wildpath.removed`: the removed adapter hid it while a `removes` status held its
 * creature, and keeps the marker until its release has placed it. It enters and moves in no area meanwhile (nor does
 * a dragged hidden prisoner), so reappearing calls for no save; leaving is still processed, so an effect held only
 * while in an area (`leavesArea`) is released.
 */
function removedMarker(token: AreaToken) {
  return Boolean(token.flags?.wildpath?.removed);
}

export function sceneAreas(scene: AreaScene) {
  return [...(scene.regions ?? [])].flatMap(region => region.flags?.wildpath?.area ? [{region, flag: region.flags.wildpath.area}] : []);
}

/** The lasting area a creature (`actorRef`) left with the Action `of` (its definition id), on `scene`; null when none. */
export function ownArea(scene: AreaScene, {of, actorRef}: {of: string; actorRef: string}) {
  return sceneAreas(scene).find(({flag}) => (flag.actionDefinitionId === of) && (flag.sourceActorRef === actorRef)) ?? null;
}

/**
 * The lasting areas of spells (their cast level known) that reach within `feet` of a Token's space: what Dispel Magic
 * can choose as its "magical effect". Measured as targets are, between the nearest spaces.
 */
export function spellAreasWithin(token: AreaToken, feet: number) {
  const scene = token.parent;
  const footprint = createFoundryV14TacticalGridAdapter({scene}).tokenToFootprint(token) as {ok: boolean;
    footprint?: {topology: string; fields: Field[]}};
  if ( !footprint.ok || !footprint.footprint ) return [];
  const grid = Number(scene.grid.distance) || 5;
  return sceneAreas(scene).filter(({flag}) => Number.isFinite(flag.castLevel ?? NaN) && (areaFields(flag, scene).length > 0)
    && ((footprintDistance(footprint.footprint, {topology: flag.topology, fields: areaFields(flag, scene)}) * grid) <= feet));
}

/** Where a placed area's fields are centered, in canvas coordinates; null with no fields. */
export function areaFieldsCenter(fields: Field[], scene: AreaScene) {
  return areaCenter({fields} as AreaFlag, scene);
}

/**
 * Whether an area's duration has run out at the start of this combat turn: N rounds after the turn it was
 * created on. Outside combat, or in another combat, rounds do not pass.
 */
export function areaExpired(flag: AreaFlag, combat: Combat | null | undefined) {
  return roundsPassed(flag.createdAt, Number(flag.persistence.duration?.value), combat);
}

/**
 * The lasting area whose trigger runs an Action (`parentArea`), as the authority reads it when the Action starts, so the
 * Action's follow-ups find it though it has ended since: its fields (an emanation's where it stands now), the level it was
 * cast at and, for an opening, its depth. Null when it is gone.
 */
export function parentAreaOf(scene: AreaScene | null | undefined, regionId: string): ParentArea | null {
  const flag = [...(scene?.regions ?? [])].find(region => region.id === regionId)?.flags?.wildpath?.area;
  if ( !scene || !flag ) return null;
  return {sceneId: scene.id, regionId, topology: flag.topology, fields: areaFields(flag, scene), castLevel: flag.castLevel ?? null,
    ...((Number(flag.depth) > 0) ? {depth: Number(flag.depth)} : {})};
}

/** A once-per-turn key: the current combat turn, or null outside combat (no limit). */
export function turnKey(combat: Combat | null | undefined) {
  return combat ? `${combat.id}:${combat.round}:${combat.turn ?? 0}` : null;
}

/**
 * Applies a lasting area's triggers to a creature. Each trigger's Action resolves through the authority with
 * the caster as source and the creature as its only target (saves route to the creature's controller, as for
 * any Action). Once per turn by default: the area remembers whom it affected in the current combat turn.
 */
export function createFoundryPersistentAreas({game, coordinator, resolveAction, logger=globalThis.console, fromUuid=null,
  dismissSummon=null}: {
  game: {user: {id: string; color?: unknown}; combat?: Combat | null; combats?: Iterable<Combat>;
    scenes?: {get(id: string): AreaScene | undefined} & Iterable<AreaScene>;
    i18n?: {format(key: string, data: Data): string}; users?: {activeGM?: {id: string} | null};
    actors?: {get(id: string): {delete(): Promise<unknown>} | undefined}};
  fromUuid?: ((uuid: string) => unknown) | null;
  coordinator: {resolveAuthorityAction(options: Data): Promise<{ok: boolean; state?: {status?: string}}>};
  resolveAction(options: Data): Promise<Data & {ok: boolean; reason?: string}>;
  logger?: {warn(...args: unknown[]): void};
  /** Dismisses a summon's cast (the summons adapter's), for a carried area whose spell ends (end). */
  dismissSummon?: ((scene: AreaScene, tokenIds: string[]) => Promise<unknown>) | null;
}) {
  let sequence = 0;
  // Each budget area's spend in flight (apply), so two never read its dealt damage at once.
  const spending = new Map<string, Promise<unknown>>();
  // Each Scene's wall opening in flight (syncOpenedWalls): Regions ended in one batch fire their delete hooks unawaited,
  // and two runs at once would delete the same pieces twice.
  const opening = new Map<string, Promise<unknown>>();

  async function create({options, state}: {options: {persistentArea?: Placement; source?: {tokenId?: string | null}; actor?: unknown};
    state?: {configuration?: {castingLevel?: number | null; choices?: Array<{id?: string; value?: unknown}>;
      effectiveDefinition?: Placement["definition"] | null} | null}}, {anchor=null, pending=null}: {anchor?: AreaToken | null;
      pending?: {depth: number} | null}={}) {
    // The area as cast: its configured definition, so an upcast's dice stay in its triggers for its whole life.
    const placement = options.persistentArea && state?.configuration?.effectiveDefinition
      ? {...options.persistentArea, definition: state.configuration.effectiveDefinition} : options.persistentArea;
    if ( !placement ) return null;
    const token = game.scenes?.get(placement.sceneId)?.tokens.get(placement.sourceTokenId) ?? null;
    if ( !token ) return null;
    // Its caster's combat, not the one the GM's tracker shows: its rounds pass there (onTurn).
    // shortcut: a caster that is no Combatant counts rounds in the tracker's combat; upgrade with the turn-clock question.
    const data = persistentAreaRegionData({placement, sourceToken: token, combat: combatOf(token, game) ?? game.combat ?? null,
      color: pending ? DERIVED_AREA_COLORS.pending : game.user.color});
    const flag = data.flags.wildpath.area;
    const persistence = ((placement.definition.area as Data | undefined)?.persistence ?? {}) as {onObject?: string; dispellable?: boolean};
    // A spell's, so Dispel Magic can end it: the level it was cast at, else its own. `dispellable: false` keeps no level,
    // so Dispel Magic never lists it and no light dispels it (Antimagic Field, a fissure).
    const spellLevel = Number((placement.definition.metadata as {spellLevel?: unknown} | undefined)?.spellLevel);
    flag.castLevel = (persistence.dispellable === false) ? null : state?.configuration?.castingLevel ?? flag.persistence.light?.spellLevel
      ?? (Number.isFinite(spellLevel) ? spellLevel : null);
    // Cast on an object (Daylight, Darkness): the area surrounds the Token at its center and goes where it goes.
    const chosen = persistence.onObject && (state?.configuration?.choices ?? []).some(choice => (choice.id === persistence.onObject)
      && (choice.value === true));
    const object = anchor ?? (chosen ? tokenAt(token.parent, areaCenter(flag, token.parent)) : null);
    if ( object ) Object.assign(flag, {attached: true, anchorTokenId: object.id}), data.attachment = {token: object.id};
    // An opening laid out for the GM to confirm or drag (rollOpenings): seen by the GM only and nothing more until Open.
    if ( pending ) {
      Object.assign(flag, {pending: true, depth: pending.depth});
      data.visibility = (globalThis as {CONST?: {REGION_VISIBILITY?: {GAMEMASTER?: number}}}).CONST?.REGION_VISIBILITY?.GAMEMASTER ?? 1;
    }
    return createRegion(token, data, placement.definition);
  }

  /**
   * A lasting area's Region made from its data (create; leaveBehind for what an opened section leaves), coming into effect
   * at once (appear) unless it is a pending opening, which comes into effect at its Open (openOpenings).
   */
  async function createRegion(token: AreaToken, data: ReturnType<typeof persistentAreaRegionData>, definition: Placement["definition"]) {
    const flag = data.flags.wildpath.area;
    if ( !flag.pending ) await dispelOpposed(token.parent, flag);
    const [region] = await token.parent.createEmbeddedDocuments("Region", [data]) as AreaRegion[];
    if ( !region ) return null;
    return flag.pending ? region : appear(region, token, flag, definition);
  }

  /**
   * What a lasting area brings as it comes into effect: its concentration, light, walls, held effects on the creatures it
   * appears around, its `area.created` triggers (answerCreated), and its once-only caster-turn triggers outside combat.
   * shortcut: a pending opening's Difficult Terrain and obscuring already hold before its Open; upgrade if an opening that
   * slows or hides must wait for it.
   */
  async function appear(region: AreaRegion, token: AreaToken, flag: AreaFlag, definition: Data) {
    if ( flag.persistence.concentration ) await markConcentration(region, token, flag.label);
    const light = flag.persistence.light;
    if ( light ) await shedLight(region, token.parent, flag, light);
    if ( flag.persistence.blocks ) await raiseWalls(region, token, flag, definition);
    if ( flag.persistence.walls === "open" ) await syncOpenedWalls(region);
    // What it holds while in it whatever the save is on each creature it appears around (heldOnly: Spirit Guardians' Half Speed).
    if ( flag.persistence.triggers.some(trigger => trigger.on.includes(AREA_EVENTS.ENTERED) && heldOnly(trigger.action)) ) {
      for ( const covered of [...token.parent.tokens].filter(entry => areaCovers(flag, entry)) ) {
        await apply(region, region.flags?.wildpath?.area ?? flag, covered, AREA_EVENTS.ENTERED, {key: null, appearing: true});
      }
    }
    await answerCreated(region);
    // A caster with no combat turn to wait for (outside combat, or no Combatant): what its area does once on that turn
    // (`once: "area"`) it does now; a repeating caster-turn trigger waits for combat, as other turn triggers do.
    if ( !combatOf(token, game) && flag.persistence.triggers.some(trigger => (trigger.turnOf === "source") && (trigger.once === "area")) ) {
      for ( const event of TURN_EVENTS ) await runSourceTriggers(event, token, null, {region, creating: true});
    }
    return region;
  }

  /**
   * An area coming into effect answers `area.created` (a fissure's save as it opens): each such trigger once, as one Action
   * on the creatures it covers then (runGroup), with no cover against it (Q37) and itself as the Action's `parentArea`. A
   * creature removed from the scene is not in it.
   */
  async function answerCreated(region: AreaRegion) {
    const flag = region.flags?.wildpath?.area;
    const scene = region.parent;
    if ( !flag || !scene || !answers(flag, AREA_EVENTS.CREATED) ) return [];
    const covered = [...scene.tokens].filter(token => !removedMarker(token) && areaCovers(flag, token));
    const runs = await dueRuns(region, flag, covered, AREA_EVENTS.CREATED);
    const states: unknown[] = [];
    for ( const [index, trigger] of flag.persistence.triggers.entries() ) {
      const group = runs.filter(run => run.index === index);
      if ( group.length ) states.push(...await runGroup(region, flag, trigger, index, group, "created"));
    }
    if ( runs.length ) await charge(region, flag, states.filter(Boolean));
    return states;
  }

  /**
   * A GM card's roll entry for an Action's `opens` (gm-prompts): the count, then each opening's depth, rolled by the dice
   * policy on the active GM (the GM rolls them, Q140 (3) default); the openings laid across the area that ran the Action
   * (`parentArea`, as it stood then) in lanes (suggestLanes), each field scored by the original walls crossing it (walls
   * stand in for the structures the openings keep off, as far as the map shows them); and each made a pending area of the
   * Action's caster (create): seen by the GM only, answering nothing and opening no walls, which the GM may drag or redraw
   * until Open (Q92 (b)). Null, with nothing written, when a die is closed unrolled or the caster's Token is gone (a
   * failed creation deletes what it made). None laid (no band fits, or a count of 0): the GM is told.
   * shortcut: every original wall on the Scene is scored, whatever its Level; upgrade if a multi-Level Scene's walls skew it.
   */
  async function rollOpenings(entry: OpeningsEntry, card: {sceneId: string; sourceTokenId: string}) {
    const scene = game.scenes?.get(card.sceneId);
    const caster = scene?.tokens.get(card.sourceTokenId);
    if ( !scene || !caster?.actor ) {
      gmNotice("WILDPATH.NOTICE.OpensNoCaster", {name: entry.name}, undefined, {game, logger});
      return null;
    }
    const {opens, parentArea} = entry;
    const title = (key: string) => game.i18n?.format(key, {label: entry.name}) ?? entry.name;
    const context = {actor: caster.actor, actorSystem: (caster.actor as {system?: unknown}).system};
    const count = await rollAmount(opens.count as never, context, title("WILDPATH.OPENS.Count"), {game});
    if ( !count ) return null;
    const originals = [...(scene.walls ?? [])].filter(wall => Array.isArray(wall.c) && !wall.flags?.wildpath?.areaRegion
      && !wall.flags?.wildpath?.pieceOf);
    // Each cell grown a pixel, so a wall drawn on its grid line (as walls snap) counts for the cells on both sides of it.
    const cost = (field: Field) => {
      const cell = cellPolygons(scene as never, [field]).map(polygon => {
        const [cx, cy] = ["x", "y"].map(axis => polygon.reduce((sum, point) => sum + point[axis as "x" | "y"], 0) / polygon.length) as [number, number];
        return polygon.map(({x, y}) => {
          const away = Math.hypot(x - cx, y - cy) || 1;
          return {x: x + ((x - cx) / away), y: y + ((y - cy) / away)};
        });
      });
      return originals.filter(wall => segmentOutside(wall.c!, cell)[0] !== wall.c).length;
    };
    const lanes = laneFields({fields: parentArea.fields, topology: parentArea.topology, gridDistance: scene.grid.distance,
      width: Number(opens.width?.value), count: count.total, cost});
    const depths: number[] = [];
    for ( const _lane of lanes ) {
      const depth = await rollAmount(opens.depth as never, context, title("WILDPATH.OPENS.Depth"), {game});
      if ( !depth ) return null;
      depths.push(depth.total);
    }
    const definition = {id: `${entry.actionId}:opens`, label: entry.name, ...(entry.tags?.length ? {tags: [...entry.tags]} : {}),
      area: {shape: AREA_SHAPES.LINE, persistence: opens.persistence}};
    const made: AreaRegion[] = [];
    try {
      for ( const [index, fields] of lanes.entries() ) {
        const region = await create({options: {persistentArea: {footprint: {topology: parentArea.topology, fields}, definition,
          sourceTokenId: caster.id, sceneId: scene.id}}, state: {configuration: {castingLevel: parentArea.castLevel ?? null}}},
          {pending: {depth: depths[index]!}});
        if ( region ) made.push(region);
      }
    } catch (error) {
      // Released, the roll lays a whole set again: the part already made, which no Open entry names, goes.
      for ( const region of made ) await region.delete();
      throw error;
    }
    if ( !made.length ) gmNotice("WILDPATH.NOTICE.OpensNone", {name: entry.name}, undefined, {game, logger});
    return {regionIds: made.map(region => region.id), definition, count: count.total, depths};
  }

  /**
   * A GM card's Open entry: each pending area its roll laid out that still stands (the GM may have deleted one) comes into
   * effect as any lasting area does (appear): seen by everyone, the walls under it opened, its `area.created` triggers
   * answered (a fissure's save, one Action over the creatures in it then). Null when the caster's Token is gone.
   */
  async function openOpenings(entry: {regionIds?: string[]; definition?: Data}, card: {sceneId: string; sourceTokenId: string}) {
    const scene = game.scenes?.get(card.sceneId);
    const caster = scene?.tokens.get(card.sourceTokenId);
    if ( !scene || !caster ) {
      gmNotice("WILDPATH.NOTICE.OpensNoCaster", {name: String(entry.definition?.label ?? "")}, undefined, {game, logger});
      return null;
    }
    const regions = [...(scene.regions ?? [])].filter(region => (entry.regionIds ?? []).includes(region.id)
      && region.flags?.wildpath?.area?.pending);
    for ( const region of regions ) {
      await dispelOpposed(scene, region.flags!.wildpath!.area!);
      await region.update({visibility: (globalThis as {CONST?: {REGION_VISIBILITY?: {ALWAYS?: number}}}).CONST?.REGION_VISIBILITY?.ALWAYS ?? 2,
        color: DERIVED_AREA_COLORS.derived, "flags.wildpath.area.pending": false});
      await appear(region, caster, region.flags!.wildpath!.area!, entry.definition ?? {});
    }
    return {regionIds: regions.map(region => region.id)};
  }

  /**
   * After an Action that summons (`summon.area`: Flaming Sphere, Guardian of Faith, Conjure Animals): each summoned Token
   * carries a lasting area of its caster's, attached to it, so it goes where the Token goes and ends with it (V14 deletes
   * a Token's attached Regions). Its triggers resolve with the caster as source: its spell save DC, its slot's dice. It
   * has its spell's cast level (none with `persistence.dispellable: false`, or its summon's `dispellable: false`, as
   * ending it ends the summon), so Dispel Magic (or 2024 Darkness over its light) ends it, and with it the spell (end,
   * Q31); Dispel Magic on the summoned Token still dismisses it and its area.
   */
  async function carry({state}: {state?: Data | null}, tokens: AreaToken[] = []) {
    const configured = (state?.configuration as {effectiveDefinition?: Data | null} | undefined)?.effectiveDefinition;
    const definition = (configured ?? state?.actionDefinition ?? null) as Data | null;
    const summon = definition?.summon as {area?: Data; dispellable?: boolean} | undefined;
    const area = (summon?.dispellable === false) && summon.area
      ? {...summon.area, persistence: {...((summon.area.persistence as Data | undefined) ?? {}), dispellable: false}} : summon?.area;
    const casterId = String((state?.source as {tokenId?: string} | undefined)?.tokenId ?? "");
    if ( !area || !casterId || !isActiveGM() ) return [];
    const regions = [];
    for ( const token of tokens ) {
      const scene = token.parent;
      if ( !scene?.tokens.get(casterId) ) continue;
      const footprint = createFoundryV14TacticalGridAdapter({scene}).tokenToFootprint(token) as {ok: boolean; footprint?: {topology: string}};
      if ( !footprint.ok || !footprint.footprint ) continue;
      // Drawn as it is worked out: the fields within its size around the Token (areaFields), not the Token's own.
      const fields = areaFields({attached: true, anchorTokenId: token.id, size: Number((area.size as Data | undefined)?.value) || 0} as AreaFlag, scene);
      // Only the slot: the whole configuration would swap in its effective definition, which has no top-level area.
      const castingLevel = (state?.configuration as {castingLevel?: number | null} | undefined)?.castingLevel ?? null;
      const region = await create({options: {persistentArea: {footprint: {topology: footprint.footprint.topology, fields},
        definition: {...definition, area}, sourceTokenId: casterId, sceneId: scene.id}}, state: {configuration: {castingLevel}}},
        {anchor: token});
      if ( region ) regions.push(region);
    }
    return regions;
  }

  /**
   * A lasting area that sheds light (Daylight) or darkness (Darkness) gets it at its center, tagged as sunlight when its
   * light is; it goes when the area goes. An attached area's light is its Token's own, so it moves with the Token; the
   * Token's own light comes back after.
   */
  async function shedLight(region: AreaRegion, scene: AreaScene, flag: AreaFlag, light: AreaLight) {
    const config = {bright: Number(light.bright) || 0, dim: Math.max(Number(light.dim) || 0, Number(light.bright) || 0),
      negative: light.darkness === true};
    const anchor = flag.attached ? scene.tokens.get(anchorOf(flag) ?? "") : null;
    if ( anchor?.update ) {
      const previous = {light: (anchor.toObject?.().light as Data | undefined) ?? null, sunlight: anchor.flags?.wildpath?.sunlight === true};
      await anchor.update({light: config, "flags.wildpath.sunlight": light.sunlight === true});
      await region.update({"flags.wildpath.area.lightToken": {id: anchor.id, previous}});
      return;
    }
    const center = areaCenter(flag, scene);
    if ( !center ) return;
    const [created] = await scene.createEmbeddedDocuments("AmbientLight", [{...center, elevation: flag.band.bottom ?? 0, config,
      flags: {wildpath: {sunlight: light.sunlight === true, areaRegion: region.id}}}]) as Array<{id: string}>;
    if ( created ) await region.update({"flags.wildpath.area.lightId": created.id});
  }

  /**
   * An area that walls off its fields (`persistence.blocks`: Wall of Ice's `["move", "sight"]`): each creature in them first
   * steps out to the nearest free space beside them, as forced movement (before any wall could stop it), then its outline
   * becomes two-way Wall documents on its caster's Level, flagged with its Region (`areaRegion`), which onRegionDeleted
   * removes. Foundry's movement, vision and WildPath's cover, pushes and sight read them as any wall.
   */
  async function raiseWalls(region: AreaRegion, caster: AreaToken, flag: AreaFlag, definition: Data) {
    const scene = caster.parent;
    // A V14 Wall has no elevation bounds (only `levels`): it stands the whole height of the caster's Level, so every
    // creature on that Level over the fields steps out, whatever the area's band.
    const open = {...flag, band: {bottom: null, top: null}};
    // A creature on another plane than the caster (an Ethereal one, a Trapped one's hidden Token; planeOf) is not caught, nor
    // one its rules leave untouched by the area's Action (an object: another wall's section stays by its own walls).
    const caught = [...scene.tokens].filter(token => ((token.level ?? null) === (caster.level ?? null))
      && (planeOf(token.actor) === planeOf(caster.actor)) && areaCovers(open, token)
      && !((token.actor?.uuid !== flag.sourceActorRef) && token.actor?.unaffectingRule?.(definition)));
    for ( const covered of caught ) await stepOut(covered as never, flag.fields, "forced");
    if ( flag.persistence.sections ) return raiseSections(region, caster, flag, flag.persistence.sections);
    const walls = areaWallData(outlineEdges(cellPolygons(scene as never, flag.fields)), {blocks: flag.persistence.blocks ?? [],
      level: caster.level ?? null, flags: {wildpath: {areaRegion: region.id}}});
    if ( walls.length ) await scene.createEmbeddedDocuments("Wall", walls);
  }

  /**
   * A blocking area in object sections (`persistence.sections`: Wall of Ice's 10-foot sections of AC 12 and 30 HP): its
   * fields split in order from the wall's start (`wallSections`), one world Actor for them (`objectActorData`, its id in
   * the flag's `sectionActorId`), and per section an unlinked Token over its fields, neutral, flagged with its section
   * (`section: {regionId, index}`) and `leavesAtDeath` (so it leaves when brought to 0), and its own walls
   * (`sectionWallData`, flagged `{areaRegion, section: index}`), so each section can open alone. onRegionDeleted removes
   * them all. Walls stand even if the Actor could not be made.
   */
  async function raiseSections(region: AreaRegion, caster: AreaToken, flag: AreaFlag, sections: Sections) {
    const scene = caster.parent;
    const groups = sectionFields(flag, sections, scene);
    const {CONFIG} = globalThis as {CONFIG?: {Actor?: {documentClass?: {create(data: Data): Promise<SectionActor | null | undefined>}}}};
    const actor = await CONFIG?.Actor?.documentClass?.create(objectActorData(sections, flag.label));
    if ( actor ) {
      await region.update({"flags.wildpath.area.sectionActorId": actor.id});
      const tokens = await Promise.all(groups.map(async (fields, index) => (await actor.getTokenDocument({
        ...sectionTokenPlacement(scene as never, fields),
        name: game.i18n?.format("WILDPATH.AREA.Section", {area: flag.label, number: String(index + 1)}) ?? `${flag.label} ${index + 1}`,
        ...(caster.level ? {level: caster.level} : {}),
        flags: {wildpath: {section: {regionId: region.id, index}, leavesAtDeath: true}}}, {parent: scene})).toObject()));
      await scene.createEmbeddedDocuments("Token", tokens);
    } else logger.warn("Wild Path | An area's sections could not be made", flag.label);
    const walls = groups.flatMap((fields, index) => sectionWallData(cellPolygons(scene as never, fields), {blocks: flag.persistence.blocks ?? [],
      level: caster.level ?? null, flags: {wildpath: {areaRegion: region.id, section: index}}}));
    if ( walls.length ) await scene.createEmbeddedDocuments("Wall", walls);
  }

  /**
   * An area that opens the walls under it (`persistence.walls: "open"`: Earthquake's fissures, a Passwall): each original
   * wall on its Level that its cells cut is hidden (every sense NONE, its own kept in `flags.wildpath.senses`) and stands
   * again as pieces (`pieceOf`) outside the cells of every area opening it (`openedBy`); once none does, its senses come
   * back. Walls an area raised (`areaRegion`) and pieces are never originals, so a fissure never opens a Wall of Ice. The
   * pieces are derived, so areas made, moved and ended in any order give the same walls. Run on create, after a move
   * (relocate) and on its Region's deletion (`ended`: it opens nothing more).
   * shortcut: a door is opened whole, with no pieces, and an original the GM deletes while opened leaves its pieces;
   * upgrade if a door half across an area or a deleted original matters.
   */
  async function syncOpenedWalls(region: AreaRegion, options: {ended?: boolean}={}) {
    const key = region.parent?.id ?? "";
    const queued = (opening.get(key) ?? Promise.resolve()).then(() => openWalls(region, options));
    opening.set(key, queued.catch(() => undefined));
    await queued;
  }

  async function openWalls(region: AreaRegion, {ended=false}: {ended?: boolean}) {
    const scene = region.parent;
    if ( !scene?.walls ) return;
    const regions = [...(scene.regions ?? [])];
    const opens = (id: string) => ((id === region.id) ? !ended
      : regions.some(other => (other.id === id) && (other.flags?.wildpath?.area?.persistence.walls === "open")));
    const sceneLevels = [...(scene.levels?.keys?.() ?? [])];
    // The Levels a Region or wall stands on: those it names, or every Level of the Scene when it names none (an empty list
    // still meaning every Level, as wallsBlock reads it, on a Scene listing none).
    const span = (named?: Iterable<string> | null) => {
      const own = [...(named ?? [])];
      return own.length ? own : sceneLevels;
    };
    const meets = (a: string[], b: string[]) => !a.length || !b.length || a.some(level => b.includes(level));
    const areaOf = (id: string) => ((id === region.id) ? region : regions.find(other => other.id === id));
    const cellsOf = (id: string) => cellPolygons(scene as never, areaOf(id)?.flags?.wildpath?.area?.fields ?? []);
    // A pending opening opens nothing yet (rollOpenings); its Open does.
    const own = (ended || region.flags?.wildpath?.area?.pending) ? [] : cellsOf(region.id);
    const crosses = (wall: AreaWall) => meets(span(wall.levels), span(region.levels))
      && (segmentOutside(wall.c!, own)[0] !== wall.c);
    const walls = [...scene.walls];
    const changed = walls.filter(wall => {
      const marks = wall.flags?.wildpath;
      if ( marks?.areaRegion || marks?.pieceOf || !Array.isArray(wall.c) ) return false;
      return marks?.openedBy?.includes(region.id) || crosses(wall);
    });
    const updates: Data[] = [];
    const pieces: Data[] = [];
    for ( const wall of changed ) {
      const crossed = crosses(wall);
      const openedBy = [...(wall.flags?.wildpath?.openedBy ?? []).filter(id => (id !== region.id) && opens(id)),
        ...(crossed ? [region.id] : [])];
      const senses = wall.flags?.wildpath?.senses ?? {move: wall.move!, sight: wall.sight!, light: wall.light!, sound: wall.sound!};
      if ( !openedBy.length ) {
        updates.push({_id: wall.id, ...senses, "flags.wildpath.openedBy": null, "flags.wildpath.senses": null});
        continue;
      }
      updates.push({_id: wall.id, ...wallSenses([]), "flags.wildpath.openedBy": openedBy, "flags.wildpath.senses": senses});
      if ( Number(wall.door) ) continue;
      // A piece is the original as drawn (its Level, direction, threshold), with its own senses. A wall standing on several
      // Levels is cut on each only by the areas opening it there, and stands whole on a Level none opens it.
      const {_id, id, flags, ...source} = (wall.toObject?.() ?? {...wall}) as Data;
      const byOpeners = new Map<string, {on: string[]; ids: string[]}>();
      const standing = span(wall.levels);
      for ( const level of standing.length ? standing : [""] ) {
        const ids = openedBy.filter(opener => meets(span(areaOf(opener)?.levels), level ? [level] : []));
        if ( !byOpeners.has(ids.join()) ) byOpeners.set(ids.join(), {on: [], ids});
        byOpeners.get(ids.join())!.on.push(level);
      }
      for ( const {on, ids} of byOpeners.values() ) {
        for ( const c of ids.length ? segmentOutside(wall.c!, ids.flatMap(cellsOf)) : [wall.c!] ) {
          pieces.push({...source, ...senses, c, ...((byOpeners.size > 1) ? {levels: on} : {}), flags: {wildpath: {pieceOf: wall.id}}});
        }
      }
    }
    const ids = new Set(changed.map(wall => wall.id));
    const stale = walls.filter(wall => ids.has(wall.flags?.wildpath?.pieceOf ?? "")).map(wall => wall.id);
    if ( stale.length ) await scene.deleteEmbeddedDocuments?.("Wall", stale);
    if ( updates.length ) await scene.updateEmbeddedDocuments?.("Wall", updates);
    if ( pieces.length ) await scene.createEmbeddedDocuments("Wall", pieces);
  }

  /**
   * 2024 Daylight and Darkness: an area whose light `dispels` ends each overlapping area of the opposite kind (darkness
   * for light, light for darkness) whose spell was cast at that level or lower. An attached area's light is its Token's,
   * reaching as far as its dim light (Flaming Sphere's 40 feet), so it overlaps there, not only within its own size.
   * shortcut: a placed area's light past its own fields (Daylight's dim) is not counted; upgrade with a light-reach part.
   */
  async function dispelOpposed(scene: AreaScene, flag: AreaFlag) {
    const light = flag.persistence.light;
    if ( !light?.dispels ) return;
    const covered = new Set(areaFields(flag, scene).map(field => keyOf(field, flag.topology)));
    for ( const other of sceneAreas(scene) ) {
      const theirs = other.flag.persistence.light;
      if ( !theirs || ((theirs.darkness === true) === (light.darkness === true)) ) continue;
      if ( !((other.flag.castLevel ?? Infinity) <= light.dispels) ) continue;
      const lit = other.flag.attached ? {...other.flag, size: Math.max(Number(other.flag.size) || 0, Number(theirs.dim) || 0,
        Number(theirs.bright) || 0)} : other.flag;
      if ( areaFields(lit, scene).some(field => covered.has(keyOf(field, other.flag.topology))) ) await end(other.region);
    }
  }

  /**
   * An area's spell ends (dispelled, or its budget spent): a summon carrying it is dismissed with its cast, its Region going
   * with its Token (Flaming Sphere, Guardian of Faith, the 2024 pack); any other area's Region is deleted, one only cast on
   * a summon (Darkness on a Spiritual Weapon) too: carried means summoned by this area's own Action.
   */
  async function end(region: AreaRegion): Promise<void> {
    const flag = region.flags?.wildpath?.area;
    const scene = region.parent;
    // What an opened section left (leaveBehind) is the wall's spell: ending it (Dispel Magic on the sheet) ends the wall,
    // whose Region's end takes it along.
    const parent = flag?.parentRegionId ? [...(scene?.regions ?? [])].find(entry => entry.id === flag.parentRegionId) : null;
    if ( parent ) return end(parent);
    const carrier = (flag?.anchorTokenId && scene) ? scene.tokens.get(flag.anchorTokenId) as (AreaToken & {flags?: {wildpath?: {summon?:
      {actionId?: string | null}}}}) | undefined : undefined;
    // Its Token is gone (a cast dismissed with an earlier area's): V14 is already deleting its attached Region, unawaited.
    if ( flag?.anchorTokenId && scene && !carrier ) return;
    const summon = carrier?.flags?.wildpath?.summon;
    if ( scene && summon && (summon.actionId === flag?.actionDefinitionId) && dismissSummon ) await dismissSummon(scene, [carrier.id]);
    else await region.delete();
  }

  /**
   * A creature died: each lasting area of its own on any Scene that ends with it (`persistence.endsWhen: "sourceDies"`)
   * ends through `end`. Called by the death settle step (plan S2), before its effects go, so nobody is saved against again.
   */
  async function endWithSource(actor: {uuid?: string | null} | null | undefined) {
    if ( !actor?.uuid || !isActiveGM() ) return;
    for ( const scene of game.scenes ?? [] ) {
      for ( const {region, flag} of sceneAreas(scene) ) {
        if ( (flag.sourceActorRef === actor.uuid) && (flag.persistence.endsWhen === "sourceDies") ) await end(region);
      }
    }
  }

  /**
   * A concentration area is sustained like any concentration effect: a marker on the caster names the caster
   * as its concentration source, so a failed concentration check ends it, and with it the Region.
   */
  async function markConcentration(region: AreaRegion, caster: AreaToken, label: string) {
    const name = game.i18n?.format("WILDPATH.AREA.Concentrating", {area: label}) ?? label;
    const [effect] = await caster.actor?.createEmbeddedDocuments?.("ActiveEffect", [{name, type: "effect", system: {},
      flags: {wildpath: {areaRegion: {sceneId: caster.parent.id, regionId: region.id},
        conditionEffect: {concentration: {sourceRef: `token:${caster.id}`}}}}}]) as Effect[] ?? [];
    if ( effect ) await region.update({"flags.wildpath.area.concentrationEffect": effect.uuid});
  }

  /**
   * After any Action: a concentration check it broke ends every concentration area that caster sustains
   * (the Region's deletion then removes the caster's marker).
   */
  /** The creatures (`token:<id>`) whose concentration a resolved Action's checks broke. */
  function brokenConcentration(state: unknown) {
    const checks = (state as {results?: {concentrationResolution?: {checks?: {
      breakEvents?: Array<{sourceRef?: string; ref?: string}>}}}} | null)?.results?.concentrationResolution?.checks;
    return new Set((checks?.breakEvents ?? []).map(event => event.sourceRef ?? event.ref).filter(Boolean));
  }

  async function afterResolution({state}: {state?: unknown}) {
    const broken = brokenConcentration(state);
    if ( !broken.size ) return;
    for ( const scene of game.scenes ?? [] ) {
      for ( const {region, flag} of sceneAreas(scene) ) {
        if ( flag.persistence.concentration && broken.has(`token:${flag.sourceTokenId}`) ) await region.delete();
      }
    }
  }

  /** The active GM keeps a concentration area and its marker together: either one ending ends the other. */
  async function onEffectDeleted(effect: Effect) {
    const link = effect.flags?.wildpath?.areaRegion;
    if ( !link || !isActiveGM() ) return;
    const region = [...(game.scenes?.get(link.sceneId)?.regions ?? [])].find(entry => entry.id === link.regionId);
    await region?.delete();
  }

  async function onRegionDeleted(region: AreaRegion) {
    if ( !isActiveGM() ) return;
    // The walls it raised go with it (raiseWalls); a wall drawn by hand or another area's stays.
    const walls = region.flags?.wildpath?.area ? [...(region.parent?.walls ?? [])]
      .filter(wall => wall.flags?.wildpath?.areaRegion === region.id).map(wall => wall.id) : [];
    if ( walls.length ) await region.parent?.deleteEmbeddedDocuments?.("Wall", walls);
    // Its sections' Tokens still standing, then the Actor they stood for (raiseSections).
    const sectionTokens = region.flags?.wildpath?.area ? [...(region.parent?.tokens ?? [])]
      .filter(token => token.flags?.wildpath?.section?.regionId === region.id).map(token => token.id) : [];
    if ( sectionTokens.length ) await region.parent?.deleteEmbeddedDocuments?.("Token", sectionTokens);
    const sectionActorId = region.flags?.wildpath?.area?.sectionActorId;
    if ( sectionActorId ) await game.actors?.get(sectionActorId)?.delete();
    // What its opened sections left (leaveBehind) goes with it; each child's own deletion hook releases what it held.
    const children = region.flags?.wildpath?.area ? [...(region.parent?.regions ?? [])]
      .filter(child => child.flags?.wildpath?.area?.parentRegionId === region.id).map(child => child.id) : [];
    if ( children.length ) await region.parent?.deleteEmbeddedDocuments?.("Region", children);
    // The walls it opened stand again, but where another opening area still lies (syncOpenedWalls).
    if ( region.flags?.wildpath?.area?.persistence.walls === "open" ) await syncOpenedWalls(region, {ended: true});
    // Its light goes with it; a Token whose light it was gets its own back.
    const lightId = region.flags?.wildpath?.area?.lightId;
    if ( lightId ) await region.parent?.lights?.get(lightId)?.delete();
    const lightToken = region.flags?.wildpath?.area?.lightToken;
    const holder = lightToken ? region.parent?.tokens.get(lightToken.id) : null;
    if ( lightToken && holder?.update ) {
      await holder.update({light: lightToken.previous.light ?? {bright: 0, dim: 0, negative: false},
        "flags.wildpath.sunlight": lightToken.previous.sunlight});
    }
    // What it held only while in it ends with it (Web's Restrained once the webs are gone).
    if ( region.flags?.wildpath?.area && releases(region.flags.wildpath.area) ) {
      for ( const token of region.parent?.tokens ?? [] ) await release(region, token);
    }
    const uuid = region.flags?.wildpath?.area?.concentrationEffect;
    if ( !uuid ) return;
    const effect = await fromUuid?.(uuid) as Effect | null;
    await effect?.delete();
  }

  /**
   * A section's Token gone (brought to 0 and removed by the death settle step, or deleted by hand) opens that section:
   * its own walls go (raiseSections flags them `{areaRegion, section: index}`), its neighbours' stay. Its Region's end
   * deletes the walls before the Tokens, so a Token it removes finds none. A section still standing in another Token
   * (a GM's pasted copy of it, or the original once the copy is gone) keeps its walls.
   */
  async function onTokenDeleted(token: Pick<AreaToken, "id" | "flags" | "parent">) {
    const section = token.flags?.wildpath?.section;
    if ( !section || !isActiveGM() ) return;
    if ( [...(token.parent?.tokens ?? [])].some(other => (other.id !== token.id)
      && (other.flags?.wildpath?.section?.regionId === section.regionId) && (other.flags.wildpath.section.index === section.index)) ) return;
    const walls = [...(token.parent?.walls ?? [])].filter(wall => (wall.flags?.wildpath?.areaRegion === section.regionId)
      && (wall.flags.wildpath.section === section.index)).map(wall => wall.id);
    if ( walls.length ) await token.parent?.deleteEmbeddedDocuments?.("Wall", walls);
    if ( token.parent ) await leaveBehind(token.parent, section);
  }

  /**
   * An opened section's space keeps what its area leaves there (`persistence.sections.leaves`: Wall of Ice's Frigid Air,
   * rubble's Difficult Terrain): a child area over that section's fields, an ordinary placed area of the same caster with
   * the parent's band, Level and cast level, named after its first trigger's Action. It names its parent
   * (`parentRegionId`), so the parent's end deletes it (onRegionDeleted) and ending it ends the parent (end). A Region
   * already gone (the parent's own end removing its Tokens) leaves nothing.
   * shortcut: with its caster's Token gone nothing is left (the GM is told), as an area needs its caster's Token to
   * resolve; upgrade if a wall outliving its caster's Token must still leave its child.
   */
  async function leaveBehind(scene: AreaScene, section: {regionId: string; index: number}) {
    const parent = [...(scene.regions ?? [])].find(region => region.id === section.regionId);
    const flag = parent?.flags?.wildpath?.area;
    const sections = flag?.persistence.sections;
    if ( !parent || !flag || !sections?.leaves ) return;
    const fields = sectionFields(flag, sections, scene)[section.index];
    if ( !fields?.length ) return;
    const caster = scene.tokens.get(flag.sourceTokenId ?? "");
    if ( !caster ) return void gmNotice("WILDPATH.NOTICE.AreaLeavesNoCaster", {name: flag.label}, undefined, {game, logger});
    const leaves = sections.leaves as {triggers?: Trigger[]};
    const definition = {id: `${flag.actionDefinitionId}:leaves`, label: (leaves.triggers?.[0]?.action.label as string | undefined) ?? flag.label,
      area: {shape: AREA_SHAPES.WALL, persistence: leaves}};
    const data = persistentAreaRegionData({placement: {footprint: {topology: flag.topology, fields}, sceneId: scene.id,
      sourceTokenId: caster.id, definition}, sourceToken: caster, combat: null, color: DERIVED_AREA_COLORS.derived});
    Object.assign(data.flags.wildpath.area, {band: flag.band, castLevel: flag.castLevel ?? null, parentRegionId: parent.id});
    Object.assign(data, {elevation: {...flag.band}, ...(parent.levels ? {levels: [...parent.levels]} : {})});
    await createRegion(caster, data, definition);
  }

  function isActiveGM() {
    return game.users?.activeGM?.id === game.user.id;
  }

  /**
   * What the area gave `token`'s creature only while in it (stamped with its Region) ends: it left, or the area ended.
   * A custom effect that another area covering the creature at `position` (where its step ended; else where it stands)
   * also holds on everyone in it (an entering trigger's heldOnly, acting on it: a second Antimagic Field, another Spirit
   * Guardians' Half Speed) is handed over instead: one update names that area, so nothing goes off and on again.
   */
  async function release(region: AreaRegion, token: AreaToken, {position=null}: {position?: Data | null}={}) {
    const actor = token.actor;
    const held = [...(actor?.effects ?? [])].filter(effect => effect.flags?.wildpath?.conditionEffect?.metadata?.regionId === region.id);
    // A removed Token enters no area, and a dead creature is passed by (crossed, dueRuns): none takes its effect over.
    const others = (held.length && !removedMarker(token) && !(actor && deadCreature(actor))) ? sceneAreas(token.parent).filter(({region: other, flag}) => (other.id !== region.id)
      && !spares(flag, token) && areaCovers(flag, token, {position})) : [];
    // What this area gave it is going, so its rules bar no heir (Winked Out's own Unaffected {} would bar every one).
    const going = held.map(effect => effect.id);
    const heir = (statuses: string[]) => others.find(({flag}) => flag.persistence.triggers.some(trigger => trigger.on.includes(AREA_EVENTS.ENTERED)
      && reaches(flag, trigger, token, going) && (((heldOnly(trigger.action)?.effects ?? []) as Data[])).some(effect => (effect.type === "effect")
        && statuses.includes(customEffectId(String(trigger.action.id), effect)))))?.region ?? null;
    const heirs = held.map(effect => ({effect, heir: heir([...(effect.statuses ?? [])])}));
    const updates = heirs.filter(({heir}) => heir)
      .map(({effect, heir}) => ({_id: effect.id, "flags.wildpath.conditionEffect.metadata.regionId": heir?.id}));
    const ids = heirs.filter(({heir}) => !heir).map(({effect}) => effect.id);
    if ( updates.length ) await actor?.updateEmbeddedDocuments?.("ActiveEffect", updates);
    if ( ids.length ) await actor?.deleteEmbeddedDocuments?.("ActiveEffect", ids);
    return ids;
  }

  // Keyed on the creature's own combat, as onTurn is, not the one the GM's tracker shows. `feet`: for `area.moved`, how
  // far the creature moved in the area on that step (moved). `position`: where the step that left it ended (release).
  async function apply(region: AreaRegion, flag: AreaFlag, token: AreaToken, event: string,
    {feet=0, key=turnKey(combatOf(token, game) ?? game.combat), appearing=false, position=null}: {feet?: number; key?: string | null;
      appearing?: boolean; position?: Data | null}={}) {
    if ( event === AREA_EVENTS.EXITED ) await release(region, token, {position});
    const runs = await dueRuns(region, flag, [token], event, {feet, key, appearing});
    const results: unknown[] = [];
    for ( const run of runs ) {
      const state = await runOne(region, flag, run);
      if ( state ) results.push(state);
    }
    if ( runs.length ) await charge(region, flag, results);
    return results;
  }

  /**
   * The runs `event` makes in an area for each of `tokens`, after the area's creature filters and once records; the
   * records are written (one update) before anything resolves, as an effect that moves a creature must not re-enter the
   * same area this turn. `sourceTurn`: its caster's turn (runSourceTriggers), so only its `turnOf: "source"` triggers
   * answer a turn event, a self-targeted one on its caster and any other on each creature the area covers; on any other
   * turn only the rest do. `creating`: only its `once: "area"` triggers (create).
   */
  async function dueRuns(region: AreaRegion, flag: AreaFlag, tokens: AreaToken[], event: string,
    {feet=0, key=null, appearing=false, sourceTurn=false, creating=false}: {feet?: number; key?: string | null; appearing?: boolean;
      sourceTurn?: boolean; creating?: boolean}={}): Promise<Run[]> {
    // A pending opening answers nothing until its Open (rollOpenings).
    if ( flag.pending ) return [];
    // Spent (a budget dealt in all): nothing more, though a sweep listed more creatures before it ended (its live flag).
    const budget = Number(flag.persistence.budget?.damage) || 0;
    if ( budget && ((Number(region.flags?.wildpath?.area?.dealt) || 0) >= budget) ) return [];
    // Moving in an area acts on every step, whatever once per turn says, and spends none of it (Spike Growth).
    if ( event === AREA_EVENTS.MOVED ) key = null;
    const runs: Run[] = [];
    const records: Record<string, string | null> = {};
    // Outside combat (no turn to key on) a `once: "turn"` trigger acts once while its creature stays in the area (`stay`),
    // its leaving freeing it: a crossing is one save though the trigger answers entering and leaving (Frigid Air), and
    // each new entering is another, as outside combat there is no limit.
    const mark = (trigger: Trigger) => key ?? (((trigger.once === "turn") && (event !== AREA_EVENTS.MOVED)) ? "stay" : null);
    for ( const token of tokens ) {
      if ( !key && (event === AREA_EVENTS.EXITED) ) for ( const [slot, value] of Object.entries(flag.applied) ) {
        if ( (value === "stay") && slot.startsWith(`${token.id}-`) ) records[slot] = null;
      }
      // How many times a trigger acts: once, or on a move once for every `per` feet of it (none for less).
      const times = (trigger: Trigger) => (((event === AREA_EVENTS.MOVED) && trigger.per) ? Math.floor(feet / trigger.per) : 1);
      // On its caster's turn a self-targeted trigger acts on its caster, wherever it stands, as the area's own act.
      const self = (trigger: Trigger) => sourceTurn && selfTargeted(trigger.action);
      const whose = (trigger: Trigger) => !TURN_EVENTS.includes(event) || ((trigger.turnOf === "source") === sourceTurn);
      const here = (trigger: Trigger) => !sourceTurn || (self(trigger) ? (token.id === flag.sourceTokenId) : areaCovers(flag, token));
      const triggers = flag.persistence.triggers.map((trigger, index) => ({trigger, index}))
        .filter(({trigger}) => trigger.on.includes(event) && whose(trigger) && (!creating || (trigger.once === "area"))
          && (self(trigger) || !spares(flag, token)) && reaches(flag, trigger, token) && (times(trigger) > 0) && here(trigger));
      // A dead creature is an object: its area passes it by (an exit still releases it).
      if ( !triggers.length || !token.actor || deadCreature(token.actor) ) continue;
      // A trigger with `once: "turn"` (or a self-targeted one on its caster's turn) keeps its own record
      // (`<token id>-<index>`), spending and spent by no other trigger; `once: "area"` keeps one for the whole area
      // (`area-<index>`), spent at its first run even outside combat; the rest share the area's (2026-11-14).
      const slot = ({trigger, index}: {trigger: Trigger; index: number}) => ((trigger.once === "area") ? `area-${index}`
        : ((trigger.once === "turn") || self(trigger)) ? `${token.id}-${index}` : token.id);
      const spent = (entry: {trigger: Trigger; index: number}) => ((entry.trigger.once === "area") ? !!flag.applied[slot(entry)]
        : !!(mark(entry.trigger) && ((entry.trigger.once === "turn") || self(entry.trigger) || flag.persistence.oncePerTurn)
          && (flag.applied[slot(entry)] === mark(entry.trigger))));
      const due = triggers.filter(entry => !spent(entry));
      // Spent this turn, an entering still gives what it holds while in it whatever the save (heldOnly); `appearing`, only that.
      const held = triggers.map(entry => ({...entry, token: token as Run["token"], count: times(entry.trigger),
        action: (due.includes(entry) && !appearing) ? entry.trigger.action : ((event === AREA_EVENTS.ENTERED) ? heldOnly(entry.trigger.action) : null)}))
        .filter((run): run is Run => !!run.action);
      if ( !held.length ) continue;
      runs.push(...held);
      if ( !appearing ) for ( const entry of due ) {
        const value = (entry.trigger.once === "area") ? (key ?? "area") : mark(entry.trigger);
        if ( value && !((value === "stay") && (event === AREA_EVENTS.EXITED)) ) records[slot(entry)] = value;
      }
    }
    if ( Object.keys(records).length ) {
      await region.update(Object.fromEntries(Object.entries(records).map(([slot, value]) => [`flags.wildpath.area.applied.${slot}`, value])));
    }
    return runs;
  }

  /** One trigger's Action on one creature, with the caster as source. */
  function runOne(region: AreaRegion, flag: AreaFlag, {token, action, count}: Run) {
    return runAuthorityAction({coordinator, resolveAction, logger, senderUserId: game.user.id,
      resolutionId: `area:${region.id}:${token.id}:${++sequence}`,
      definition: repeatedDamage(stamped(action, region, token.actor), count), label: flag.label,
      actorRef: flag.sourceActorRef, source: flag.sourceTokenId ? {tokenId: flag.sourceTokenId, sceneId: token.parent.id} : {},
      // A lasting area's own trigger (placed, carried or an emanation): no cover against it (Q37); the area is its parent.
      target: {actorRef: token.actor.uuid, tokenId: token.id, sceneId: token.parent.id}, noCover: true,
      parentArea: {sceneId: token.parent.id, regionId: region.id}});
  }

  /**
   * One trigger's runs on several creatures: one Action for all of them (an aura's: one damage roll), or one per creature
   * when it gives what it holds only while in the area (`stamped` is per creature). Their states.
   */
  async function runGroup(region: AreaRegion, flag: AreaFlag, trigger: Trigger, index: number, group: Run[], kind: string) {
    if ( ((trigger.action.effects ?? []) as Data[]).some(leavesArea) ) {
      const states = [];
      for ( const run of group ) states.push(await runOne(region, flag, run));
      return states;
    }
    const scene = group[0]!.token.parent;
    return [await runAuthorityAction({coordinator, resolveAction, logger, senderUserId: game.user.id,
      resolutionId: `area:${region.id}:${kind}-${index}:${++sequence}`, definition: trigger.action, label: flag.label,
      actorRef: flag.sourceActorRef, source: flag.sourceTokenId ? {tokenId: flag.sourceTokenId, sceneId: scene.id} : {},
      targets: group.map(({token}) => ({actorRef: token.actor.uuid, tokenId: token.id, sceneId: scene.id})), noCover: true,
      parentArea: {sceneId: scene.id, regionId: region.id}})];
  }

  /** A budget's area adds what its runs dealt (spend). */
  async function charge(region: AreaRegion, flag: AreaFlag, results: unknown[]) {
    if ( !(Number(flag.persistence.budget?.damage) || 0) ) return;
    // One after another per area: a spend whose update is still on its way to the server is never read stale by the next.
    const queued = (spending.get(region.id) ?? Promise.resolve()).then(() => spend(region, results));
    spending.set(region.id, queued.catch(() => undefined));
    await queued;
  }

  /**
   * Its caster's turn starts or ends (`caster`, its Token): each of its areas on the Scene answers with its
   * `turnOf: "source"` triggers, in their order. A self-targeted one acts once, on its caster; any other is one Action for
   * every creature the area covers (runGroup). An area an earlier trigger ended (its caster's concentration broken)
   * answers no more. `region`: that area alone (create).
   */
  async function runSourceTriggers(event: string, caster: AreaToken, key: string | null,
    {region: only=null, creating=false}: {region?: AreaRegion | null; creating?: boolean}={}) {
    const scene = caster.parent;
    const results: unknown[] = [];
    const areas = sceneAreas(scene).filter(({region, flag}) => (flag.sourceTokenId === caster.id) && (!only || (region.id === only.id))
      && flag.persistence.triggers.some(trigger => (trigger.turnOf === "source") && trigger.on.includes(event)));
    // Ended: deleted, or a concentration area whose caster's concentration a trigger here broke. A resolved Action returns
    // before its follow-ups (afterResolution) delete the area, so its Region is still on the Scene then.
    let broken = false;
    const ended = (region: AreaRegion, flag: AreaFlag) => (broken && flag.persistence.concentration)
      || ![...(scene.regions ?? [])].some(entry => entry.id === region.id);
    for ( const {region, flag} of areas ) {
      if ( ended(region, flag) ) continue;
      const runs = await dueRuns(region, flag, [...scene.tokens], event, {key, sourceTurn: true, creating});
      const states: unknown[] = [];
      for ( const [index, trigger] of flag.persistence.triggers.entries() ) {
        const group = runs.filter(run => run.index === index);
        if ( !group.length ) continue;
        if ( ended(region, flag) ) break;
        states.push(...await runGroup(region, flag, trigger, index, group, "source"));
        // Only a completed Action's follow-ups end anything (afterCompleted); a failed or cancelled one broke nothing.
        broken ||= states.some(state => ((state as {status?: string} | null)?.status === "completed")
          && (brokenConcentration(state).has(`token:${caster.id}`)
            || brokenConcentrationTargets(state as Data).some(target => target?.tokenId === caster.id)));
      }
      const done = states.filter(Boolean);
      if ( runs.length && !ended(region, flag) ) await charge(region, flag, done);
      results.push(...done);
    }
    return results;
  }

  /**
   * A budget's area adds the damage its completed runs dealt (Temporary Hit Points and overkill included, Q29; a failed or
   * cancelled run changed no Hit Points), queued per area (apply); at its budget it ends (end). One already ended by an
   * earlier spend is left alone.
   */
  async function spend(region: AreaRegion, results: unknown[]) {
    const flag = region.flags!.wildpath!.area!;
    const budget = Number(flag.persistence.budget?.damage) || 0;
    if ( (Number(flag.dealt) || 0) >= budget ) return;
    const dealt = (Number(flag.dealt) || 0) + results.filter(state => (state as {status?: string} | null)?.status === "completed")
      .reduce((sum: number, state) => sum + damageTaken(state), 0);
    await region.update({"flags.wildpath.area.dealt": dealt});
    if ( dealt < budget ) return;
    await end(region);
  }

  /**
   * A combatant's turn starts or ends: every area it stands in answers that event, once per turn counted in that turn,
   * and then every area it is the caster of answers with its `turnOf: "source"` triggers (runSourceTriggers).
   * Foundry runs `_onEndTurn` after the Combat has advanced, so the ended turn is its `context`'s ({round, turn}).
   */
  async function onTurn(event: string, {combatant, context=null}: {combatant: {token?: AreaToken | null; combat?: Combat | null} | null;
    context?: {round: number; turn: number | null} | null}) {
    const token = combatant?.token ?? null;
    if ( !token?.parent?.regions ) return [];
    const combat = combatant?.combat;
    const key = (combat && (context?.round != null)) ? turnKey({id: combat.id, round: context.round, turn: context.turn})
      : turnKey(game.combat);
    const applied = [];
    for ( const {region, flag} of sceneAreas(token.parent) ) {
      // An area whose rounds have run out is gone before anyone starts a turn in it.
      // The turn's own combat, not the one the GM's tracker shows.
      if ( (event === AREA_EVENTS.TURN_STARTED) && areaExpired(flag, combatant?.combat) ) {
        await region.delete();
        continue;
      }
      if ( areaCovers(flag, token) ) applied.push(...await apply(region, flag, token, event, {key}));
    }
    applied.push(...await runSourceTriggers(event, token, key));
    return applied;
  }

  /**
   * Areas a Token enters by stepping from `previous` to `position` (covered after, not before), or with
   * `area.exited` leaves (covered before, not after). Only areas that answer that event count.
   * A Token removed from the scene (removedMarker) enters nothing, but still leaves.
   */
  function crossed(token: AreaToken, {previous, position}: {previous: Data; position: Data}, event: string) {
    if ( (event !== AREA_EVENTS.EXITED) && removedMarker(token) ) return [];
    const [inside, outside] = event === AREA_EVENTS.EXITED ? [previous, position] : [position, previous];
    return sceneAreas(token.parent).filter(({flag}) => answers(flag, event)
      && areaCovers(flag, token, {position: inside}) && !areaCovers(flag, token, {position: outside}));
  }
  const entered = (token: AreaToken, step: {previous: Data; position: Data}) => crossed(token, step, AREA_EVENTS.ENTERED);
  const exited = (token: AreaToken, step: {previous: Data; position: Data}) => crossed(token, step, AREA_EVENTS.EXITED);

  /**
   * Areas answering `area.moved` that a Token's step from `previous` to `position` moves it in, each with the feet moved
   * there: one grid distance for each space of the step that ends in the area, so a step in from outside counts only
   * its part inside and a step out counts nothing. Distance as movement measures it (any step to an adjacent space is
   * one grid distance, diagonals too); Difficult Terrain's extra cost is not distance moved. A Token removed from the
   * scene (removedMarker) moves in none.
   */
  function moved(token: AreaToken, {previous, position}: {previous: Data; position: Data}) {
    if ( removedMarker(token) ) return [];
    const scene = token.parent;
    // An area its Token carries goes with it: the Token moves in it no more than out of it (includesAnchor).
    const areas = sceneAreas(scene).filter(({flag}) => answers(flag, AREA_EVENTS.MOVED) && !(flag.attached && (anchorOf(flag) === token.id)));
    if ( !areas.length ) return [];
    const adapter = createFoundryV14TacticalGridAdapter({scene});
    const anchor = (at: Data) => adapter.tokenToFootprint(token, {position: at}) as {ok: boolean; anchor?: Field; topology?: string};
    const [from, to] = [anchor(previous), anchor(position)];
    const spaces = (from.ok && to.ok && from.anchor && to.anchor) ? distanceOf(from.anchor, to.anchor, to.topology) : 0;
    // shortcut: a step of several spaces is cut into equal parts along a straight line; a checkpointed drag moves one
    // space a step (one resolution and card per space), so this, and the one-roll merge, only matter for a step
    // Foundry did not split.
    const along = Array.from({length: spaces}, (_, index) => ({...position, ...Object.fromEntries(["x", "y", "elevation"]
      .filter(key => Number.isFinite(Number(position[key])) && Number.isFinite(Number(previous[key])))
      .map(key => [key, Number(previous[key]) + ((Number(position[key]) - Number(previous[key])) * (index + 1) / spaces)]))}));
    return areas.map(({region, flag}) => ({region, flag,
      feet: along.filter(at => areaCovers(flag, token, {position: at})).length * scene.grid.distance}))
      .filter(entry => entry.feet > 0);
  }

  /**
   * Creatures an aura newly covers as its caster steps from `previous` to `position` (the aura enters them),
   * and creatures it stops covering (they exit it), each with that event. While either the caster or a creature is
   * removed from the scene (removedMarker), the aura enters nothing of it, but still exits.
   */
  function swept(owner: AreaToken, {previous, position}: {previous: Data; position: Data}) {
    const scene = owner.parent;
    return sceneAreas(scene).filter(({flag}) => flag.attached && (anchorOf(flag) === owner.id))
      .flatMap(({region, flag}) => {
        const before = areaFields(flag, scene, {position: previous});
        const after = areaFields(flag, scene, {position});
        return [AREA_EVENTS.ENTERED, AREA_EVENTS.EXITED].filter(event => answers(flag, event)).map(event => {
          const [inside, outside] = event === AREA_EVENTS.EXITED ? [before, after] : [after, before];
          const entering = event !== AREA_EVENTS.EXITED;
          const tokens = (entering && removedMarker(owner)) ? [] : [...scene.tokens].filter(token => (token.id !== owner.id)
            && !(entering && removedMarker(token))
            && areaCovers(flag, token, {fields: inside}) && !areaCovers(flag, token, {fields: outside}));
          return {region, flag, tokens, event};
        });
      }).filter(entry => entry.tokens.length);
  }

  /**
   * A creature that rams (`occupancy.ram`: a Flaming Sphere its Roll moves) ended a voluntary move in other creatures'
   * spaces (foundry-v14-occupancy lets it end in the first it enters): it moves no more this turn (its movement spent), and
   * each area it carries answers `area.rammed` for each of them (the sphere's save, at its caster's DC and slot). Runs once,
   * on the active GM, on `movement.completed`.
   */
  async function rammed(event: {type?: string; data?: {movementKind?: string; tokenRef?: string; origin?: {footprint?: Data}}} | null) {
    const data = event?.data;
    if ( (event?.type !== AUTOMATION_EVENT_TYPES.MOVEMENT_COMPLETED) || (data?.movementKind !== "voluntary") || !isActiveGM() ) return [];
    const ref = parseEntityRef(data.tokenRef) as {ok: boolean; scope?: unknown; id?: unknown};
    const scene = ref.ok ? game.scenes?.get(String(ref.scope)) : undefined;
    const mover = scene?.tokens.get(String(ref.id)) as (AreaToken & {actor: Actor & RamActor | null}) | undefined;
    if ( !scene || !mover?.actor || !((Number(mover.actor.getStatistic?.(["occupancy.ram"])?.totalModifier) || 0) > 0) ) return [];
    // Only those it entered: a creature it was already in when it set out was rammed then.
    const origin = data.origin?.footprint;
    const before = new Set(origin ? sharingSpace(mover as never, origin as never).map(token => token.id) : []);
    const struck = (sharingSpace(mover as never) as unknown as AreaToken[]).filter(token => !before.has(token.id));
    if ( !struck.length ) return [];
    const movement = mover.actor.system?.resources?.movement;
    if ( movement && (Number(movement.spent) < Number(movement.max)) ) {
      await mover.actor.update?.({"system.resources.movement.spent": movement.max});
    }
    const applied = [];
    for ( const {region, flag} of sceneAreas(scene).filter(({flag}) => flag.attached && (anchorOf(flag) === mover.id)
      && answers(flag, AREA_EVENTS.RAMMED)) ) {
      for ( const token of struck ) applied.push(...await apply(region, flag, token, AREA_EVENTS.RAMMED));
    }
    return applied;
  }

  /** Whether any lasting area on the Scene answers entering, leaving or moving in it; moves there are then checkpointed per step. */
  function hasCrossingAreas(scene: AreaScene) {
    return sceneAreas(scene).some(({flag}) => [AREA_EVENTS.ENTERED, AREA_EVENTS.EXITED, AREA_EVENTS.MOVED]
      .some(event => answers(flag, event)));
  }

  /**
   * A placed lasting area now covers `fields` (moved by its caster's Action, or dragged by the GM). They become its
   * fields, and each creature newly inside it is entered ("when the Cylinder moves into its space"), once per turn.
   * Its triggers, cast level included, go with it.
   */
  async function relocate(region: AreaRegion, fields: Field[], {drawn=false}: {drawn?: boolean}={}) {
    const flag = region.flags?.wildpath?.area;
    const scene = region.parent;
    if ( !flag || flag.attached || !scene ) return [];
    const before = new Set([...scene.tokens].filter(token => areaCovers(flag, token)).map(token => token.id));
    const offsets = fields.map(field => toOffset(field, {grid: scene.grid}).offset).filter(Boolean);
    await region.update({...(drawn ? {} : {shapes: [{type: "grid", offsets}]}), "flags.wildpath.area.fields": fields},
      {wildpath: {areaMove: true}});
    if ( flag.persistence.walls === "open" ) await syncOpenedWalls(region);
    const moved = {...flag, fields};
    const applied = [];
    for ( const token of [...scene.tokens].filter(token => !before.has(token.id) && areaCovers(moved, token)) ) {
      if ( answers(moved, AREA_EVENTS.ENTERED) ) applied.push(...await apply(region, moved, token, AREA_EVENTS.ENTERED));
    }
    // A creature the area moved off is no longer in it: what it held only while in it ends.
    if ( releases(moved) ) {
      for ( const token of [...scene.tokens].filter(token => before.has(token.id) && !areaCovers(moved, token)) ) await release(region, token);
    }
    return applied;
  }

  /** After an Action that moves its caster's lasting area (`options.areaMove`: its Region and new fields). */
  async function move({options}: {options?: {areaMove?: {sceneId: string; regionId: string; fields: Field[]}}}) {
    const moving = options?.areaMove;
    if ( !moving || !isActiveGM() ) return [];
    const region = [...(game.scenes?.get(moving.sceneId)?.regions ?? [])].find(entry => entry.id === moving.regionId);
    return region ? relocate(region, moving.fields) : [];
  }

  /**
   * The GM dragged a lasting area's Region: its fields follow the cells now drawn. A blocking area (`persistence.blocks`)
   * is drawn back where it was instead, so its walls never drift from its fields, and the GM is told.
   */
  async function onRegionUpdated(region: AreaRegion, changed: Data, operation: {wildpath?: {areaMove?: boolean}} = {}) {
    if ( !isActiveGM() || operation?.wildpath?.areaMove || !changed?.shapes || !region.parent ) return [];
    const flag = region.flags?.wildpath?.area;
    if ( flag?.persistence.blocks ) {
      const offsets = flag.fields.map(field => toOffset(field, {grid: region.parent!.grid}).offset).filter(Boolean);
      await region.update({shapes: [{type: "grid", offsets}]}, {wildpath: {areaMove: true}});
      gmNotice("WILDPATH.NOTICE.AreaFixed", {name: flag.label}, undefined, {game, logger});
      return [];
    }
    const offsets = region.shapes?.find(shape => shape.type === "grid")?.offsets ?? [];
    const fields = offsets.map(offset => (foundryOffsetToGridField as (offset: Data, options: Data) => {ok: boolean; field?: Field})(offset,
      {scene: region.parent}).field).filter((field): field is Field => !!field);
    return fields.length ? relocate(region, fields, {drawn: true}) : [];
  }

  return {create, carry, end, endWithSource, apply, onTurn, entered, exited, moved, swept, rammed, hasCrossingAreas, afterResolution, onEffectDeleted,
    onRegionDeleted, onTokenDeleted, move, onRegionUpdated, rollOpenings, openOpenings};
}
