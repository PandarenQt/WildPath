/**
 * 2024 Weapon Mastery (G8): a weapon attack (`attack.weapon`, from the converter) by a creature whose training lists
 * that weapon among its masteries gains the weapon's mastery property. Push, Slow, Sap and Vex become part of the
 * attack here; Topple and Graze follow it as their own Actions (adapters/foundry-v14-weapon-mastery.mts); Cleave and
 * Nick are extra attacks the player makes. The stored definition is untouched: this is what the creature uses now.
 */

type Data = Record<string, unknown>;
interface MasteryActor {id?: string | null; system?: {training?: {masteries?: string[]}}}

/** The masteries that follow the attack as their own Actions. */
export const FOLLOW_UP_MASTERIES = Object.freeze(["topple", "graze"]);

const UNTIL_NEXT_TURN = {value: 1, units: "rounds", expiry: "turnStart"};
const UNTIL_NEXT_TURN_END = {value: 1, units: "rounds", expiry: "turnEnd"};
const rule = (id: string, type: string, data: Data, predicate: Data | null = null) =>
  ({schemaVersion: 1, id, type, data, ...(predicate ? {predicate} : {})});

/** What each mastery adds to an attack by `actor`, or null when it does nothing to the attack itself. */
const RIDERS: Record<string, (actor: MasteryActor) => Data> = {
  // Push: a hit Large or smaller creature is pushed 10 feet away.
  push: () => ({push: {distance: 10, maxSize: "large"}}),
  // Slow: a hit creature's Speed is 10 feet lower until the start of your next turn (never more than 10).
  slow: () => ({effects: [{id: "mastery-slow", type: "effect", name: "Slowed", slug: "mastery-slowed", img: "icons/svg/net.svg",
    duration: UNTIL_NEXT_TURN, ruleElements: [rule("mastery-slow", "Modifier",
      {domains: ["resources.movement.max", "speed"], modifierType: "untyped", value: -10})]}]}),
  // Sap: a hit creature has Disadvantage on its next attack roll before the start of your next turn.
  sap: () => ({effects: [{id: "mastery-sap", type: "effect", name: "Sapped", slug: "mastery-sapped", img: "icons/svg/downgrade.svg",
    duration: UNTIL_NEXT_TURN, endsWhen: "attacks",
    ruleElements: [rule("mastery-sap", "RollMode", {domains: ["attack"], mode: "disadvantage"})]}]}),
  // Vex: your next attack roll against a creature you hit has Advantage, before the end of your next turn. Each
  // creature's Vex is its own (`attack.fromAttacker`: what the target has from this attacker).
  vex: actor => {
    const slug = `mastery-vexed-${actor.id ?? "creature"}`;
    return {effects: [{id: "mastery-vex", type: "effect", name: "Vexed", slug, img: "icons/svg/target.svg",
      duration: UNTIL_NEXT_TURN_END, endsWhen: "attackedBySource",
      ruleElements: [rule("mastery-vex", "RollMode", {domains: ["attacked"], mode: "advantage"},
        {equals: {path: `attack.fromAttacker.${slug}`, value: true}})]}]};
  }
};

/** The mastery `actor` uses with this attack's weapon, or null. */
export function weaponMasteryOf(attack: {weapon?: {base?: string; mastery?: string}} | null | undefined, actor: MasteryActor | null | undefined) {
  const weapon = attack?.weapon;
  const masteries = actor?.system?.training?.masteries ?? [];
  return (weapon?.mastery && weapon.base && masteries.includes(weapon.base)) ? weapon.mastery : null;
}

/** `raw` with the mastery `actor` uses: `attack.mastery` names it, and its rider joins the attack. */
export function withWeaponMastery<T extends Data | null | undefined>(raw: T, actor: MasteryActor | null | undefined): T {
  const attack = raw?.attack as {weapon?: {base?: string; mastery?: string}} | undefined;
  const mastery = weaponMasteryOf(attack, actor);
  if ( !raw || !mastery ) return raw;
  const rider = RIDERS[mastery]?.(actor!) ?? {};
  const effects = rider.effects as Data[] | undefined;
  return {...raw, ...rider, attack: {...attack, mastery},
    ...(raw.push && rider.push ? {push: raw.push} : {}),
    ...(effects ? {effects: [...((raw.effects as Data[] | undefined) ?? []), ...effects]} : {})} as T;
}
