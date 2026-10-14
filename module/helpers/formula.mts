/**
 * The Homebrew Builder's formula field: a small, safe grammar (no eval) turned into the engine's ValueExpressions,
 * and back. "2d6 + 3", "1d8 + mod(might)", "2 * prof", "floor(level / 2)" and "ceil(level / 2)" all work; an
 * expression outside the grammar (a table, a context path) formats to null and stays editable only as JSON.
 *
 *   expr   := term (("+" | "-") term)*
 *   term   := unary (("*" | "/") unary)*
 *   unary  := "-" NUMBER | factor
 *   factor := NUMBER | [INT] "d" INT | "(" expr ")" | prof | level | level(class) | mod(ability) | spellmod
 *           | resource(id) | resourcemax(id) | floor(expr) | ceil(expr) | min(expr, ...) | max(expr, ...) | variable
 */

export type Expression = Record<string, unknown>;
export type FormulaError = {ok: false; key: string; data: Record<string, string>; at: number};
export type FormulaResult = {ok: true; expression: Expression} | FormulaError;

interface Token {kind: "number" | "dice" | "word" | "op" | "open" | "close" | "comma"; text: string; at: number; value?: number;
  number?: number; faces?: number}

class FormulaFailure extends Error {
  constructor(readonly key: string, readonly data: Record<string, string>, readonly at: number) { super(key); }
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /\s*(?:(\d*)d(\d+)|(\d+(?:\.\d+)?)|([a-z][a-z0-9-]*)|([+\-*/])|(\()|(\))|(,))/giy;
  let match: RegExpExecArray | null;
  let index = 0;
  while ( index < text.length ) {
    pattern.lastIndex = index;
    match = pattern.exec(text);
    if ( !match || (match[0].trim() === "") ) {
      if ( text.slice(index).trim() === "" ) break;
      throw new FormulaFailure("Unexpected", {token: text.slice(index).trim().slice(0, 12)}, index);
    }
    const at = index + (match[0].length - match[0].trimStart().length);
    if ( match[2] !== undefined ) tokens.push({kind: "dice", text: match[0].trim(), at, number: match[1] ? Number(match[1]) : 1, faces: Number(match[2])});
    else if ( match[3] !== undefined ) tokens.push({kind: "number", text: match[3], at, value: Number(match[3])});
    else if ( match[4] !== undefined ) tokens.push({kind: "word", text: match[4].toLowerCase(), at});
    else if ( match[5] !== undefined ) tokens.push({kind: "op", text: match[5], at});
    else if ( match[6] !== undefined ) tokens.push({kind: "open", text: "(", at});
    else if ( match[7] !== undefined ) tokens.push({kind: "close", text: ")", at});
    else tokens.push({kind: "comma", text: ",", at});
    index = pattern.lastIndex;
  }
  return tokens;
}

/**
 * Parse builder text into a ValueExpression. `dice: false` refuses dice (a DC, a rule's amount); `abilities` lists
 * the ability keys `mod(...)` accepts.
 */
