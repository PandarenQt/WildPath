/**
 * Heroic Inspiration on a sheet roll's card (BG3, G8): an ability check, skill check or save rolled from the sheet
 * (`Actor#rollTest`) commits nothing, so its card may offer a reroll. A player's character spends its own point; for
 * a monster's roll the GM picks the player character whose point pays. The old card is marked used. An Action's d20 is
 * offered its reroll by the pipeline instead, before anything is committed.
 */
import {WILDPATH} from "../config.mjs";

type Data = Record<string, unknown>;
interface Pool {id: string; value: number}
interface RollActor {
  uuid: string; name: string; type: string; hasPlayerOwner?: boolean; isOwner?: boolean;
  system: {pools?: Pool[]};
  toObject(source?: boolean): {system: {pools: Pool[]}};
  update(data: Data): Promise<unknown>;
  rollTest(options: Data): Promise<unknown>;
}
interface RollTestFlag {actorUuid?: string; ability?: string | null; skill?: string | null; save?: string | null; rerolled?: boolean}
interface RollMessage {flags?: {wildpath?: {rollTest?: RollTestFlag}}; update(data: Data): Promise<unknown>}
interface Globals {
  canvas?: {scene?: {tokens: Iterable<{actor?: RollActor | null}>} | null};
  game: {user?: {isGM?: boolean}; settings?: {get(scope: string, key: string): unknown};
    i18n: {localize(key: string): string; format(key: string, data: Data): string}};
  fromUuidSync(uuid: string): unknown;
  foundry: {applications: {api: {DialogV2: {input(config: Data): Promise<Data | null>}}}; utils: {escapeHTML(text: string): string}};
  ui: {notifications: {warn(message: string): void}};
  Hooks: {on(name: string, fn: (message: RollMessage, html: HTMLElement) => void): unknown};
}

const globals = () => globalThis as unknown as Globals;
const INSPIRATION = (WILDPATH as unknown as {HEROIC_INSPIRATION: {pool: string; max: number}}).HEROIC_INSPIRATION;
const points = (actor: RollActor) => actor.system.pools?.find(pool => pool.id === INSPIRATION.pool)?.value ?? 0;

/**
 * Who may pay for this roll's reroll here: the character itself (its owner), or, for a monster, the GM's pick of the
 * player characters on the viewed Scene (the table's).
 */
function payersFor(actor: RollActor): RollActor[] {
  const {game, canvas} = globals();
  if ( actor.hasPlayerOwner ) return (actor.isOwner && (points(actor) > 0)) ? [actor] : [];
  if ( !game.user?.isGM || (game.settings?.get("wildpath", "inspirationMonsterRerolls") === false) ) return [];
  const actors = [...(canvas?.scene?.tokens ?? [])].map(token => token.actor);
  return [...new Set(actors.filter((entry): entry is RollActor => !!entry && (entry.type === "character") && !!entry.hasPlayerOwner
    && (points(entry) > 0)))];
}

/** The GM picks whose point pays for a monster's reroll; null when the dialog is closed. */
async function choosePayer(payers: RollActor[]): Promise<RollActor | null> {
  const {game: {i18n}, foundry: {applications: {api: {DialogV2}}, utils}} = globals();
  const options = payers.map(payer => `<option value="${utils.escapeHTML(payer.uuid)}">${utils.escapeHTML(i18n.format("WILDPATH.INSPIRATION.Spend",
    {name: payer.name, value: points(payer), max: INSPIRATION.max}))}</option>`).join("");
  const answer = await DialogV2.input({classes: ["wildpath", "themed", "theme-light"], window: {title: i18n.localize("WILDPATH.INSPIRATION.Title")},
    content: `<label>${i18n.localize("WILDPATH.INSPIRATION.ChoosePayer")} <select name="payer">${options}</select></label>`,
    ok: {label: i18n.localize("WILDPATH.INSPIRATION.Reroll")}, rejectClose: false});
  return payers.find(payer => payer.uuid === answer?.payer) ?? null;
}

/** Spend `payer`'s point, mark the old card used, and roll the same test again. */
async function reroll(message: RollMessage, actor: RollActor, test: RollTestFlag, payers: RollActor[]) {
  const {game: {i18n}, ui} = globals();
  const payer = actor.hasPlayerOwner ? payers[0] ?? null : await choosePayer(payers);
  if ( !payer ) return false;
  const pools = payer.toObject(true).system.pools;
  const pool = pools.find(entry => entry.id === INSPIRATION.pool);
  if ( !pool || (pool.value < 1) ) {
    ui.notifications.warn(i18n.format("WILDPATH.INSPIRATION.NoPoints", {name: payer.name}));
    return false;
  }
  pool.value -= 1;
  await payer.update({"system.pools": pools});
  await message.update({"flags.wildpath.rollTest.rerolled": true});
  await actor.rollTest({ability: test.ability ?? null, skill: test.skill ?? null, save: test.save ?? null, rerolled: true});
  return true;
}

export function registerInspirationRerolls() {
  globals().Hooks.on("renderChatMessageHTML", (message, html) => {
    const test = message.flags?.wildpath?.rollTest;
    if ( !test?.actorUuid || test.rerolled ) return;
    const actor = globals().fromUuidSync(test.actorUuid) as RollActor | null;
    const payers = actor ? payersFor(actor) : [];
    if ( !actor || !payers.length ) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "wildpath-inspiration-reroll";
    button.textContent = globals().game.i18n.localize("WILDPATH.INSPIRATION.Reroll");
    button.addEventListener("click", async () => {
      button.disabled = true;
      if ( !(await reroll(message, actor, test, payers)) ) button.disabled = false;
    });
    (html.querySelector(".message-content") ?? html).append(button);
  });
}
