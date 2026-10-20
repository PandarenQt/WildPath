/**
 * A creature's senses on its Token (Foundry 14): its sight range and vision mode, and its detection modes, follow its
 * senses (`system.senses`, helpers/senses.mts) as dnd5e's do. Darkvision, Truesight and Devil's Sight see in the dark
 * (vision mode `darkvision`, the best range of the three); Truesight and Devil's Sight also see through magical Darkness
 * (registerDarknessSight); Truesight sees everything within its range (`seeAll`); Tremorsense feels what touches the
 * ground (`feelTremor`); Blindsight perceives without sight (`blindsight`, registered here).
 */

import {obscured, onGround, perceives} from "../helpers/senses.mjs";
import {lightAt} from "./foundry-v14-sunlight.mjs";

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
  const modes: Array<[string, number]> = [["seeAll", range("truesight")], ["feelTremor", range("tremorsense")], ["blindsight", range("blindsight")]];
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
export function attackSight({attacker, target, attackerToken = null, targetToken = null, distance = null}: {attacker: Creature;
  target: Creature; attackerToken?: Placed | null; targetToken?: Placed | null; distance?: number | null}) {
  const attackerLight = lightAt(attackerToken);
  const targetLight = lightAt(targetToken);
  const perceivesTarget = perceives(attacker, target, {distance, grounded: onGround(targetToken)});
  const perceivedByTarget = perceives(target, attacker, {distance, grounded: onGround(attackerToken)});
  const targetHidden = perceivesTarget && obscured(attacker, {distance, grounded: onGround(targetToken), observerLight: attackerLight,
    observedLight: targetLight});
  const attackerHidden = perceivedByTarget && obscured(target, {distance, grounded: onGround(attackerToken), observerLight: targetLight,
    observedLight: attackerLight});
  return {seesTarget: perceivesTarget && !targetHidden, seenByTarget: perceivedByTarget && !attackerHidden, targetHidden, attackerHidden};
}

/** A key that changes when its creature's senses do (its Token's vision is then prepared again). */
export function sensesKey(token: SensingToken) {
  return JSON.stringify(token.actor?.system?.senses ?? null);
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
