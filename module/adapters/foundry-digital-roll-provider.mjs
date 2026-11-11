import {
  ROLL_CODES,
  ROLL_PROVIDER_OUTCOMES,
  ROLL_PROVENANCE_TYPES,
  ROLL_TYPES,
  cloneRollData,
  createRollRequest,
  createRollResult,
  rollFormulaForRequest,
  validateRollRequest
} from "../helpers/rolls.mjs";

export function createFoundryDigitalRollProvider({
  id="foundry-digital",
  label="Foundry Digital Roll Provider",
  RollClass=null,
  evaluateOptions={}
}={}) {
  return {
    id,
    type: ROLL_PROVENANCE_TYPES.FOUNDRY_DIGITAL,
    label,
    canHandle(request, context={}) {
      const validation = validateRollRequest(request);
      if ( !validation.ok ) return false;
      const formula = rollFormulaForRequest(validation.request);
      return formula.ok && !!resolveRollClass({RollClass, context});
    },
    async execute(request, context={}) {
      const validation = validateRollRequest(request);
      if ( !validation.ok ) return providerFailure(this, validation.code, validation.reason, {validation});

      const RollConstructor = resolveRollClass({RollClass, context});
      if ( !RollConstructor ) {
        return providerFailure(this, ROLL_CODES.NO_PROVIDER_AVAILABLE, "Foundry Roll class is not available.");
      }

      const formula = rollFormulaForRequest(validation.request);
      if ( !formula.ok ) return providerFailure(this, formula.code, formula.reason, {request: validation.request});

      try {
        const roll = new RollConstructor(formula.formula, validation.request.data ?? {}, {
          ...(context.rollOptions ?? {}),
          wildpath: {
            requestId: validation.request.id,
            resolutionId: validation.request.resolutionId,
            type: validation.request.type
          }
        });
        const evaluated = await roll.evaluate({
          allowInteractive: false,
          ...evaluateOptions,
          ...(context.evaluateOptions ?? {})
        });
        const foundryRoll = evaluated ?? roll;
        const result = createRollResult({
          request: validation.request,
          total: foundryRoll.total,
          dice: diceFromFoundryRoll(foundryRoll),
          formula: foundryRoll.formula ?? formula.formula,
          terms: termsFromFoundryRoll(foundryRoll),
          provider: providerReference(this),
          provenance: {
            type: ROLL_PROVENANCE_TYPES.FOUNDRY_DIGITAL,
            providerId: id,
            method: "digital",
            authority: validation.request.authority,
            source: "foundry-roll"
          },
          raw: {
            foundryRoll: typeof foundryRoll.toJSON === "function"
              ? cloneRollData(foundryRoll.toJSON(), "foundryRoll")
              : null
          }
        });
        return {
          ok: true,
          status: ROLL_PROVIDER_OUTCOMES.RESULT,
          code: ROLL_CODES.OK,
          request: validation.request,
          provider: providerReference(this),
          result
        };
      } catch (error) {
        return providerFailure(this, ROLL_CODES.PROVIDER_FAILURE, error?.message ?? String(error), {request: validation.request});
      }
    }
  };
}

/* -------------------------------------------- */

/**
 * A roll outside an Action (a sheet roll, a rest's Hit Dice, level-up Hit Points, ability scores, Recharge, Portent): one
 * RollRequest answered by the dice policy as an Action's rolls are (`game.wildpath.requestRoll`), with a Foundry Roll to
 * show in chat: digital dice as rolled, typed (physical) dice as their entered die and modifier, or their total when no die
 * was entered. `{result, roll}`, or null when not rolled.
 * @param {object} request
 * @param {{title?: string|null, game?: object}} [options]
 */
export async function requestShownRoll(request, {title=null, game=globalThis.game}={}) {
  const result = await game.wildpath.requestRoll(request, {title});
  if ( !result ) return null;
  const Roll = resolveRollClass({RollClass: null, context: {}});
  if ( result.raw?.foundryRoll ) return {result, roll: Roll.fromData(result.raw.foundryRoll)};
  return {result, roll: enteredRoll(Roll, request, result) ?? await new Roll(String(result.total)).evaluate()};
}

