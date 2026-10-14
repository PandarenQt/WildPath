import {createCombatCarouselViewModel} from "./ui-view-models.mjs";

/**
 * What the in-play combat carousel shows (M6): the combat's turn order from the shared carousel view model, each
 * creature's portrait and active conditions, and its health only to those who own it. A hidden combatant shows to
 * the GM alone. Health and conditions come from each combatant's own Token creature, so unlinked Tokens of one
 * Actor stay apart.
 */

interface ConditionDefinition {id: string; name: string; img: string; stacking?: boolean}
interface CarouselActor {
  isOwner?: boolean;
  effects?: Iterable<{system?: {type?: string; level?: number}; disabled?: boolean}>;
  system?: {resources?: {health?: {value?: number; max?: number}}};
}
interface CarouselCombatant {
  id: string; name?: string; img?: string | null; actorId?: string | null; tokenId?: string | null; sceneId?: string | null;
  initiative?: number | null; defeated?: boolean; hidden?: boolean; isOwner?: boolean; actor?: CarouselActor | null;
}
interface CarouselCombat {id: string; round: number; turn: number | null; turns: readonly CarouselCombatant[]; combatant?: CarouselCombatant | null}
interface TurnView {id: string; label: string; active: boolean; defeated: boolean; hidden: boolean}
interface CarouselView {round: number; turns: TurnView[]}

const viewModel = createCombatCarouselViewModel as unknown as (options: {combat: CarouselCombat; includeHidden: boolean}) => CarouselView;

export function combatCarouselContext({combat, isGM=false, conditions=[]}: {combat: CarouselCombat; isGM?: boolean;
  conditions?: readonly ConditionDefinition[]}) {
  const view = viewModel({combat, includeHidden: isGM});
  const byId = new Map(combat.turns.map(combatant => [combatant.id, combatant]));
  return {
    round: view.round,
    // The GM, or whoever owns the creature whose turn it is, may end the turn (Foundry's own rule for nextTurn).
    canAdvance: isGM || (combat.combatant?.isOwner === true),
    turns: view.turns.map(turn => {
      const combatant = byId.get(turn.id);
      const actor = combatant?.actor ?? null;
      const health = actor?.system?.resources?.health;
      const levels = new Map([...(actor?.effects ?? [])].filter(effect => !effect.disabled && effect.system?.type)
        .map(effect => [String(effect.system!.type), Number(effect.system!.level) || null]));
      const owned = isGM || (actor?.isOwner === true);
      return {
        id: turn.id,
        name: turn.label,
        img: combatant?.img ?? null,
        active: turn.active,
        defeated: turn.defeated,
        hidden: turn.hidden,
        health: owned && health && Number(health.max) > 0 ? {value: Number(health.value) || 0, max: Number(health.max),
          percent: Math.round(Math.min(Math.max((Number(health.value) || 0) / Number(health.max), 0), 1) * 100)} : null,
        conditions: conditions.filter(condition => levels.has(condition.id)).map(condition => ({id: condition.id,
          name: condition.name, img: condition.img, level: condition.stacking ? levels.get(condition.id) ?? null : null}))
      };
    })
  };
}
