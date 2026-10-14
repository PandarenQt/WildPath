import { createCombatCarouselViewModel } from "./ui-view-models.mjs";
import { activeEffectViews } from "./effect-views.mjs";
const viewModel = createCombatCarouselViewModel;
export function combatCarouselContext({ combat, isGM = false, conditions = [] }) {
    const view = viewModel({ combat, includeHidden: isGM });
    const byId = new Map(combat.turns.map(combatant => [combatant.id, combatant]));
    return {
        round: view.round,
        // The GM, or whoever owns the creature whose turn it is, may end the turn (Foundry's own rule for nextTurn).
        canAdvance: isGM || (combat.combatant?.isOwner === true),
        turns: view.turns.map(turn => {
            const combatant = byId.get(turn.id);
            const actor = combatant?.actor ?? null;
            const health = actor?.system?.resources?.health;
            const owned = isGM || (actor?.isOwner === true);
            return {
                id: turn.id,
                name: turn.label,
                img: combatant?.img ?? null,
                active: turn.active,
                defeated: turn.defeated,
                hidden: turn.hidden,
                health: owned && health && Number(health.max) > 0 ? { value: Number(health.value) || 0, max: Number(health.max),
                    percent: Math.round(Math.min(Math.max((Number(health.value) || 0) / Number(health.max), 0), 1) * 100) } : null,
                conditions: activeEffectViews(actor?.effects ?? [], conditions)
            };
        })
    };
}
