/**
 * A creature's senses on its Token (Foundry 14): its sight range and vision mode, and its detection modes, follow its
 * senses (`system.senses`, helpers/senses.mts) as dnd5e's do. Darkvision, Truesight and Devil's Sight see in the dark
 * (vision mode `darkvision`, the best range of the three); Truesight and Devil's Sight also see through magical Darkness
 * (registerDarknessSight); Truesight sees everything within its range (`seeAll`); Tremorsense feels what touches the
 * ground (`feelTremor`); Blindsight perceives without sight (`blindsight`, registered here).
 */

import {obscured, onGround, perceives} from "../helpers/senses.mjs";
import {inBrightLight, lightAt, sunlightContext} from "./foundry-v14-sunlight.mjs";
import {areaObscurityAt, heavilyObscuredAt} from "./foundry-v14-persistent-areas.mjs";
import type {Obscurity} from "./foundry-v14-persistent-areas.mjs";
import {environmentContext} from "./foundry-v14-environment.mjs";
import {tokensHostile} from "./foundry-v14-hostility.mjs";
import {COVER_ORDER, coverBetween, foundrySightCollision, heldCover} from "./foundry-v14-cover.mjs";
import type {CoverDegree} from "./foundry-v14-cover.mjs";
import {createFoundryV14TacticalGridAdapter, foundryTokenCreatureSize} from "./foundry-v14-tactical-grid-adapter.mjs";
import {footprintDistance} from "../helpers/grid-footprints.mjs";
import {evaluatePredicate} from "../helpers/predicates.mjs";

type Data = Record<string, unknown>;
interface DetectionModeData {enabled?: boolean; range?: number | null}
interface SensingToken {
  sight: {enabled?: boolean; range?: number | null; visionMode?: string};
  detectionModes: Record<string, DetectionModeData>;
  actor?: {system?: {senses?: Partial<Record<string, number>> | null} | null} | null;
}

/** Its creature's senses applied to a Token's prepared sight and detection modes (before Foundry fills the rest). */
export function applySensesToToken(token: SensingToken) {
  const senses = token.actor?.system?.senses;
  if ( !senses ) return;
  const range = (sense: string) => Math.max(Number(senses[sense]) || 0, 0);
  const sight = Math.max(range("darkvision"), range("truesight"), range("devilsSight"));
  // Its sight stays on or off as its Token is set; its range and mode are its senses'.
  token.sight.range = sight;
  token.sight.visionMode = sight > 0 ? "darkvision" : "basic";
  const modes: Array<[string, number]> = [["seeAll", range("truesight")], ["feelTremor", range("tremorsense")], ["blindsight", range("blindsight")],
    ["seeInvisibility", range("seeInvisibility")]];
  for ( const [id, distance] of modes ) {
    if ( distance > 0 ) token.detectionModes[id] = {enabled: true, range: distance};
  }
}

/**
 * Devil's Sight and Truesight see through magical Darkness (2024): a Token with either has a vision source of the
 * highest priority, which a darkness source neither blinds (`PointVisionSource`: blinded while its priority is at most
 * the darkness's) nor walls off (a polygon skips edges of a lower priority than its own). Others keep priority 0, so
 * any Darkness blinds them. Its range is its sight's, the best of its senses that see in the dark.
 */
export function registerDarknessSight(config: Data) {
  const tokens = (config as {Token?: {objectClass?: new (...args: never[]) => object}}).Token;
  const Base = tokens?.objectClass as unknown as (new (...args: never[]) => {_getVisionSourceData(): Data}) | undefined;
  if ( !tokens || !Base ) return;
  class WildPathToken extends Base {
    declare document: {actor?: {system?: {senses?: Partial<Record<string, number>> | null} | null} | null};
    /** @inheritDoc */
    override _getVisionSourceData() {
      const data = super._getVisionSourceData();
      const senses = this.document?.actor?.system?.senses ?? {};
      return ((Number(senses.devilsSight) > 0) || (Number(senses.truesight) > 0)) ? {...data, priority: Number.MAX_SAFE_INTEGER} : data;
    }
  }
  tokens.objectClass = WildPathToken as never;
}

