/**
 * Journeys (2024 DMG travel, 2026-10-22): a GM tool among the Token controls. The party travels some hours at a pace:
 * - Fast 4, Normal 3, Slow 2 miles an hour. Fast: Disadvantage on Wits (Perception) and (Survival) checks; Slow:
 *   Advantage on them (and Stealth is possible), as an effect on each player character for those hours.
 * - Past 8 hours a day is a forced march: for each hour beyond, each character makes a Fortitude save, DC 10 + 1 for each
 *   hour past 8, and gains 1 Exhaustion level on a failure.
 * - The world's time moves on by those hours, and the chat says how far the party went.
 * shortcut: navigation, foraging and terrain (difficult terrain halving the distance) are the GM's; upgrade with a route.
 */

export const PACES = Object.freeze({fast: {mph: 4, mode: "disadvantage"}, normal: {mph: 3, mode: null}, slow: {mph: 2, mode: "advantage"}});

/** How far a journey of `hours` at `pace` goes, and the forced-march DCs past 8 hours. */
export function journeyPlan(pace, hours) {
  const h = Math.max(Math.floor(Number(hours) || 0), 0);
  const speed = PACES[pace] ?? PACES.normal;
  return {miles: speed.mph * h, forcedMarch: Array.from({length: Math.max(h - 8, 0)}, (_, index) => 10 + index + 1)};
}

/** The pace's effect on a traveler: its Perception and Survival checks' roll mode, for the journey's hours. */
export function paceEffect(pace, hours, name) {
  const mode = PACES[pace]?.mode;
  return mode ? {type: "effect", name, img: "icons/environment/wilderness/terrain-forest-gray.webp", duration: {value: hours, units: "hours"},
    system: {ruleElements: [{schemaVersion: 1, id: `pace-${pace}`, type: "RollMode",
      data: {domains: ["check.perception", "check.survival"], mode}}]}} : null;
}

/** The journey: each member's pace effect and forced march, then time moves on. Returns what happened. */
export async function travel({pace, hours, actors, time=globalThis.game?.time, i18n=globalThis.game?.i18n}) {
  const plan = journeyPlan(pace, hours);
  const effect = paceEffect(pace, plan.miles / (PACES[pace]?.mph ?? 3), i18n?.format?.("WILDPATH.JOURNEY.Pace", {pace: i18n.localize(`WILDPATH.JOURNEY.${pace}`)})
    ?? pace);
  const exhausted = [];
  for ( const actor of actors ) {
    for ( const old of [...(actor.effects ?? [])].filter(entry => entry.flags?.wildpath?.journeyPace) ) await old.delete();
    if ( effect ) await actor.createEmbeddedDocuments("ActiveEffect", [{...effect, flags: {wildpath: {journeyPace: pace}}}]);
    for ( const dc of plan.forcedMarch ) {
      const total = await actor.rollTest?.({save: "fortitude"});
      if ( !(Number(total) >= dc) ) {
        await actor.toggleCondition?.("exhaustion");
        exhausted.push(actor.name);
      }
    }
  }
  await time?.advance?.(Math.max(Math.floor(Number(hours) || 0), 0) * 3600);
  return {...plan, exhausted};
}

async function askAndTravel() {
  const game = globalThis.game;
  const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;
  const pace = key => `<option value="${key}"${key === "normal" ? " selected" : ""}>${game.i18n.localize(`WILDPATH.JOURNEY.${key}`)}</option>`;
  const answer = await DialogV2?.input?.({window: {title: game.i18n.localize("WILDPATH.JOURNEY.Title")},
    content: `<p>${game.i18n.localize("WILDPATH.JOURNEY.Hint")}</p>
      <label>${game.i18n.localize("WILDPATH.JOURNEY.PaceLabel")} <select name="pace">${Object.keys(PACES).map(pace).join("")}</select></label>
      <label>${game.i18n.localize("WILDPATH.JOURNEY.Hours")} <input type="number" name="hours" value="8" min="1" max="24" step="1"></label>`,
    rejectClose: false});
  if ( !answer?.pace || !(Number(answer.hours) > 0) ) return;
  const actors = [...game.actors].filter(actor => (actor.type === "character") && actor.hasPlayerOwner);
  const result = await travel({pace: answer.pace, hours: Number(answer.hours), actors});
  await globalThis.ChatMessage?.create?.({content: game.i18n.format("WILDPATH.JOURNEY.Done", {miles: result.miles, hours: answer.hours,
    pace: game.i18n.localize(`WILDPATH.JOURNEY.${answer.pace}`)}) + (result.exhausted.length
    ? ` ${game.i18n.format("WILDPATH.JOURNEY.Exhausted", {names: [...new Set(result.exhausted)].join(", ")})}` : "")});
}

export function registerJourney() {
  globalThis.Hooks?.on?.("getSceneControlButtons", controls => {
    const tokens = controls?.tokens;
    if ( !tokens?.tools || !globalThis.game?.user?.isGM ) return;
    tokens.tools.journey = {name: "journey", title: "WILDPATH.JOURNEY.Title", icon: "fa-solid fa-route", button: true,
      order: Object.keys(tokens.tools).length + 1, onChange: () => void askAndTravel()};
  });
}