export function parseFormula(text: string, {dice=true, abilities=null, variables={}}: {dice?: boolean; abilities?: readonly string[] | null;
  variables?: Record<string, Expression>}={}): FormulaResult {
  try {
    const source = String(text ?? "");
    if ( !source.trim() ) throw new FormulaFailure("Empty", {}, 0);
    const tokens = tokenize(source);
    let position = 0;
    const peek = () => tokens[position];
    const take = () => tokens[position++];
    const expect = (kind: Token["kind"]) => {
      const token = take();
      if ( token?.kind !== kind ) throw new FormulaFailure(kind === "close" ? "Unbalanced" : "Unexpected", {token: token?.text ?? ""},
        token?.at ?? source.length);
      return token;
    };
    const wordArgument = () => {
      expect("open");
      const word = take();
      if ( word?.kind !== "word" ) throw new FormulaFailure("Unexpected", {token: word?.text ?? ""}, word?.at ?? source.length);
      expect("close");
      return word.text;
    };

    const factor = (): Expression => {
      const token = take();
      if ( !token ) throw new FormulaFailure("Unexpected", {token: ""}, source.length);
      if ( token.kind === "number" ) return {type: "constant", value: token.value};
      if ( token.kind === "dice" ) {
        if ( !dice ) throw new FormulaFailure("DiceNotAllowed", {token: token.text}, token.at);
        return {type: "dice", number: token.number, faces: token.faces};
      }
      if ( token.kind === "open" ) {
        const inner = expression();
        expect("close");
        return inner;
      }
      if ( token.kind !== "word" ) throw new FormulaFailure("Unexpected", {token: token.text}, token.at);
      switch ( token.text ) {
        case "prof": return {type: "proficiency-bonus"};
        case "spellmod": return {type: "spellcasting-modifier"};
        case "level": return peek()?.kind === "open" ? {type: "class-level", class: wordArgument()} : {type: "character-level"};
        case "mod": {
          const ability = wordArgument();
          if ( abilities && !abilities.includes(ability) ) {
            throw new FormulaFailure("UnknownAbility", {ability, abilities: abilities.join(", ")}, token.at);
          }
          return {type: "ability-modifier", ability};
        }
        case "resource": return {type: "resource-current", resource: wordArgument()};
        case "resourcemax": return {type: "resource-max", resource: wordArgument()};
        case "floor":
        case "ceil": {
          expect("open");
          const inner = expression();
          expect("close");
          // "ceil(a / b)" rounds the division up; "floor(...)" and "ceil(...)" of anything else wrap it.
          if ( (inner.type === "divide") && (inner.round === "floor") ) return {...inner, round: token.text};
          return {type: token.text, value: inner};
        }
        case "min":
        case "max": {
          expect("open");
          const terms = [expression()];
          while ( peek()?.kind === "comma" ) {
            take();
            terms.push(expression());
          }
          expect("close");
          return {type: token.text, terms};
        }
        default:
          // A named value the caller supplies (a converter's class scale table, for one).
          if ( Object.hasOwn(variables, token.text) ) return structuredClone(variables[token.text]!);
          throw new FormulaFailure("UnknownWord", {word: token.text}, token.at);
      }
    };
    const unary = (): Expression => {
      if ( (peek()?.kind === "op") && (peek()!.text === "-") && (tokens[position + 1]?.kind === "number") ) {
        take();
        return {type: "constant", value: -Number(take()!.value)};
      }
      return factor();
    };
    const term = (): Expression => {
      let left = unary();
      while ( (peek()?.kind === "op") && ["*", "/"].includes(peek()!.text) ) {
        const op = take()!.text;
        const right = unary();
        if ( op === "*" ) left = (left.type === "multiply") ? {...left, terms: [...(left.terms as Expression[]), right]}
          : {type: "multiply", terms: [left, right]};
        else left = {type: "divide", numerator: left, denominator: right, round: "floor"};
      }
      return left;
    };
    const expression = (): Expression => {
      let left = term();
      while ( (peek()?.kind === "op") && ["+", "-"].includes(peek()!.text) ) {
        const op = take()!.text;
        const right = term();
        if ( op === "+" ) left = (left.type === "add") ? {...left, terms: [...(left.terms as Expression[]), right]} : {type: "add", terms: [left, right]};
        else left = (left.type === "subtract") ? {...left, terms: [...(left.terms as Expression[]), right]}
          : {type: "subtract", terms: [left, right]};
      }
      return left;
    };

    const result = expression();
    if ( position < tokens.length ) {
      const extra = tokens[position]!;
      throw new FormulaFailure(extra.kind === "close" ? "Unbalanced" : "Unexpected", {token: extra.text}, extra.at);
    }
    return {ok: true, expression: result};
  } catch (error) {
    if ( error instanceof FormulaFailure ) return {ok: false, key: error.key, data: error.data, at: error.at};
    throw error;
  }
}

/** The builder text of a ValueExpression, or null when it is outside the grammar (shown read-only, edited as JSON). */
export function formatFormula(expression: unknown): string | null {
  try {
    return format(expression, 0);
  } catch {
    return null;
  }
}

function format(expression: unknown, parent: number): string {
  if ( typeof expression === "number" ) return String(expression);
  if ( !expression || (typeof expression !== "object") ) throw new Error("not a formula");
  const e = expression as Expression;
  const wrap = (text: string, precedence: number) => (precedence < parent ? `(${text})` : text);
  const terms = (Array.isArray(e.terms) ? e.terms : []) as unknown[];
  switch ( e.type ) {
    case "constant": return String(e.value);
    case "dice": {
      const dice = `${e.number ?? 1}d${e.faces}`;
      return Number(e.bonus) ? wrap(`${dice} ${Number(e.bonus) < 0 ? "-" : "+"} ${Math.abs(Number(e.bonus))}`, 1) : dice;
    }
    case "proficiency-bonus": return "prof";
    case "spellcasting-modifier": if ( e.class || e.ability ) throw new Error("not a formula"); return "spellmod";
    case "character-level": return "level";
    case "class-level": return `level(${e.class})`;
    case "ability-modifier": return `mod(${e.ability})`;
    case "resource-current": return `resource(${e.resource})`;
    case "resource-max": return `resourcemax(${e.resource})`;
    case "add": if ( terms.length < 2 ) throw new Error("not a formula");
      return wrap(terms.map((term, index) => format(term, index ? 2 : 1)).join(" + "), 1);
    case "subtract": if ( terms.length < 2 ) throw new Error("not a formula");
      return wrap(terms.map((term, index) => format(term, index ? 2 : 1)).join(" - "), 1);
    case "multiply": if ( terms.length < 2 ) throw new Error("not a formula");
      return wrap(terms.map((term, index) => format(term, index ? 3 : 2)).join(" * "), 2);
    case "divide": {
      const text = `${format(e.numerator, 2)} / ${format(e.denominator, 3)}`;
      if ( e.round === "ceil" ) return `ceil(${text})`;
      if ( e.round !== "floor" ) throw new Error("not a formula");
      return wrap(text, 2);
    }
    case "floor":
    case "ceil": {
      const inner = format(e.value, 0);
      return `${e.type}(${inner})`;
    }
    case "min":
    case "max": if ( terms.length < 1 ) throw new Error("not a formula");
      return `${e.type}(${terms.map(term => format(term, 0)).join(", ")})`;
    default: throw new Error("not a formula");
  }
}
