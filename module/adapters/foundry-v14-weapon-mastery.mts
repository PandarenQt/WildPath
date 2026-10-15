import {runAuthorityAction} from "./foundry-v14-automation-dispatcher.mjs";
import {FOLLOW_UP_MASTERIES} from "../helpers/weapon-mastery.mjs";
import {actorAbilityModifier, actorProficiencyBonus, attackAbility} from "../helpers/combat-statistics.mjs";

/**
 * Weapon Mastery that follows an attack (2024, G8; helpers/weapon-mastery.mts): once an attack with Topple or Graze
 * (`attack.mastery`) completes, the active GM resolves the rider as its own authority Action for each creature it
 * concerns. Topple: a creature hit makes a Fortitude save (DC 8 + the attack's ability modifier + Proficiency Bonus)
 * or has the Prone condition. Graze: a creature missed takes damage equal to that modifier, of the weapon's type.
 */

type Data = Record<string, unknown>;
interface MasteryToken {id: string; actor?: {uuid: string} | null; parent?: {id: string; tokens: {get(id: string): MasteryToken | undefined}} | null}
interface AttackResult {ok?: boolean; hit?: boolean; target?: {tokenId?: string}}
interface MasteryState {
  actionDefinition?: {id?: string; attack?: {mastery?: string; type?: string} & Data; damage?: Array<{damageType?: string}>; tags?: string[]};
  source?: {tokenRef?: string};
  results?: {attackResolution?: {results?: AttackResult[]}};
}

export function createFoundryWeaponMastery({game, coordinator, resolveAction, fromUuid, logger=console}: {
  game: {users?: {activeGM?: {id?: string} | null}; user?: {id?: string}; i18n?: {localize?(key: string): string}};
  coordinator: unknown; resolveAction: unknown; fromUuid: (uuid: string) => Promise<unknown> | unknown; logger?: Pick<Console, "warn">;
}) {
  const isActiveGM = () => Boolean(game.user?.id) && (game.users?.activeGM?.id === game.user?.id);
  let sequence = 0;

  async function afterResolution({state}: {state?: MasteryState}) {
    const definition = state?.actionDefinition;
    const mastery = definition?.attack?.mastery;
    if ( !mastery || !FOLLOW_UP_MASTERIES.includes(mastery) || !isActiveGM() ) return [];
    const sourceToken = await fromUuid(String(state?.source?.tokenRef ?? "")) as MasteryToken | null;
    const attacker = sourceToken?.actor;
    const scene = sourceToken?.parent;
    if ( !attacker || !scene ) return [];
    const modifier = actorAbilityModifier(attacker, attackAbility(attacker, definition.attack)) ?? 0;
    const results = (state?.results?.attackResolution?.results ?? []).filter(result => (result.ok !== false) && result.target?.tokenId
      && (result.hit === (mastery === "topple")));
    const label = game.i18n?.localize?.(`WILDPATH.MASTERY.${mastery}`) ?? mastery;
    const rider: Data | null = mastery === "topple"
      ? {save: {ability: "fortitude", dc: {value: 8 + modifier + actorProficiencyBonus(attacker)}},
        effects: [{id: "topple-prone", type: "condition", conditionId: "prone", saveOutcomePolicy: "failure"}]}
      // Graze deals nothing with a modifier of 0 or less.
      : (modifier > 0 ? {damage: [{id: "graze", expression: {type: "constant", value: modifier},
        damageType: definition.damage?.[0]?.damageType ?? "bludgeoning"}]} : null);
    if ( !rider ) return [];
    const done = [];
    for ( const result of results ) {
      const target = scene.tokens.get(String(result.target!.tokenId));
      if ( !target?.actor ) continue;
      done.push(await runAuthorityAction({coordinator: coordinator as never, resolveAction: resolveAction as never, logger,
        senderUserId: String(game.user?.id), resolutionId: `mastery:${mastery}:${attacker.uuid}:${++sequence}`, label, actorRef: attacker.uuid,
        source: {tokenId: sourceToken.id, sceneId: scene.id}, target: {actorRef: target.actor.uuid, tokenId: target.id, sceneId: scene.id},
        definition: {schemaVersion: 1, id: `action:mastery-${mastery}`, label, costs: {allOf: []}, tags: ["weapon-mastery"], ...rider}}));
    }
    return done;
  }

  return {afterResolution};
}
