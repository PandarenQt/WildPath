/**
 * The Homebrew Builder's Test tab (homebrew-content-builder.md, Test and Preview): a dry run of an Action through
 * the engine's own staged pipeline against a sample target. d20s show a fixed number, other dice their average, a
 * required choice takes its first option, and the run stops before anything is committed. The result is the Rules
 * Inspector's summary (`inspectResolution`), so it reads the same as a real resolution.
 */
import {planStagedActionResolution, resumeStagedActionResolution} from "../resolvers/action-pipeline-resolver.mjs";
import {createTestRollProvider as testRollProvider, executeRollRequest as executeRoll} from "../resolvers/roll-provider-resolver.mjs";
import {RESOLUTION_REQUEST_TYPES, RESOLUTION_STATE_STATUS} from "./resolution-state.mjs";
import {ROLL_TYPES, rollFormulaForRequest} from "./rolls.mjs";
import {inspectResolution} from "./resolution-inspection.mjs";

type Data = Record<string, any>;
// The resolvers are plain JavaScript; their inferred parameter types are narrower than what they accept.
const resume = resumeStagedActionResolution as unknown as (options: Data) => Data;
const createTestRollProvider = testRollProvider as unknown as (options: Data) => Data;
const executeRollRequest = executeRoll as unknown as (options: Data) => Promise<Data>;
export interface PreviewTarget {name?: string; ac?: number; health?: number; saveBonus?: number}
export interface PreviewOptions {actorSystem?: Data | null; statistics?: Data; target?: PreviewTarget; d20?: number; label?: string}

const D20_TYPES = new Set<string>([ROLL_TYPES.ATTACK, ROLL_TYPES.SAVING_THROW, ROLL_TYPES.ABILITY_CHECK, ROLL_TYPES.SKILL_CHECK]);
const TARGET_ID = "preview-target";

/** The average of a rolled formula ("2d6 + 3" is 10), rounded down per dice term as fixed damage is. */
export function averageOfFormula(formula: unknown) {
  let total = 0;
  for ( const [, sign, count, faces, flat] of String(formula ?? "").replace(/\s+/g, "").matchAll(/([+-]?)(?:(\d*)d(\d+)|(\d+))/g) ) {
    const value = faces ? Math.floor((Number(count || 1) * (Number(faces) + 1)) / 2) : Number(flat);
    total += sign === "-" ? -value : value;
  }
  return total;
}

/** A creature able to pay any ordinary cost, for an Action no creature owns. */
export function sampleActorSystem(): Data {
  const full = (max: number) => ({value: max, max});
  return {
    resources: {health: full(20), action: full(1), bonus: full(1), reaction: full(1), movement: full(30)},
    pools: [...Array.from({length: 9}, (_, index) => ({id: `spell-slot.${index + 1}`, label: `Spell slot ${index + 1}`, ...full(1)})),
      {id: "legendary-action", label: "Legendary Actions", ...full(3)}],
    // Plain numbers a reader can check: proficiency +2, spellcasting +3, every ability score 10, level 1.
    attributes: {prof: 2},
    spellcasting: {modifier: 3},
    abilities: Object.fromEntries(["might", "agility", "fortitude", "intellect", "wits", "presence"].map(ability => [ability, {value: 10}])),
    details: {level: 1}
  };
}

/**
 * Preview `definition` used by a creature with `actorSystem` (its effective snapshot) and `statistics` (its
 * `actionCombatStatistics`), against one sample target. An area is treated as catching the target, and range is
 * not checked.
 */
export async function previewAction(definition: Data, {actorSystem=null, statistics={}, target={}, d20=10, label}: PreviewOptions={}) {
  const ac = Number(target.ac ?? 13);
  const health = Number(target.health ?? 30);
  const name = target.name ?? "Target";
  const self = definition.targeting?.type === "self";
  // shortcut: one sample target and no Scene, so range, area shape and placement are not previewed; the Action
  // runs as if the area caught the target. Upgrade by previewing on the canvas with real Tokens.
  const action = {...definition, id: definition.id || "action:preview", range: null, area: null,
    targeting: {type: "single", required: true, count: 1}};
  const defense = {value: ac, slug: "ac"};
  const sample = {id: TARGET_ID, actorId: TARGET_ID, actorRef: `Actor.${TARGET_ID}`, uuid: `Actor.${TARGET_ID}`, name, defense,
    defenses: {ac: defense}};
  const targetSystem = {resources: {health: {value: health, max: health}}, defenses: {ac: {value: ac}}};
  const keys = [sample.uuid, sample.id, `actor:${sample.id}`];
  const options: Data = {
    id: "preview",
    actorSystem: actorSystem ?? sampleActorSystem(),
    action: {id: definition.id || "action:preview", type: "action", name: label ?? (definition.label || "Action"), system: {definition: action}},
    source: {actorId: "preview-source", actorRef: "Actor.preview-source", uuid: "Actor.preview-source"},
    targets: [sample],
    durability: {targetSystems: Object.fromEntries(keys.map(key => [key, targetSystem]))},
    // The pipeline reads each target's current defense from its Actor; the sample is a plain one.
    targetActors: Object.fromEntries(keys.map(key => [key, {id: sample.id, uuid: sample.uuid, name, system: targetSystem}])),
    ...(statistics.damage ? {damage: statistics.damage} : {}),
    ...(statistics.attack ? {attack: statistics.attack} : {}),
    ...(statistics.check ? {check: statistics.check} : {}),
    ...(definition.save ? {save: {modifiersByTarget: {[TARGET_ID]: Number(target.saveBonus ?? 0)}}} : {})
  };

  let result = planStagedActionResolution(options) as Data;
  const notes: string[] = self ? ["self"] : [];
  for ( let step = 0; step < 20; step++ ) {
    const state = result.state;
    const request = state?.pendingRequests?.[0];
    if ( !request || (state.status === RESOLUTION_STATE_STATUS.READY_TO_COMMIT) ) break;
    const response = await answer(request, d20);
    if ( !response ) {
      notes.push(`stopped:${request.type}`);
      break;
    }
    result = resume({state, response: {resolutionId: state.id, requestId: request.id, type: request.type, value: response},
      services: {targetActors: options.targetActors}});
  }
  return {...inspectResolution({resolutionId: "preview", state: result.state, options}), notes};
}

/** The preview's answer to a request: a roll with fixed dice, or the first option of each required choice. */
async function answer(request: Data, d20: number) {
  if ( request.type === RESOLUTION_REQUEST_TYPES.ROLL ) {
    const rollRequest = request.payload?.rollRequest;
    const input = D20_TYPES.has(rollRequest?.type) ? {natural: d20} : {total: averageOfFormula(rollFormulaForRequest(rollRequest).formula)};
    const provided = await executeRollRequest({request: rollRequest, providers: [createTestRollProvider({result: input})]});
    return provided.ok ? provided.result : null;
  }
  if ( request.type === RESOLUTION_REQUEST_TYPES.ACTION_CONFIGURATION ) {
    const choices: Data = {};
    for ( const choice of request.payload?.requests ?? [] ) {
      const option = choice.options?.[0];
      if ( !choice.required || !option ) continue;
      choices[choice.id] = choice.type === "resource" ? {paymentOptionId: option.paymentOptionId ?? option.id} : {optionId: option.id ?? option.value};
    }
    return {choices};
  }
  return null;
}
