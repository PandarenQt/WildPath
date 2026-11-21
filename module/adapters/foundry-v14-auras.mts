import {effectsFrom} from "../helpers/effect-sources.mjs";
import {createFoundryV14TacticalGridAdapter} from "./foundry-v14-tactical-grid-adapter.mjs";
import {createReachFootprint, footprintDistance} from "../helpers/grid-footprints.mjs";
import {WILDPATH} from "../config.mjs";
import {areaCovers} from "./foundry-v14-persistent-areas.mjs";
import {bestAuraCopies} from "../helpers/rule-elements.mjs";
import {creatureTokens, deadCreature} from "./foundry-v14-creature-tokens.mjs";
import {ineligibleTarget} from "./foundry-v14-senses.mjs";

/**
 * Auras (2024: "you and allies within 10 ft gain +1 AC"): an `Aura` RuleElement on a creature's features, gear or
 * effects grants its nested rules to the creatures within its radius. Who is inside is worked out when a statistic
 * is read, from the Tokens on the Scene, so nothing is written to the affected creatures and it is never stale.
 * `allies` and `all` auras include their bearer; `enemies` auras do not. A `bearerOnly` aura grants its bearer alone,
 * while another creature it `affects` stands within its radius (Steadfast: no Frightened with an ally near).
 */

type Data = Record<string, unknown>;
interface Field {[key: string]: unknown}
interface AuraEntry {id: string; radius: number; affects: "allies" | "enemies" | "all"; bearerOnly?: boolean; ruleElements: Data[];
  source?: Data | null}
interface AuraActor {uuid?: string; isToken?: boolean; statuses?: Iterable<string>; token?: AuraToken | null; getDependentTokens?(options?: {linked?: boolean; concreteOnly?: boolean}): AuraToken[];
  getAuras?(): AuraEntry[]}
interface AuraToken {id: string; parent?: AuraScene | null; actor?: AuraActor | null; disposition?: number; elevation?: number; hidden?: boolean;
  flags?: {wildpath?: {summon?: {casterUuid?: string}}}}
interface AuraScene {id: string; grid: {distance: number}; tokens: Iterable<AuraToken>}

const reachFootprint = createReachFootprint as unknown as (options: {source: Data; reachDistance: number; gridDistance: number}) => {fields: Field[]};

/** Whether an aura of `affects` from `bearer` reaches the creature standing at `token`, by their dispositions. */
function affectsToken(affects: AuraEntry["affects"], bearer: AuraToken, token: AuraToken) {
  if ( affects === "all" ) return true;
  const relation = (bearer.disposition ?? 0) * (token.disposition ?? 0);
  return affects === "enemies" ? relation < 0 : ((relation > 0) && (bearer.disposition === token.disposition));
}

/**
 * Whether an ally of `attacker` (its disposition), other than the attacker and not Incapacitated, stands within 5 ft
 * of `target` (Pack Tactics). `footprint` is where the target stands; its Token's own when omitted.
 */
export function allyNearTarget(attacker: AuraToken | null, target: AuraToken | null, footprint: Data | null = null) {
  const scene = target?.parent;
  if ( !attacker || !scene ) return false;
  const adapter = createFoundryV14TacticalGridAdapter({scene});
  const footprintOf = (token: AuraToken) => (adapter.tokenToFootprint(token) as {footprint?: Data}).footprint ?? null;
  const at = footprint ?? footprintOf(target);
  if ( !at ) return false;
  const conditions = (WILDPATH as {CONDITIONS?: Record<string, {endsConcentration?: boolean} | undefined>}).CONDITIONS ?? {};
  return [...scene.tokens].some(token => {
    if ( (token.id === attacker.id) || (token.id === target.id) || !affectsToken("allies", attacker, token) ) return false;
    const statuses = [...((token.actor as {statuses?: Iterable<string>} | null)?.statuses ?? [])];
    if ( !token.actor || statuses.some(status => conditions[status]?.endsConcentration) ) return false;
    const ally = footprintOf(token);
    return !!ally && ((footprintDistance as (a: Data, b: Data) => number)(ally, at) * scene.grid.distance <= 5);
  });
}

