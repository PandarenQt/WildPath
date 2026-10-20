/**
 * A creature's senses on its Token (Foundry 14): its sight range and vision mode, and its detection modes, follow its
 * senses (`system.senses`, helpers/senses.mts) as dnd5e's do. Darkvision and Truesight see in the dark (vision mode
 * `darkvision`, the best range of the two); Truesight also sees everything within its range (`seeAll`); Tremorsense
 * feels what touches the ground (`feelTremor`); Blindsight perceives without sight (`blindsight`, registered here).
 */

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
  const sight = Math.max(range("darkvision"), range("truesight"));
  // Its sight stays on or off as its Token is set; its range and mode are its senses'.
  token.sight.range = sight;
  token.sight.visionMode = sight > 0 ? "darkvision" : "basic";
  const modes: Array<[string, number]> = [["seeAll", range("truesight")], ["feelTremor", range("tremorsense")], ["blindsight", range("blindsight")]];
  for ( const [id, distance] of modes ) {
    if ( distance > 0 ) token.detectionModes[id] = {enabled: true, range: distance};
  }
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
