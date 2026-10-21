/**
 * A creature's senses on its Token (Foundry 14): its sight range and vision mode, and its detection modes, follow its
 * senses (`system.senses`, helpers/senses.mts) as dnd5e's do. Darkvision, Truesight and Devil's Sight see in the dark
 * (vision mode `darkvision`, the best range of the three); Truesight and Devil's Sight also see through magical Darkness
 * (registerDarknessSight); Truesight sees everything within its range (`seeAll`); Tremorsense feels what touches the
 * ground (`feelTremor`); Blindsight perceives without sight (`blindsight`, registered here).
 */
import { obscured, onGround, perceives } from "../helpers/senses.mjs";
import { lightAt } from "./foundry-v14-sunlight.mjs";
/** Its creature's senses applied to a Token's prepared sight and detection modes (before Foundry fills the rest). */
export function applySensesToToken(token) {
    const senses = token.actor?.system?.senses;
    if (!senses)
        return;
    const range = (sense) => Math.max(Number(senses[sense]) || 0, 0);
    const sight = Math.max(range("darkvision"), range("truesight"), range("devilsSight"));
    // Its sight stays on or off as its Token is set; its range and mode are its senses'.
    token.sight.range = sight;
    token.sight.visionMode = sight > 0 ? "darkvision" : "basic";
    const modes = [["seeAll", range("truesight")], ["feelTremor", range("tremorsense")], ["blindsight", range("blindsight")],
        ["seeInvisibility", range("seeInvisibility")]];
    for (const [id, distance] of modes) {
        if (distance > 0)
            token.detectionModes[id] = { enabled: true, range: distance };
    }
}
/**
 * Devil's Sight and Truesight see through magical Darkness (2024): a Token with either has a vision source of the
 * highest priority, which a darkness source neither blinds (`PointVisionSource`: blinded while its priority is at most
 * the darkness's) nor walls off (a polygon skips edges of a lower priority than its own). Others keep priority 0, so
 * any Darkness blinds them. Its range is its sight's, the best of its senses that see in the dark.
 */
export function registerDarknessSight(config) {
    const tokens = config.Token;
    const Base = tokens?.objectClass;
    if (!tokens || !Base)
        return;
    class WildPathToken extends Base {
        /** @inheritDoc */
        _getVisionSourceData() {
            const data = super._getVisionSourceData();
            const senses = this.document?.actor?.system?.senses ?? {};
            return ((Number(senses.devilsSight) > 0) || (Number(senses.truesight) > 0)) ? { ...data, priority: Number.MAX_SAFE_INTEGER } : data;
        }
    }
    tokens.objectClass = WildPathToken;
}
/**
 * Whether an attacker and its target see each other (2024): despite Blinded and Invisible (`perceives`), and in the
 * light each stands in (`obscured`): `seesTarget`, `seenByTarget`. `targetHidden` and `attackerHidden` mark one that
 * only light hides (it would be perceived in light): every creature's unseen rules read those (documents/actor.mjs), so
 * Invisible in Darkness is still one source of Disadvantage. `distance` in feet.
 */
export function attackSight({ attacker, target, attackerToken = null, targetToken = null, distance = null }) {
    const attackerLight = lightAt(attackerToken);
    const targetLight = lightAt(targetToken);
    const perceivesTarget = perceives(attacker, target, { distance, grounded: onGround(targetToken) });
    const perceivedByTarget = perceives(target, attacker, { distance, grounded: onGround(attackerToken) });
    const targetHidden = perceivesTarget && obscured(attacker, { distance, grounded: onGround(targetToken), observerLight: attackerLight,
        observedLight: targetLight });
    const attackerHidden = perceivedByTarget && obscured(target, { distance, grounded: onGround(attackerToken), observerLight: targetLight,
        observedLight: attackerLight });
    return { seesTarget: perceivesTarget && !targetHidden, seenByTarget: perceivedByTarget && !attackerHidden, targetHidden, attackerHidden };
}
/** A key that changes when its creature's senses do (its Token's vision is then prepared again). */
export function sensesKey(token) {
    const system = token.actor?.system;
    return JSON.stringify([system?.senses ?? null, system?.light ?? null]);
}
/**
 * Its creature's light on its Token (a lit Torch): the Token's own light, unless its creature's is brighter (by its dim
 * radius). Prepared, never stored, so putting the Torch out gives the Token its own light back.
 */
export function applyLightToToken(token) {
    const light = token.actor?.system?.light;
    if (!light || !token.light || ((Number(token.light.dim) || 0) >= light.dim))
        return;
    Object.assign(token.light, { bright: light.bright, dim: light.dim, ...(light.angle ? { angle: light.angle } : {}) });
}
/**
 * Blindsight (2024): perceives within its range without sight, so Blinded does not stop it and the Invisible do not
 * hide from it; walls still block it; darkness does not. Registered as `CONFIG.Canvas.detectionModes.blindsight`.
 */
export function registerBlindsight(config, foundryApi) {
    const perception = foundryApi.canvas?.perception;
    const Base = perception?.DetectionMode;
    const canvas = config.Canvas;
    const other = Base?.DETECTION_TYPES?.OTHER;
    if (!Base || !canvas?.detectionModes || (other === undefined))
        return;
    const special = config.specialStatusEffects ?? {};
    class DetectionModeBlindsight extends Base {
        _canDetect(visionSource, target) {
            const burrow = special.BURROW ?? "burrow";
            if (visionSource.object?.document?.hasStatusEffect?.(burrow))
                return false;
            return !target?.document?.hasStatusEffect?.(burrow);
        }
    }
    canvas.detectionModes.blindsight = new DetectionModeBlindsight({ id: "blindsight", label: "WILDPATH.SENSES.blindsight",
        type: other, walls: true, angle: false });
}