/** Whether `other` is an ally of `token` by disposition (not `token` itself). */
export function alliedTokens(token: AuraToken | null | undefined, other: AuraToken | null | undefined) {
  return !!(token && other) && (token.id !== other.id) && affectsToken("allies", token, other);
}

/**
 * The ids of `token`'s allies on its Scene, by disposition, not `token` itself: what an attack context names
 * (`attack.attackerAllies`), so an aura's rule can grant its bearer's allies alone (Rage of the Wilds' Wolf).
 */
export function alliesOf(token: AuraToken | null | undefined): string[] {
  return [...(token?.parent?.tokens ?? [])].filter(other => alliedTokens(token, other)).map(other => other.id);
}

/**
 * The Token on `scene` that gave `effect` to its creature (the effect names its source: effect-sources.mjs), or null.
 */
export function effectGiver(effect: {id?: string}, holder: unknown, scene: AuraScene | null | undefined): AuraToken | null {
  return [...(scene?.tokens ?? [])].find(token => token.actor
    && (effectsFrom as unknown as (holder: unknown, source: unknown) => Array<{id?: string}>)(holder, token.actor)
      .some(entry => entry.id === effect.id)) ?? null;
}

/**
 * 2024 Help with an attack: whether `target` has a Distracted effect whose helper is an ally of `attacker` (and not the
 * attacker): that ally's attack roll against it has Advantage (`attack.helpedByAlly`).
 */
export function helpedByAlly(attacker: AuraToken | null | undefined, target: {effects?: Iterable<{id?: string; disabled?: boolean;
  statuses?: Iterable<string>}>} | null | undefined) {
  const scene = attacker?.parent;
  if ( !attacker || !scene || !target ) return false;
  return [...(target.effects ?? [])].some(effect => !effect.disabled && new Set(effect.statuses ?? []).has("distracted")
    && alliedTokens(attacker, effectGiver(effect, target, scene)));
}

/** How far `other` stands from `token`, in feet, when it is `token` itself (0) or its ally by disposition; else null. */
export function allyDistance(token: AuraToken | null, other: AuraToken | null): number | null {
  if ( !token || !other ) return null;
  if ( token.id === other.id ) return 0;
  if ( !token.parent || !affectsToken("allies", token, other) ) return null;
  return tokenDistance(token, other);
}

/** How far `other` stands from `token` on its Scene, in feet, between their footprints; null when either has none. */
export function tokenDistance(token: AuraToken, other: AuraToken): number | null {
  const scene = token.parent;
  if ( !scene ) return null;
  const adapter = createFoundryV14TacticalGridAdapter({scene});
  const footprintOf = (each: AuraToken) => (adapter.tokenToFootprint(each) as {footprint?: Data}).footprint ?? null;
  const [from, to] = [footprintOf(token), footprintOf(other)];
  return (from && to) ? (footprintDistance as (a: Data, b: Data) => number)(from, to) * scene.grid.distance : null;
}

/**
 * Whether a creature an Action could target stands in its range: another Token on `token`'s Scene its `targeting.eligible`
 * admits (ineligibleTarget), within its range's feet (`normal`, else `distance`; any distance without one) between their
 * footprints. A GM-hidden Token is left out, so a Player's action bar does not tell of it. An Action's `requires` reads it as
 * `eligibleTargetInRange` (Pipes of the Sewers' Sway Rats: "when an eligible uncontrolled swarm is available", Q18 6).
 */
export function eligibleTargetInRange(definition: {range?: Data | null; targeting?: {eligible?: unknown} | null} | null,
  token: AuraToken | null | undefined): boolean {
  if ( !definition || !token?.parent ) return false;
  const range = definition.range as {normal?: {value?: unknown}; distance?: {value?: unknown}} | null | undefined;
  const feet = Number(range?.normal?.value ?? range?.distance?.value);
  return [...token.parent.tokens].some(other => other.actor && (other.id !== token.id) && (other.hidden !== true)
    && !(ineligibleTarget as (predicate: unknown, token: unknown, source: unknown) => boolean)(definition.targeting?.eligible, other, token)
    && (!Number.isFinite(feet) || ((tokenDistance(token, other) ?? Infinity) <= feet)));
}

