/**
 * A creature's senses on its Token (Foundry 14): its sight range and vision mode, and its detection modes, follow its
 * senses (`system.senses`, helpers/senses.mts) as dnd5e's do. Darkvision, Truesight and Devil's Sight see in the dark
 * (vision mode `darkvision`, the best range of the three); Truesight and Devil's Sight also see through magical Darkness
 * (registerDarknessSight); Truesight sees everything within its range (`seeAll`); Tremorsense feels what touches the
 * ground (`feelTremor`); Blindsight perceives without sight (`blindsight`, registered here).
 */
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
    const modes = [["seeAll", range("truesight")], ["feelTremor", range("tremorsense")], ["blindsight", range("blindsight")]];
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
/** A key that changes when its creature's senses do (its Token's vision is then prepared again). */
export function sensesKey(token) {
    return JSON.stringify(token.actor?.system?.senses ?? null);
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
