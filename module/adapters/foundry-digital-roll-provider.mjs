import {
  ROLL_CODES,
  ROLL_PROVIDER_OUTCOMES,
  ROLL_PROVENANCE_TYPES,
  cloneRollData,
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