/** Whether `token` stands within `radius` feet of `bearer` (its footprint's reach; the lasting-area coverage test). */
function within(adapter: ReturnType<typeof createFoundryV14TacticalGridAdapter>, topology: string, scene: AuraScene, bearer: AuraToken,
  token: AuraToken, radius: number) {
  const footprint = adapter.tokenToFootprint(bearer) as {ok: boolean; footprint?: Data};
  if ( !footprint.ok || !footprint.footprint ) return false;
  const fields = reachFootprint({source: footprint.footprint, reachDistance: radius, gridDistance: scene.grid.distance}).fields;
  const flag = {attached: false, sourceTokenId: bearer.id, topology, size: radius, band: {bottom: null, top: null}, fields};
  return areaCovers(flag as never, token as never, {fields});
}

/**
 * The other Tokens within `radius` feet of `bearer` on its Scene (a creature's own Emanation, 2024): all of them, or
 * only its enemies (the opposite disposition: "each creature of its choice"). With `notSummoner`, never the creature that
 * summoned it (a spirit's "(other than you)": Festering Aura, Whispering Aura); a summon placed by hand names nobody.
 * Never a dead one (deadCreature).
 */
export function tokensAround(bearer: AuraToken | null | undefined, {radius, affects="others", notSummoner=false}:
  {radius: number; affects?: string; notSummoner?: boolean}) {
  const scene = bearer?.parent;
  if ( !bearer || !scene || !(Number(radius) > 0) ) return [];
  const adapter = createFoundryV14TacticalGridAdapter({scene});
  const context = adapter.getSceneContext() as {ok: boolean; context?: {grid: {topology: string}}};
  if ( !context.ok || !context.context ) return [];
  const topology = context.context.grid.topology;
  const summoner = notSummoner ? bearer.flags?.wildpath?.summon?.casterUuid : undefined;
  return [...scene.tokens].filter(token => (token.id !== bearer.id) && token.actor && !deadCreature(token.actor) && (!summoner || (token.actor.uuid !== summoner))
    && ((affects !== "enemies") || affectsToken("enemies", bearer, token)) && within(adapter, topology, scene, bearer, token, Number(radius)));
}

export function createFoundryAuras() {
  /** Rule owners (`{ruleElements, source}`) the auras around `actor`'s Tokens grant it. */
  function ownersFor(actor: AuraActor) {
    const tokens = creatureTokens(actor);
    const owners: Array<{ruleElements: Data[]; source: Data}> = [];
    for ( const token of tokens ) {
      const scene = token.parent;
      if ( !scene ) continue;
      const adapter = createFoundryV14TacticalGridAdapter({scene});
      const context = adapter.getSceneContext() as {ok: boolean; context?: {grid: {topology: string}}};
      if ( !context.ok || !context.context ) continue;
      const topology = context.context.grid.topology;
      for ( const bearer of scene.tokens ) {
        for ( const aura of bearer.actor?.getAuras?.() ?? [] ) {
          const reaches = aura.bearerOnly
            ? (bearer.id === token.id) && [...scene.tokens].some(other => (other.id !== bearer.id) && !!other.actor
              && affectsToken(aura.affects, bearer, other) && within(adapter, topology, scene, bearer, other, aura.radius))
            : affectsToken(aura.affects, bearer, token)
              && ((bearer.id === token.id) ? (aura.affects !== "enemies") : within(adapter, topology, scene, bearer, token, aura.radius));
          if ( !reaches ) continue;
          owners.push({ruleElements: aura.ruleElements, source: {...(aura.source ?? {}), aura: aura.id, bearerTokenId: bearer.id}});
        }
      }
    }
    // One copy of the same aura (two paladins' Auras of Protection, or one bearer's two Tokens): the best for it.
    return bestAuraCopies(owners);
  }

  return {ownersFor};
}
