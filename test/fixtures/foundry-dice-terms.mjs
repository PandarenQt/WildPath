// The few Foundry dice terms a typed (physical) roll is shown with (`foundry.dice.terms`), and `Roll.fromTerms` over them:
// the formula their expressions make and the total their signs make, as Foundry's own do for evaluated terms.
export const diceTerms = {
  Die: class Die {
    constructor({number=1, faces, modifiers=[], results}) {
      // A result counts as its `count` when set (a `min` floor), as DiceTerm#total does.
      Object.assign(this, {number, faces, modifiers, results, expression: `${number}d${faces}${modifiers.join("")}`,
        total: results.filter(result => result.active).reduce((sum, result) => sum + (result.count ?? result.result), 0)});
    }
  },
  OperatorTerm: class OperatorTerm {
    constructor({operator}) { this.operator = this.expression = operator; }
  },
  NumericTerm: class NumericTerm {
    constructor({number}) { this.number = this.total = number; this.expression = String(number); }
    evaluate() { return this; }
  }
};

export function rollFromTerms(Roll, terms) {
  const roll = new Roll(terms.map(term => term.expression).join(" "));
  let sign = 1;
  roll.total = 0;
  for ( const term of terms ) {
    if ( term.operator ) sign = (term.operator === "-") ? -1 : 1;
    else roll.total += sign * term.total;
  }
  roll.dice = terms.filter(term => term.faces);
  return roll;
}
