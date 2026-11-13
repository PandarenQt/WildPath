/**
 * Heroic Inspiration on a sheet roll's card (BG3, G8): an ability check, skill check or save rolled from the sheet
 * (`Actor#rollTest`) commits nothing, so its card may offer a reroll. A player's character spends its own point; for
 * a monster's roll the GM picks the player character whose point pays. The old card is marked used and the point spent
 * by the active GM alone (its author's own client when no GM is connected), so two clicks at once reroll once. An
 * Action's d20 is offered its reroll by the pipeline instead, before anything is committed.
 */
import {WILDPATH} from "../config.mjs";
import {claimCard, isRecentRoll} from "../helpers/chat-card-view-model.mjs";
import {writeInOrder} from "../helpers/crafting.mjs";
import {commitActorResourceMutationPlan, resolveActorResourcePayment} from "../resolvers/resource-resolver.mjs";
import {serializeActorWrite} from "../resolvers/target-mutation-commit-resolver.mjs";
import {foundryActorSystemSnapshot} from "../adapters/foundry-v14-actor-system-adapter.mjs";

type Data = Record<string, unknown>;
interface User {id?: string; isGM?: boolean}
interface Pool {id: string; value: number}
interface RollActor {
  uuid: string; name: string; type: string; hasPlayerOwner?: boolean; isOwner?: boolean;
  system: {pools?: Pool[]};
  toObject(source?: boolean): {system: {pools: Pool[]}};
  testUserPermission(user: object, level: "OWNER"): boolean;
  update(data: Data): Promise<unknown>;
  rollTest(options: Data): Promise<unknown>;
}
interface RollTestFlag {actorUuid?: string; ability?: string | null; skill?: string | null; save?: string | null; rerolled?: boolean}
interface RollMessage {
  id: string; timestamp?: number; flags?: {wildpath?: {rollTest?: RollTestFlag}};
  canUserModify(user: object, action: "update"): boolean;
  update(data: Data): Promise<unknown>;
}
interface Globals {
  canvas?: {scene?: {tokens: Iterable<{actor?: RollActor | null}>} | null};
  game: {user?: User; settings?: {get(scope: string, key: string): unknown};
    messages: {get(id: string): RollMessage | undefined};
    users: {activeGM?: {id?: string; query(name: string, data: Data, options: Data): Promise<{ok?: boolean} | undefined>} | null};
    i18n: {localize(key: string): string; format(key: string, data: Data): string}};
  CONFIG: {queries: Record<string, (data: Data, context: {user: User}) => unknown>};
  fromUuidSync(uuid: string): unknown;
  foundry: {applications: {api: {DialogV2: {input(config: Data): Promise<Data | null>}}}; utils: {escapeHTML(text: string): string}};
  ui: {notifications: {warn(message: string): void}};
  Hooks: {on(name: string, fn: (message: RollMessage, html: HTMLElement) => void): unknown};
}

const globals = () => globalThis as unknown as Globals;
const INSPIRATION = (WILDPATH as unknown as {HEROIC_INSPIRATION: {pool: string; max: number}}).HEROIC_INSPIRATION;
const points = (actor: RollActor) => actor.system.pools?.find(pool => pool.id === INSPIRATION.pool)?.value ?? 0;
export const INSPIRATION_QUERY = "wildpath.inspirationReroll";

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

/** One of `payer`'s points, by the payment rule the pipeline's offer pays with (inspirationOffer); null when it has none. */
function inspirationPayment(payer: RollActor): Data | null {
  const payment = resolveActorResourcePayment({actorSystem: foundryActorSystemSnapshot(payer),
    cost: {allOf: [{capability: INSPIRATION.pool, amount: 1}]}});
  return payment.ok ? payment.mutationPlan : null;
}

/**
 * Claim `message`'s reroll for `user`: the card is marked used, then one point is spent from what the payer holds at
 * that moment (one write at a time per creature), and the card is given back if the spend fails. The payer is the
 * roller, or for a GM's request the character the GM picked (`payerUuid`, a monster's roll). Only one client claims, so
 * two clicks at once cannot both pass: the active GM, or with no GM the card's author (the only user then able to mark
 * it). False for a card already claimed or being claimed (by any spender, claimCard), or a payer `user` does not own
 * or with no point.
 */
async function claim(message: RollMessage | undefined, user: User, payerUuid?: unknown): Promise<boolean> {
  if ( !message ) return false;
  return (await claimCard(message, async () => {
    const test = message.flags?.wildpath?.rollTest;
    if ( !test?.actorUuid || test.rerolled || !isRecentRoll(message) ) return false;
    const payer = globals().fromUuidSync(String((user.isGM && payerUuid) || test.actorUuid)) as RollActor | null;
    if ( !payer?.hasPlayerOwner || !payer.testUserPermission(user, "OWNER") || !inspirationPayment(payer) ) return false;
    await writeInOrder([[message, {"flags.wildpath.rollTest.rerolled": true}], () => serializeActorWrite(payer, async () => {
      const plan = inspirationPayment(payer);
      if ( !plan || !(await commitActorResourceMutationPlan(payer, plan)) ) throw new Error(`${payer.name}'s Heroic Inspiration could not be spent.`);
    })]);
    return true;
  })) ?? false;
}

/** The active GM's answer to a user's claim (INSPIRATION_QUERY). */
async function claimForUser({messageId, payerUuid}: Data, {user}: {user: User}) {
  const {game} = globals();
  return {ok: !!game.user?.isGM && await claim(game.messages.get(String(messageId)), user, payerUuid)};
}

/** Have the card claimed (here when this client claims, else by the active GM), then roll the same test again. */
async function reroll(message: RollMessage, actor: RollActor, test: RollTestFlag, payers: RollActor[]) {
  const {game, ui} = globals();
  const payer = actor.hasPlayerOwner ? payers[0] ?? null : await choosePayer(payers);
  if ( !payer ) return false;
  if ( !inspirationPayment(payer) ) {
    ui.notifications.warn(game.i18n.format("WILDPATH.INSPIRATION.NoPoints", {name: payer.name}));
    return false;
  }
  const {user, users: {activeGM}} = game;
  const here = !!user && (activeGM ? activeGM.id === user.id : message.canUserModify(user, "update"));
  // No timeout: a GM that answers late may already have spent the point, and only its answer lets this client roll.
  const claimed = here ? await claim(message, user, payer.uuid)
    : (await activeGM?.query(INSPIRATION_QUERY, {messageId: message.id, payerUuid: payer.uuid}, {}).catch(() => undefined))?.ok;
  if ( !claimed ) return false;
  await actor.rollTest({ability: test.ability ?? null, skill: test.skill ?? null, save: test.save ?? null, rerolled: true});
  return true;
}

export function registerInspirationRerolls() {
  globals().CONFIG.queries[INSPIRATION_QUERY] = claimForUser;
  globals().Hooks.on("renderChatMessageHTML", (message, html) => {
    const test = message.flags?.wildpath?.rollTest;
    if ( !test?.actorUuid || test.rerolled || !isRecentRoll(message) ) return;
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