type Creature = Parameters<typeof perceives>[0];
type Placed = Parameters<typeof lightAt>[0] & Parameters<typeof onGround>[0];

/**
 * Whether an attacker and its target see each other (2024): despite Blinded and Invisible (`perceives`), and in the
 * light each stands in (`obscured`): `seesTarget`, `seenByTarget`. `targetHidden` and `attackerHidden` mark one that
 * only light hides (it would be perceived in light): every creature's unseen rules read those (documents/actor.mjs), so
 * Invisible in Darkness is still one source of Disadvantage. `distance` in feet.
 */
export function attackSight({attacker, target, attackerToken = null, targetToken = null, distance = null, targetLit = false}: {attacker: Creature;
  target: Creature; attackerToken?: Placed | null; targetToken?: Placed | null; distance?: number | null;
  /** The target sheds its own light as it acts (the Robe of Scintillating Colors): plain darkness doesn't hide it. */
  targetLit?: boolean}) {
  // Fog hides more than any darkness (Truesight doesn't pierce it), so a Heavily Obscured area wins over its light.
  const at = (token: Placed | null) => (heavilyObscuredAt(token as never) ? "heavilyObscured" as const : lightAt(token));
  const attackerLight = at(attackerToken);
  const ownLight = at(targetToken);
  const targetLight = (targetLit && (ownLight === "dark")) ? "light" as const : ownLight;
  const perceivesTarget = perceives(attacker, target, {distance, grounded: onGround(targetToken)});
  const perceivedByTarget = perceives(target, attacker, {distance, grounded: onGround(attackerToken)});
  const targetHidden = perceivesTarget && obscured(attacker, {distance, grounded: onGround(targetToken), observerLight: attackerLight,
    observedLight: targetLight});
  const attackerHidden = perceivedByTarget && obscured(target, {distance, grounded: onGround(attackerToken), observerLight: targetLight,
    observedLight: attackerLight});
  return {seesTarget: perceivesTarget && !targetHidden, seenByTarget: perceivedByTarget && !attackerHidden, targetHidden, attackerHidden};
}

/**
 * Whether `viewer`'s creature sees `seen`'s on `scene` ("a creature you can see", one way): it perceives it (Blinded,
 * Invisible, light, Heavily Obscured: attackSight) and no wall blocking sight hides it entirely (Total Cover). A Token
 * sees itself. `distance` in feet between their spaces, worked out here when not given; `lit`: `seen` sheds its own
 * light as it acts, so plain darkness doesn't hide it (attackSight's `targetLit`).
 */
export function tokenSees(scene: unknown, viewer: SightToken | null | undefined, seen: SightToken | null | undefined,
  {distance, lit=false}: {distance?: number | null; lit?: boolean} = {}) {
  if ( !viewer?.actor || !seen?.actor ) return false;
  if ( viewer.id === seen.id ) return true;
  if ( distance === undefined ) {
    const grid = createFoundryV14TacticalGridAdapter({scene: scene as never}) as {tokenToFootprint(token: unknown): {ok: boolean; footprint?: unknown}};
    const [from, to] = [viewer, seen].map(token => { const result = grid.tokenToFootprint(token); return result.ok ? result.footprint : null; });
    const fields = (from && to) ? (footprintDistance as unknown as (a: unknown, b: unknown) => number)(from, to) : NaN;
    distance = Number.isFinite(fields) ? fields * (Number((scene as {grid?: {distance?: number}})?.grid?.distance) || 5) : null;
  }
  const collides = foundrySightCollision(scene);
  if ( collides && (coverBetween({source: viewer as never, target: seen as never, collides}) === "total") ) return false;
  return attackSight({attacker: viewer.actor as never, target: seen.actor as never, attackerToken: viewer as never, targetToken: seen as never,
    distance, targetLit: lit}).seesTarget;
}
interface SightToken {id: string; actor?: unknown}

