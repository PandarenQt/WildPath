import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_OUTCOME_KEYS,
  chatVisibilityForMode,
  createResolutionCardViewModel
} from "../module/helpers/chat-card-view-model.mjs";
import {
  RESOLUTION_CARD_TEMPLATE,
  createFoundryV14ChatCardAdapter
} from "../module/adapters/foundry-v14-chat-card-adapter.mjs";
import {projectResolutionResultForDisclosure} from "../module/helpers/multiplayer-authority.mjs";
import {DISCLOSURE_CLASSIFICATIONS} from "../module/helpers/multiplayer-disclosure.mjs";

const SECRET = "SECRET_CARD_931";
const foundryRoll = {class: "Roll", formula: "1d20 + 4", evaluated: true, total: 22, terms: [], options: {}};

function publicResult() {
  // Sentinels sit in every extensible place the authority's full result has; the projection and the
  // view model must both drop them.
  return projectResolutionResultForDisclosure({
    resolutionId: "resolution:card", status: "completed", ok: true, initiatorUserId: "player-a",
    action: {id: "strike", name: "Strike", effectiveDefinition: SECRET},
    targets: [
      {id: "goblin", actorRef: "Actor.goblin", name: "Goblin", defense: {value: SECRET}},
      {id: "orc", actorRef: "Actor.orc", name: "Orc", defenses: {ac: {value: SECRET}}}
    ],
    rolls: [
      {requestId: "a", type: "attack-roll", visibility: "public", rollResult: {natural: 18, total: 22, raw: {foundryRoll}}},
      {requestId: "s", type: "save", visibility: "system", rollResult: {total: 9, raw: {foundryRoll: {...foundryRoll, total: 9}}}}
    ],
    outcomes: {
      attack: {results: [
        {target: {actorRef: "Actor.goblin"}, hit: true, critical: true, defense: SECRET},
        {target: {actorRef: "Actor.orc"}, hit: false, critical: false, margin: SECRET}
      ]},
      save: {results: [{target: {actorRef: "Actor.orc"}, success: false, dc: {value: SECRET}}]},
      damage: {results: [{target: {id: "goblin"}, total: SECRET}]}
    },
    committedMutations: [{updates: {"system.resources.health.value": SECRET}}]
  }, DISCLOSURE_CLASSIFICATIONS.BROADCAST_SAFE);
}

test("the card view model reads only names, outcomes and public Roll JSON from the public projection", () => {
  const view = createResolutionCardViewModel(publicResult());
  assert.deepEqual(view, {
    resolutionId: "resolution:card",
    actionName: "Strike",
    targets: [
      {name: "Goblin", attack: CHAT_OUTCOME_KEYS.critical, save: null},
      {name: "Orc", attack: CHAT_OUTCOME_KEYS.miss, save: CHAT_OUTCOME_KEYS.saveFailure}
    ],
    rolls: [foundryRoll]
  });
  assert.equal(JSON.stringify(view).includes(SECRET), false);
});

test("chat visibility follows the initiator's message mode, never the authority's", () => {
  const options = {initiatorUserId: "player-a", gmUserIds: ["gm-a", "gm-b"]};
  assert.deepEqual(chatVisibilityForMode("public", options), {whisper: [], blind: false});
  assert.deepEqual(chatVisibilityForMode("ic", options), {whisper: [], blind: false});
  assert.deepEqual(chatVisibilityForMode("gm", options), {whisper: ["gm-a", "gm-b"], blind: false});
  assert.deepEqual(chatVisibilityForMode("blind", options), {whisper: ["gm-a", "gm-b"], blind: true});
  assert.deepEqual(chatVisibilityForMode("self", options), {whisper: ["player-a"], blind: false});
  assert.deepEqual(chatVisibilityForMode("bogus", options), {whisper: [], blind: false});
  assert.deepEqual(chatVisibilityForMode(null, options), {whisper: [], blind: false});
});

function fakeFoundry() {
  const created = [];
  return {
    created,
    ChatMessage: {
      create: async data => {
        created.push(data);
        return {id: "message-1", ...data};
      },
      getSpeaker: ({actor}) => ({actor: actor?.id ?? null, alias: actor?.name ?? null})
    },
    Roll: {
      fromData: data => ({render: async () => `<roll total="${data.total}">`, toJSON: () => data})
    },
    renderTemplate: async (path, data) => JSON.stringify({path, data}),
    game: {users: [{id: "gm-a", isGM: true}, {id: "player-a", isGM: false}]}
  };
}

test("the chat card adapter posts one public card authored by the initiator, with the public rolls attached", async () => {
  const foundry = fakeFoundry();
  const publish = createFoundryV14ChatCardAdapter(foundry);
  const posted = await publish({resolutionId: "resolution:card", initiatorUserId: "player-a", messageMode: "public",
    actor: {id: "hero", name: "Hero"}, action: {id: "strike"}, result: publicResult()});
  assert.equal(posted.posted, true);
  assert.equal(foundry.created.length, 1);
  const [message] = foundry.created;
  assert.equal(message.author, "player-a");
  assert.deepEqual(message.speaker, {actor: "hero", alias: "Hero"});
  assert.deepEqual(message.whisper, []);
  assert.equal(message.blind, false);
  assert.deepEqual(message.rolls, [foundryRoll]);
  assert.deepEqual(message.flags, {wildpath: {resolutionId: "resolution:card"}});
  const rendered = JSON.parse(message.content);
  assert.equal(rendered.path, RESOLUTION_CARD_TEMPLATE);
  assert.equal(rendered.data.rollHtml, "<roll total=\"22\">");
  assert.equal(message.content.includes(SECRET), false);
});

test("the chat card adapter whispers a gm-mode card to the GMs and skips non-Action or unfinished results", async () => {
  const foundry = fakeFoundry();
  const publish = createFoundryV14ChatCardAdapter(foundry);
  const base = {resolutionId: "resolution:card", initiatorUserId: "player-a", actor: {id: "hero"}, action: {id: "strike"}};
  await publish({...base, messageMode: "gm", result: {...publicResult(), rolls: []}});
  assert.deepEqual(foundry.created[0].whisper, ["gm-a"]);
  assert.deepEqual(foundry.created[0].rolls, [], "a gm-mode Action has no public rolls to attach");

  assert.equal((await publish({...base, action: null, messageMode: "public", result: publicResult()})).posted, false,
    "movement and other non-Action resolutions post nothing");
  assert.equal((await publish({...base, messageMode: "public", result: {...publicResult(), status: "failed"}})).posted, false);
  assert.equal(foundry.created.length, 1);
});