/**
 * Typed dice as a Foundry Roll: the entered natural as its die and the rest of the total as one modifier ("1d20 + 5"), so
 * the card shows the die (its natural 20) and a later Portent can replace it. Null when no natural die was entered.
 * A floor on the die (Reliable Talent's 10) is shown as Foundry's `min` modifier leaves a digital die: the natural as
 * rolled, counted as the floor, so the die's total (and a Portent replacing it) is the same for typed and digital dice.
 */
function enteredRoll(Roll, request, result) {
  const faces = Number(request?.expected?.primaryDieFaces);
  if ( !(faces > 0) || !Number.isInteger(result.natural) || !Number.isFinite(result.total) ) return null;
  const {Die, OperatorTerm, NumericTerm} = globalThis.foundry.dice.terms;
  const floor = Math.trunc(Number(request.expected.naturalMinimum)) || 0;
  const counted = Math.max(result.natural, floor);
  const rest = result.total - counted;
  return Roll.fromTerms([new Die({number: 1, faces, modifiers: (floor > 1) ? [`min${floor}`] : [],
    results: [{result: result.natural, active: true, ...((counted > result.natural) ? {count: counted, rerolled: true} : {})}]}),
    ...(rest ? [new OperatorTerm({operator: rest < 0 ? "-" : "+"}), new NumericTerm({number: Math.abs(rest)}).evaluate()] : [])]);
}

/**
 * `requestShownRoll` for dice with no d20 (`4d6kh3`, `2d8min3`): the roller types their total.
 * @param {string} formula
 * @param {{type?: string, title?: string|null, game?: object}} [options]
 */
export function requestShownDice(formula, {type=ROLL_TYPES.CUSTOM, title=null, game=globalThis.game}={}) {
  const resolutionId = `roll:${globalThis.foundry.utils.randomID()}`;
  return requestShownRoll(createRollRequest({id: `${resolutionId}:roll`, resolutionId, type, formula}), {title, game});
}

/* -------------------------------------------- */

function resolveRollClass({RollClass, context}) {
  return RollClass
    ?? context.RollClass
    ?? context.foundry?.dice?.Roll
    ?? globalThis.foundry?.dice?.Roll
    ?? globalThis.Roll
    ?? null;
}

function diceFromFoundryRoll(roll) {
  const dice = Array.isArray(roll?.dice)
    ? roll.dice
    : (roll?.terms ?? []).filter(term => Array.isArray(term?.results));
  return dice.map((term, dieIndex) => ({
    id: term.options?.id ?? `foundry-die:${dieIndex}`,
    number: finiteInteger(term.number ?? term.results?.length ?? 0) ?? 0,
    faces: finiteInteger(term.faces ?? term.constructor?.DENOMINATION) ?? 0,
    modifiers: Array.isArray(term.modifiers) ? term.modifiers.map(String) : [],
    purpose: term.options?.flavor ?? term.flavor ?? null,
    results: (term.results ?? []).map((result, resultIndex) => ({
      index: finiteInteger(result.index) ?? resultIndex,
      result: finiteInteger(result.result ?? result.value),
      active: result.active !== false && result.discarded !== true,
      discarded: result.discarded === true || result.active === false,
      rerolled: result.rerolled === true,
      exploded: result.exploded === true,
      critical: result.critical === true,
      fumble: result.fumble === true,
      metadata: {}
    })),
    source: null,
    metadata: {}
  }));
}

function termsFromFoundryRoll(roll) {
  if ( typeof roll?.toJSON === "function" ) {
    const data = roll.toJSON();
    if ( Array.isArray(data?.terms) ) return cloneRollData(data.terms, "foundryTerms");
  }
  return [];
}

function providerReference(provider) {
  return {
    id: provider.id,
    type: provider.type,
    label: provider.label
  };
}

function providerFailure(provider, code, reason, data={}) {
  return {
    ok: false,
    status: ROLL_PROVIDER_OUTCOMES.FAILURE,
    code,
    reason,
    provider: providerReference(provider),
    ...cloneRollData(data, "failure")
  };
}

function finiteInteger(value) {
  if ( value == null || value === "" ) return null;
  if ( typeof value === "object" || typeof value === "function" || typeof value === "boolean" ) return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : null;
}