type PlaceToken = Parameters<typeof lightAt>[0] & Parameters<typeof environmentContext>[0] & Parameters<typeof areaObscurityAt>[0];

/**
 * How obscured the place a Token stands in is (2024), the strongest source winning: "heavily" in a Heavily Obscured
 * lasting area (Fog Cloud) or in darkness, magical or not; "lightly" in a Lightly Obscured lasting area (Web), in Dim
 * Light, or where the GM tags a Region or Scene `lightlyObscured` (fog, foliage: environmentContext); else null. A Scene
 * without Token vision is all Bright Light (Q60), so only an area or a tag obscures it there.
 */
export function obscurityAt(token: PlaceToken | null | undefined): Obscurity | null {
  if ( !token?.parent ) return null;
  const area = areaObscurityAt(token as never);
  if ( (area === "heavily") || (lightAt(token) !== "light") ) return "heavily";
  if ( area || !inBrightLight(token) || (environmentContext(token).environment?.lightlyObscured === true) ) return "lightly";
  return null;
}

interface FoeToken {id: string; hidden?: boolean; actor?: {statuses?: {has?(status: string): boolean}} | null}

/**
 * The least cover a Token has from the creatures hostile to it on its Scene, from each the better of the cover condition
 * it holds (heldCover) and the walls and creatures between (coverBetween), as an attack from that foe counts it: what 2024
 * Hide asks ("behind Three-Quarters Cover or Total Cover"). Null with no Scene or no foe there. A dead foe sees no one,
 * and a GM-hidden one is left out, so a player's action bar doesn't tell of it.
 */
export function coverFromFoes(token: (FoeToken & {parent?: {id?: string; tokens?: Iterable<FoeToken>} | null}) | null | undefined): CoverDegree | null {
  const scene = token?.parent;
  const collides = foundrySightCollision(scene);
  if ( !token || !scene || !collides ) return null;
  const defeated = (globalThis as {CONFIG?: {specialStatusEffects?: {DEFEATED?: string}}}).CONFIG?.specialStatusEffects?.DEFEATED ?? "dead";
  let least: CoverDegree | null = null;
  for ( const foe of scene.tokens ?? [] ) {
    if ( !foe.actor || (foe.id === token.id) || (foe.hidden === true) || foe.actor.statuses?.has?.(defeated) || !tokensHostile(token, foe) ) continue;
    const held = heldCover(token, foe);
    const walls = (held === "total") ? held : coverBetween({source: foe as never, target: token as never, collides});
    const degree = (COVER_ORDER.indexOf(walls) >= COVER_ORDER.indexOf(held)) ? walls : held;
    if ( (least === null) || (COVER_ORDER.indexOf(degree) < COVER_ORDER.indexOf(least)) ) least = degree;
    if ( least === "none" ) break;
  }
  return least;
}

/**
 * What an Action's `requires` reads of where its Token stands: its light (sunlightContext: `inSunlight`, `inBrightLight`),
 * its place's tags (environmentContext: `environment.<tag>`), how obscured it is (`obscured`: obscurityAt) and the least
 * cover it has from its foes (`coverFromFoes`); none of them without a Token. The authority and the action bar both read it.
 */
export function placeContext(token: (PlaceToken & FoeToken) | null | undefined): Data {
  const obscured = obscurityAt(token);
  const cover = coverFromFoes(token as never);
  return {...sunlightContext(token), ...environmentContext(token), ...(obscured ? {obscured} : {}), ...(cover ? {coverFromFoes: cover} : {})};
}

