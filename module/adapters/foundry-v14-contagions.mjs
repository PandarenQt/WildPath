import {CONTAGIONS, fightContagion} from "../helpers/contagions.mjs";

/**
 * Contagions on Foundry (helpers/contagions.mjs), run by the active GM: an infection's incubation when it is caught, its
 * symptoms when that time comes, and its fight after each Long Rest (Actor#rest).
 */

const DAY = 86400;
const contagionOf = effect => {
  const id = effect?.flags?.wildpath?.conditionEffect?.metadata?.contagion ?? effect?.flags?.wildpath?.contagion?.id;
  return CONTAGIONS[id] ? id : null;
};
const exhaustionOf = actor => [...(actor?.effects ?? [])].filter(effect => effect.system?.type === "exhaustion")
  .reduce((level, effect) => Math.max(level, Number(effect.system?.level) || 0), 0);

/** A creature's contagions whose symptoms have started (the rules a Long Rest reads: holdsExhaustion, noRestHealing). */
export function startedContagions(actor) {
  return [...(actor?.effects ?? [])].filter(effect => contagionOf(effect) && effect.flags?.wildpath?.contagion?.started)
    .map(effect => CONTAGIONS[contagionOf(effect)]);
}

export function createFoundryContagions({game, logger=globalThis.console, roll=async formula => (await new Roll(formula).evaluate()).total}) {
  const isActiveGM = () => game.users?.activeGM?.id === game.user?.id;
  const now = () => Number(game.time?.worldTime) || 0;

  /** Its symptoms start: Exhaustion, a condition; what it gave is kept for when it ends. */
  async function start(effect) {
    const id = contagionOf(effect);
    const actor = effect.parent;
    const onset = CONTAGIONS[id].onset ?? {};
    if ( onset.exhaustion ) await actor.toggleCondition("exhaustion", {levels: onset.exhaustion});
    if ( onset.condition && !actor.statuses?.has?.(onset.condition) ) await actor.toggleCondition(onset.condition);
    await effect.setFlag("wildpath", "contagion", {...(effect.flags?.wildpath?.contagion ?? {}), id, started: true,
      exhaustionGiven: onset.exhaustion ?? 0});
  }

  /** It ends: its effect goes, and the Exhaustion it alone held (Cackle Fever's). */
  async function end(effect) {
    const actor = effect.parent;
    const given = Number(effect.flags?.wildpath?.contagion?.exhaustionGiven) || 0;
    const id = contagionOf(effect);
    await effect.delete();
    if ( (CONTAGIONS[id]?.fight?.successes) && given && exhaustionOf(actor) ) await actor.toggleCondition("exhaustion", {levels: -given});
  }

  /** Caught: its incubation is rolled; with none, its symptoms start now. */
  async function onEffectCreated(effect) {
    const id = contagionOf(effect);
    if ( !id || !isActiveGM() || effect.flags?.wildpath?.contagion ) return;
    const incubation = CONTAGIONS[id].incubation;
    if ( !incubation ) return start(effect);
    const days = await roll(`${incubation.number}d${incubation.faces}`);
    await effect.setFlag("wildpath", "contagion", {id, onsetAt: now() + (days * DAY), started: false, successes: 0});
  }

  /** As the world's time passes, the symptoms of every contagion whose incubation is over start. */
  async function onWorldTime() {
    if ( !isActiveGM() ) return;
    const actors = [...(game.actors ?? []), ...[...(game.scenes ?? [])].flatMap(scene => [...(scene.tokens ?? [])]
      .filter(token => !token.actorLink).map(token => token.actor))].filter(Boolean);
    for ( const actor of actors ) for ( const effect of [...(actor.effects ?? [])] ) {
      const state = effect.flags?.wildpath?.contagion;
      if ( contagionOf(effect) && state && !state.started && (Number(state.onsetAt) <= now()) ) {
        try { await start(effect); } catch (error) { logger.warn("Wild Path | A contagion's symptoms failed to start", error); }
      }
    }
  }

  /** After a Long Rest: its creature's save against each contagion it suffers, and what follows. */
  async function afterLongRest(actor) {
    for ( const effect of [...(actor?.effects ?? [])] ) {
      const id = contagionOf(effect);
      const state = effect.flags?.wildpath?.contagion;
      const fight = id ? CONTAGIONS[id].fight : null;
      if ( !fight || !state?.started ) continue;
      const total = await actor.rollTest?.({save: fight.ability});
      const result = fightContagion(id, state, Number(total) >= fight.dc, {exhaustionLevel: exhaustionOf(actor)});
      if ( result.exhaustion ) await actor.toggleCondition("exhaustion", {levels: result.exhaustion});
      if ( result.ended ) await end(effect);
      else await effect.setFlag("wildpath", "contagion", result.state);
    }
  }

  /** Sight Rot: magic ending its Blinded (Heal, Lesser Restoration) ends it. */
  async function onEffectDeleted(effect) {
    if ( !isActiveGM() || (effect.system?.type !== "blinded") ) return;
    for ( const other of [...(effect.parent?.effects ?? [])] ) {
      if ( (contagionOf(other) === "sight-rot") && other.flags?.wildpath?.contagion?.started ) await other.delete();
    }
  }

  return {onEffectCreated, onWorldTime, afterLongRest, onEffectDeleted};
}
