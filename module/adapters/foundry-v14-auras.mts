import {createFoundryV14TacticalGridAdapter} from "./foundry-v14-tactical-grid-adapter.mjs";
import {createReachFootprint, footprintDistance} from "../helpers/grid-footprints.mjs";
import {WILDPATH} from "../config.mjs";
import {areaCovers} from "./foundry-v14-persistent-areas.mjs";

/**
 * Auras (2024: "you and allies within 10 ft gain +1 AC"): an `Aura` RuleElement on a creature's features, gear or
 * effects grants its nested rules to the creatures within its radius. Who is inside is worked out when a statistic
 * is read, from the Tokens on the Scene, so nothing is written to the affected creatures and it is never stale.
 * `allies` and `all` auras include their bearer; `enemies` auras do not.
 */

type Data = Record<string, unknown>;
interface Field {[key: string]: unknown}
interface AuraEntry {id: string; radius: number; affects: "allies" | "enemies" | "all"; ruleElements: Data[]; source?: Data | null}
interface AuraActor {isToken?: boolean; token?: AuraToken | null; getActiveTokens?(linked?: boolean, document?: boolean): AuraToken[];
  getAuras?(): AuraEntry[]}
interface AuraToken {id: string; parent?: AuraScene | null; actor?: AuraActor | null; disposition?: number; elevation?: number}
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

/** How far `other` stands from `token`, in feet, when it is `token` itself (0) or its ally by disposition; else null. */
export function allyDistance(token: AuraToken | null, other: AuraToken | null): number | null {
  if ( !token || !other ) return null;
  if ( token.id === other.id ) return 0;
  const scene = token.parent;
  if ( !scene || !affectsToken("allies", token, other) ) return null;
  const adapter = createFoundryV14TacticalGridAdapter({scene});
  const footprintOf = (each: AuraToken) => (adapter.tokenToFootprint(each) as {footprint?: Data}).footprint ?? null;
  const [from, to] = [footprintOf(token), footprintOf(other)];
  return (from && to) ? (footprintDistance as (a: Data, b: Data) => number)(from, to) * scene.grid.distance : null;
}

export function createFoundryAuras() {
  /** Rule owners (`{ruleElements, source}`) the auras around `actor`'s Tokens grant it. */
  function ownersFor(actor: AuraActor) {
    const tokens = actor.isToken ? [actor.token].filter(Boolean) as AuraToken[] : (actor.getActiveTokens?.(false, true) ?? []);
    const owners: Array<{ruleElements: Data[]; source: Data}> = [];
    for ( const token of tokens ) {
      const scene = token.parent;
      if ( !scene ) continue;
      const adapter = createFoundryV14TacticalGridAdapter({scene});
      const context = adapter.getSceneContext() as {ok: boolean; context?: {grid: {topology: string}}};
      if ( !context.ok || !context.context ) continue;
      for ( const bearer of scene.tokens ) {
        for ( const aura of bearer.actor?.getAuras?.() ?? [] ) {
          if ( !affectsToken(aura.affects, bearer, token) ) continue;
          if ( bearer.id === token.id ) {
            if ( aura.affects === "enemies" ) continue;
          } else {
            const footprint = adapter.tokenToFootprint(bearer) as {ok: boolean; footprint?: Data};
            if ( !footprint.ok || !footprint.footprint ) continue;
            const fields = reachFootprint({source: footprint.footprint, reachDistance: aura.radius, gridDistance: scene.grid.distance}).fields;
            const flag = {attached: false, sourceTokenId: bearer.id, topology: context.context.grid.topology, size: aura.radius,
              band: {bottom: null, top: null}, fields};
            if ( !areaCovers(flag as never, token as never, {fields}) ) continue;
          }
          owners.push({ruleElements: aura.ruleElements, source: {...(aura.source ?? {}), aura: aura.id, bearerTokenId: bearer.id}});
        }
      }
    }
    return owners;
  }

  return {ownersFor};
}