/**
 * Whether a creature's Token fails a `targeting.eligible` predicate (Dreadful Glare: "If the target can see the mummy"; a
 * Vrock's screech: "that can hear it and that isn't a demon"), judged on what the Scene says of it: its statuses
 * (`conditions`), its creature data (`actor.system.details`: type, subtype), its size (`size`: its Token's, as a push judges
 * it; a redirect's "a Small or Medium ally"), and whether it sees `sourceToken` and is seen
 * by it (`seesSource`, `seenBySource`: tokenSees; `seesLitSource`: seeing a source that sheds its own light as it acts,
 * the Robe of Scintillating Colors), each sight worked out only when read. Read by the Foundry runtime (declared targets,
 * an area's creatures), lasting areas, automatic triggers and a redirect's candidates (redirectTokens); not by the pipeline,
 * whose candidates carry none of these.
 */
export function ineligibleTarget(predicate: unknown, token: EligibleToken | null | undefined, sourceToken: EligibleToken | null | undefined) {
  if ( !predicate ) return false;
  const scene = token?.parent ?? sourceToken?.parent;
  const facts = {conditions: [...(token?.actor?.statuses ?? [])], actor: {system: {details: token?.actor?.system?.details ?? {}}},
    get size() { return (foundryTokenCreatureSize as (token: unknown) => string)(token); },
    get seesSource() { return tokenSees(scene, token, sourceToken); },
    get seesLitSource() { return tokenSees(scene, token, sourceToken, {lit: true}); },
    get seenBySource() { return tokenSees(scene, sourceToken, token); }};
  return !(evaluatePredicate as (predicate: unknown, context: unknown) => {ok: boolean})(predicate, facts).ok;
}
interface EligibleToken {id: string; parent?: unknown; actor?: {statuses?: Iterable<string>; system?: {details?: unknown}} | null}

/** A key that changes when its creature's senses do (its Token's vision is then prepared again). */
export function sensesKey(token: SensingToken) {
  const system = token.actor?.system as {senses?: unknown; light?: unknown} | null | undefined;
  return JSON.stringify([system?.senses ?? null, system?.light ?? null]);
}

/**
 * Its creature's light on its Token (a lit Torch): the Token's own light, unless its creature's is brighter (by its dim
 * radius). Prepared, never stored, so putting the Torch out gives the Token its own light back.
 */
export function applyLightToToken(token: {light?: Data | null; actor?: {system?: {light?: {bright: number; dim: number; angle?: number} | null} | null} | null}) {
  const light = token.actor?.system?.light;
  if ( !light || !token.light || ((Number(token.light.dim) || 0) >= light.dim) ) return;
  Object.assign(token.light, {bright: light.bright, dim: light.dim, ...(light.angle ? {angle: light.angle} : {})});
}

/**
 * Blindsight (2024): perceives within its range without sight, so Blinded does not stop it and the Invisible do not
 * hide from it; walls still block it; darkness does not. Registered as `CONFIG.Canvas.detectionModes.blindsight`.
 */
export function registerBlindsight(config: Data, foundryApi: Data) {
  const perception = (foundryApi as {canvas?: {perception?: {DetectionMode?: new (data: Data) => object}}}).canvas?.perception;
  const Base = perception?.DetectionMode as unknown as (new (data: Data) => {walls?: boolean}) & {DETECTION_TYPES?: Record<string, number>};
  const canvas = (config as {Canvas?: {detectionModes?: Record<string, unknown>}}).Canvas;
  const other = Base?.DETECTION_TYPES?.OTHER;
  if ( !Base || !canvas?.detectionModes || (other === undefined) ) return;
  const special = (config as {specialStatusEffects?: Record<string, string>}).specialStatusEffects ?? {};
  class DetectionModeBlindsight extends Base {
    _canDetect(visionSource: {object?: {document?: {hasStatusEffect?(id: string): boolean}}}, target: {document?: {hasStatusEffect?(id: string): boolean}} | null) {
      const burrow = special.BURROW ?? "burrow";
      if ( visionSource.object?.document?.hasStatusEffect?.(burrow) ) return false;
      return !target?.document?.hasStatusEffect?.(burrow);
    }
  }
  canvas.detectionModes.blindsight = new DetectionModeBlindsight({id: "blindsight", label: "WILDPATH.SENSES.blindsight",
    type: other, walls: true, angle: false});
}
