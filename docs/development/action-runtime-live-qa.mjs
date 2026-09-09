// Development-only companion to action-runtime-live-qa.md. Never registered by system startup.
import {actionDefinitionFromAction} from "../../module/helpers/action-definitions.mjs";
import {resolveActorAttackStatistic, resolveActorDefense} from "../../module/helpers/combat-statistics.mjs";
import {createFoundryV14TacticalGridAdapter} from "../../module/adapters/foundry-v14-tactical-grid-adapter.mjs";
import {footprintDistance} from "../../module/helpers/grid-footprints.mjs";
import {MULTIPLAYER_MESSAGE_TYPES as MESSAGE} from "../../module/helpers/multiplayer-authority.mjs";

export const QA_FLAG = "actionRuntimeLiveQA";
export const QA_BASELINE = "61d6268b838e286728c829924506c6c931174621";
const DEADLINE_MS = 20000;
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const check = (condition, message) => { if (!condition) throw new Error(message); };
const marker = document => document?.getFlag("wildpath", QA_FLAG);
const flags = data => ({wildpath: {[QA_FLAG]: data}});

export function qaActionData(runId) {
  return {
    name: "QA ordinary melee", type: "action", flags: flags({runId, role: "action"}),
    system: {
      active: true,
      modifiers: [{id: "qa-attack", selector: "attack.weapon", domains: ["attack.weapon"],
        label: "QA attack modifier", type: "untyped", value: 4, enabled: true}],
      definition: {
        schemaVersion: 1, id: `action:qa-melee:${runId}`, label: "QA ordinary melee",
        costs: {allOf: [{capability: "action", amount: 1}]},
        targeting: {type: "single", required: true, count: 1},
        range: {type: "reach", distance: {value: 5, unit: "ft"}},
        // Supported persisted policy, confined to this marked Item. Still requests a real d20.
        attack: {type: "melee", statistic: "weapon", defenseKey: "ac",
          policy: {naturalCriticalHits: false, naturalCriticalMisses: false}},
        damage: [{id: "qa-fixed", expression: {type: "constant", value: 6},
          damageType: "slashing", provenance: "weapon-base"}]
      }
    }
  };
}

// Diagnostics deliberately select plain contract fields before bounding their size.
export function bounded(value, depth=0) {
  if (value == null) return null;
  if (typeof value === "string") return value.length > 1000 ? `${value.slice(0, 1000)} [truncated]` : value;
  if (typeof value !== "object") return value;
  if (depth >= 10) return "[depth limit]";
  if (Array.isArray(value)) return [...value.slice(0, 20).map(v => bounded(v, depth + 1)),
    ...(value.length > 20 ? [`[${value.length - 20} more entries]`] : [])];
  const entries = Object.entries(value);
  return Object.fromEntries([...entries.slice(0, 32).map(([key, v]) => [key, bounded(v, depth + 1)]),
    ...(entries.length > 32 ? [["_omittedKeys", entries.length - 32]] : [])]);
}

function footprintSummary(footprint) {
  return footprint ? {topology: footprint.topology, anchor: footprint.anchor,
    fieldCount: footprint.fields?.length, fields: footprint.fields, metadata: footprint.metadata} : null;
}

export function summarizeRecord(record) {
  const state = record?.state;
  const spatial = record?.options?.context?.spatial;
  const actionResult = state?.results?.actionResult;
  return bounded({
    resolutionId: record?.resolutionId, authorityUserId: record?.authorityUserId,
    initiatorUserId: record?.initiatorUserId, status: state?.status, currentStage: state?.currentStageId,
    completedStages: state?.completedStageIds, pendingRequests: state?.pendingRequests,
    routing: [...(record?.requestExpectations?.values() ?? [])],
    processedRequestIds: [...(record?.processedRequestIds ?? [])],
    source: state?.source ?? record?.options?.source,
    targets: state?.targets ?? record?.options?.targets,
    sourceFootprint: footprintSummary(spatial?.sourceFootprint),
    targetFootprints: spatial?.targetFootprints?.map(t => ({target: t.target,
      actor: t.actor, footprint: footprintSummary(t.footprint)})),
    range: state?.results?.rangeResolution,
    attackStatistic: record?.options?.attack?.statistic,
    attackModifier: record?.options?.attack?.modifierTotal,
    rollRequests: state?.rollRequests, rollResults: state?.rollResults,
    attack: state?.results?.attackResolution, mutationPlans: state?.mutationPlans,
    persistenceAdapter: record?.options?.persistencePort?.id,
    transaction: actionResult?.steps?.findLast(step => step.data?.transaction)?.data?.transaction,
    commit: {ok: actionResult?.ok, status: actionResult?.status, code: actionResult?.code},
    errors: state?.errors, validation: state?.validation, traceTail: state?.trace?.slice(-12)
  });
}

export function matchesQAIntent(envelope, fixture) {
  return envelope?.messageType === MESSAGE.ACTION_INTENT
    && envelope.senderUserId === fixture.playerId && envelope.recipientUserId === fixture.gmId
    && envelope.payload?.actorRef === fixture.sourceRef
    && envelope.payload?.actionRef === fixture.actionRef;
}

export function verifyDigitalRoll(result, resolutionId) {
  check(result?.resolutionId === resolutionId, "Roll resolutionId mismatch");
  check(result.provider?.id === "foundry-digital" && result.provider?.type === "foundry-digital",
    "Expected the registered Foundry digital provider");
  check(result.provenance?.type === "foundry-digital" && result.provenance?.method === "digital"
    && result.provenance?.source === "foundry-roll", "Missing real Foundry digital provenance");
  check(result.raw?.foundryRoll && Array.isArray(result.raw.foundryRoll.terms), "Missing serialized Foundry Roll terms");
  check(Number.isInteger(result.natural) && result.natural >= 1 && result.natural <= 20,
    "Expected a natural d20 result");
  check(result.total === result.natural + 4, "Expected Actor-derived +4 attack modifier");
}

export function combineClientDumps(gm, player) {
  check(gm?.role === "gm" && player?.role === "player", "Expected one dump from each client");
  for (const key of ["runId", "mode", "resolutionId", "authorityUserId", "playerId"]) {
    check(gm[key] != null && gm[key] === player[key], `Client dump ${key} mismatch`);
  }
  return {gm, player};
}

function actorSnapshot(actor) {
  if (!actor) return null;
  const data = actor.toObject(true);
  return {resources: data.system.resources, effects: data.effects ?? [], items: data.items ?? []};
}

function requireRuntime(role) {
  const {game, canvas} = globalThis;
  check(game?.release?.generation === 14 && Number(game.release.build) === 367, "Use Foundry V14.367");
  check(game.system.id === "wildpath" && canvas?.ready, "Load WildPath and a ready Scene");
  check(canvas.scene.id === game.scenes.active?.id, "View the active Scene on both clients");
  check(game.users.activeGM?.active, "An active GM is required");
  check(role === "gm" ? game.user.id === game.users.activeGM.id : !game.user.isGM,
    `Run this block on the ${role === "gm" ? "active GM" : "initiating Player"}`);
  check(!game.combat?.started, "Stop combat before QA; turn changes can refresh resources");
  check(![...game.modules.values()].some(module => module.active), "Disable optional modules and reload both clients");
  const runtime = game.wildpath?.multiplayer;
  check(runtime?.transport?.registered && runtime.transport.namespace === "system.wildpath"
    && runtime.coordinator?.getRecord && runtime.coordinator?.getResult
    && game.wildpath.executeActionIntent === runtime.executeActionIntent, "Expected the normal registered runtime");
  check(typeof game.socket.onAnyOutgoing === "function" && typeof game.socket.offAnyOutgoing === "function",
    "Socket.IO outgoing observation API is unavailable; do not patch transport.send");
  return runtime;
}

function documents(fixture) {
  const scene = game.scenes.get(fixture.sceneId);
  const source = scene?.tokens.get(fixture.sourceTokenId);
  const target = scene?.tokens.get(fixture.targetTokenId);
  return {scene, source, target, sourceActor: source?.actor, targetActor: target?.actor,
    sourceBase: game.actors.get(fixture.sourceActorId), targetBase: game.actors.get(fixture.targetActorId)};
}

function capture(fixture) {
  const d = documents(fixture);
  return {sourceRef: d.sourceActor?.uuid, targetRef: d.targetActor?.uuid,
    action: d.sourceActor?.system.resources.action.value,
    hp: d.targetActor?.system.resources.health.value,
    ac: resolveActorDefense(d.targetActor)?.value,
    sourceBase: actorSnapshot(d.sourceBase), targetBase: actorSnapshot(d.targetBase),
    sourceEffects: [...(d.sourceActor?.effects ?? [])].map(e => e.toObject()),
    targetEffects: [...(d.targetActor?.effects ?? [])].map(e => e.toObject())};
}

function verifyPersistence(before, after, mode) {
  check(after.sourceRef === before.sourceRef && after.targetRef === before.targetRef, "Actor identity changed");
  check(before.action === 1 && after.action === 0, "Expected exactly one Action spent");
  check(before.hp === 30 && after.hp === 30 - (mode === "hit" ? 6 : 0), "Unexpected target HP change");
  check(after.ac === before.ac, "Target AC changed during resolution");
  check(JSON.stringify(after.sourceBase) === JSON.stringify(before.sourceBase), "Source base world Actor changed");
  check(JSON.stringify(after.targetBase) === JSON.stringify(before.targetBase), "Target base world Actor changed");
  check(after.sourceEffects.length === 0 && after.targetEffects.length === 0, "Unexpected ActiveEffects");
}

// Both inbound and outbound observation are necessary: Foundry custom sockets exclude the sender.
// These listeners neither modify envelopes nor answer requests nor replace any runtime method.
function observe(fixture, role) {
  const runtime = requireRuntime(role);
  check(!globalThis.wpActionRuntimeQA, "Clean up the previous QA observer first");
  const qa = globalThis.wpActionRuntimeQA = {
    fixture, role, runtime, mode: null, resolutionId: null, startedAt: null, before: null,
    envelopes: [], history: [], errors: [], passed: {}, failed: false, lastDump: null, declared: null
  };
  qa.dump = (reason=null) => {
    const record = qa.resolutionId ? runtime.coordinator.getRecord(qa.resolutionId) : null;
    const result = qa.resolutionId ? runtime.coordinator.getResult(qa.resolutionId) : null;
    let after;
    try { after = capture(fixture); }
    catch (error) { after = {snapshotError: error.message}; }
    const output = {runId: fixture.runId, baseline: QA_BASELINE, role, mode: qa.mode,
      resolutionId: qa.resolutionId, authorityUserId: fixture.gmId, playerId: fixture.playerId,
      declarationSuccess: qa.declared, proofPassed: qa.passed[qa.mode] === true, reason, errors: [...qa.errors],
      record: summarizeRecord(record), before: qa.before, after,
      envelopes: qa.envelopes, coordinatorResult: result,
      resultEnvelope: runtime.coordinator.notifications.findLast(n => n.envelope?.resolutionId === qa.resolutionId)?.envelope ?? null,
      coordinatorErrors: runtime.coordinator.errors.filter(e =>
        (e.envelope?.resolutionId ?? e.error?.resolutionId) === qa.resolutionId), history: qa.history};
    qa.lastDump = bounded(output);
    return qa.lastDump;
  };
  qa.fail = error => {
    const reason = error?.message ?? String(error);
    if (!qa.errors.includes(reason)) qa.errors.push(reason);
    qa.failed = true;
    console.error("STOP Action QA", JSON.stringify(qa.dump(reason), null, 2));
    return new Error(`STOP Action QA: ${reason}. Retained: wpActionRuntimeQA.lastDump`);
  };
  const receive = (direction, envelope, authenticatedUserId=null) => {
    if (qa.failed || !qa.mode) return;
    try {
      if (matchesQAIntent(envelope, fixture)) {
        check(!qa.resolutionId || qa.resolutionId === envelope.resolutionId, "More than one Item use in this case");
        qa.resolutionId = envelope.resolutionId;
        qa.startedAt ??= Date.now();
      }
      if (!qa.resolutionId || envelope?.resolutionId !== qa.resolutionId) return;
      if (qa.envelopes.some(e => e.direction === direction && e.envelope.messageId === envelope.messageId)) return;
      check(qa.envelopes.length < 12, "Unexpected excess socket traffic for this single Action");
      qa.envelopes.push({direction, authenticatedUserId, envelope: clone(envelope)});
      if (envelope.messageType === MESSAGE.RESOLUTION_ERROR) throw new Error(envelope.payload?.reason ?? "Resolution error envelope");
    } catch (error) { qa.fail(error); }
  };
  qa.incoming = (envelope, sender) => receive("incoming", envelope, sender);
  qa.outgoing = (namespace, envelope) => { if (namespace === "system.wildpath") receive("outgoing", envelope); };
  game.socket.on("system.wildpath", qa.incoming);
  game.socket.onAnyOutgoing(qa.outgoing);
  qa.timer = setInterval(() => {
    if (!qa.startedAt || qa.failed || qa.passed[qa.mode]) return;
    try {
      check(game.users.activeGM?.id === fixture.gmId && canvas.scene?.id === fixture.sceneId,
        "QA authority or viewed Scene changed");
      const record = qa.resolutionId && runtime.coordinator.getRecord(qa.resolutionId);
      const state = record?.state;
      const stamp = `${state?.status}:${state?.currentStageId}`;
      if (state && qa.history.at(-1)?.stamp !== stamp) {
        qa.history.push({stamp, completedStages: state.completedStageIds, pendingRequests: state.pendingRequests});
        qa.history = qa.history.slice(-12);
      }
      if (state?.errors?.length || ["failed", "cancelled"].includes(state?.status)) throw new Error("Authoritative pipeline failed");
      const result = qa.resolutionId && runtime.coordinator.getResult(qa.resolutionId);
      if (result?.status === "completed" && result.ok === true) { qa.dump(); return; }
      check(Date.now() - qa.startedAt < DEADLINE_MS, "20-second terminal-result timeout");
    } catch (error) { qa.fail(error); }
  }, 100);
  qa.detach = () => {
    clearInterval(qa.timer);
    game.socket.off("system.wildpath", qa.incoming);
    game.socket.offAnyOutgoing(qa.outgoing);
  };
  qa.arm = (mode, before) => {
    check(game.users.activeGM?.id === fixture.gmId && canvas.scene?.id === fixture.sceneId,
      "QA authority or viewed Scene changed");
    check(!qa.failed, "Previous case failed; retain diagnostics and stop");
    check(mode === "hit" || mode === "miss", "Unknown QA case");
    check(!qa.mode || qa.passed[qa.mode], "Prior case has not passed its proof");
    check(!qa.passed[mode], "Case already completed; do not repeat an Item use");
    qa.mode = mode; qa.before = clone(before); qa.resolutionId = null; qa.startedAt = null;
    qa.envelopes = []; qa.history = []; qa.declared = null; qa.errors = [];
  };
  qa.wait = async predicate => {
    const until = Date.now() + DEADLINE_MS;
    while (Date.now() < until) {
      check(!qa.failed, "QA stopped; inspect retained dump");
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("20-second proof timeout");
  };
  return qa;
}

export async function setupGM(playerId) {
  requireRuntime("gm");
  check(!globalThis.wpActionRuntimeQA, "Clean up existing QA first");
  const player = game.users.get(playerId);
  check(player?.active && !player.isGM, "Choose an active non-GM Player");
  const scene = canvas.scene;
  check(canvas.level?.id && scene.tokenVision === false, "Use a test Scene level with Token Vision disabled");
  check(canvas.grid.isSquare && canvas.grid.distance === 5 && ["ft", "feet"].includes(canvas.grid.units),
    "Use a square-grid Scene with 5 ft per field");
  check(scene.tokens.size === 0 && scene.walls.size === 0 && scene.regions.size === 0,
    "Use an empty test Scene without Tokens, walls or Regions");
  check(![...game.actors].some(a => marker(a)), "Marked QA Actors already exist; recover/clean them first");
  const runId = foundry.utils.randomID();
  const fixture = {runId, playerId, gmId: game.user.id, sceneId: scene.id};
  // Retain identity before the first write, including when setup fails partway through.
  globalThis.wpActionRuntimeQASetup = fixture;
  try {
    const actors = [];
    for (const role of ["source", "target"]) {
      const actor = await CONFIG.Actor.documentClass.create({name: `QA melee ${role} ${runId}`, type: "character",
        ownership: {default: 0, [playerId]: role === "source" ? 3 : 2}, flags: flags({...fixture, role}),
        system: {resources: {health: {base: 30, value: 30}, action: {base: 1, value: 1}}},
        prototypeToken: {actorLink: false, width: 1, height: 1}});
      fixture[`${role}ActorId`] = actor.id;
      actors.push(actor);
    }
    const dims = scene.dimensions;
    const offset = canvas.grid.getOffset({x: dims.sceneX + dims.sceneWidth / 2, y: dims.sceneY + dims.sceneHeight / 2});
    const adjacent = [...canvas.grid.getAdjacentOffsets(offset)].find(p => p.i === offset.i || p.j === offset.j);
    check(adjacent, "No adjacent grid offset");
    for (let i = 0; i < actors.length; i++) {
      const role = i === 0 ? "source" : "target";
      const token = await actors[i].getTokenDocument({
        ...canvas.grid.getTopLeftPoint(i === 0 ? offset : adjacent),
        level: canvas.level.id, actorLink: false, width: 1, height: 1, hidden: false,
        name: `QA melee ${role}`, flags: flags({...fixture, role})
      }, {parent: scene});
      const [created] = await scene.createEmbeddedDocuments("Token", [token.toObject()]);
      fixture[`${role}TokenId`] = created.id;
    }
    const d = documents(fixture);
    check(d.sourceActor?.isToken && d.targetActor?.isToken, "Both QA Token Actors must be synthetic");
    check(d.sourceActor !== d.sourceBase && d.targetActor !== d.targetBase, "Synthetic Actor identity was lost");
    const [action] = await d.sourceActor.createEmbeddedDocuments("Item", [qaActionData(runId)]);
    check(action instanceof CONFIG.Item.documentClass && action.type === "action", "Expected a real WildPath Action Item");
    check(action.system.getActionDefinition().ok && actionDefinitionFromAction(action).ok, "Persisted ActionDefinition is invalid");
    Object.assign(fixture, {actionId: action.id, actionRef: action.uuid, sourceRef: d.sourceActor.uuid, targetRef: d.targetActor.uuid});
    const adapter = createFoundryV14TacticalGridAdapter({scene});
    const a = adapter.tokenToFootprint(d.source), b = adapter.tokenToFootprint(d.target);
    check(a.ok && b.ok && !a.diagnostics.length && !b.diagnostics.length
      && a.footprint.fields.length === 1 && b.footprint.fields.length === 1
      && footprintDistance(a.footprint, b.footprint) === 1, "QA Tokens must have adjacent one-field tactical footprints");
    check(resolveActorAttackStatistic(d.sourceActor, action.system.definition.attack)?.totalModifier === 4,
      "Persisted Item must contribute +4 to attack.weapon");
    await d.source.setFlag("wildpath", QA_FLAG, {...fixture, role: "source"});
    const qa = observe(fixture, "gm");
    qa.prepare = async mode => {
      requireRuntime("gm");
      check(!qa.failed && (!qa.mode || qa.passed[qa.mode]), "Prior case has not passed");
      check(mode === "hit" || (mode === "miss" && qa.passed.hit), "Run Hit then Miss");
      check(!qa.passed[mode], "Case already completed; do not prepare it again");
      const d = documents(fixture);
      await d.sourceActor.update({"system.resources.action.value": 1});
      await d.targetActor.update({"system.resources.health.value": 30, "system.defenses.ac.value": mode === "hit" ? 1 : 100});
      const before = capture(fixture);
      check(before.action === 1 && before.hp === 30 && before.ac === (mode === "hit" ? 1 : 100)
        && !before.sourceEffects.length && !before.targetEffects.length, "Fixture preparation mismatch");
      qa.arm(mode, before);
      await d.source.setFlag("wildpath", QA_FLAG, {...fixture, role: "source", prepared: {mode, before}});
      return qa.dump();
    };
    qa.prove = () => proveGM(qa);
    console.log("GM QA ready", clone(fixture));
    return qa;
  } catch (error) {
    console.error("STOP setup; retained cleanup IDs", clone(fixture), error);
    throw error;
  }
}

export function setupPlayer() {
  requireRuntime("player");
  const matches = [...canvas.scene.tokens].filter(t => marker(t)?.role === "source");
  check(matches.length === 1, "Expected exactly one marked source Token on this Scene");
  const fixture = clone(marker(matches[0]));
  check(fixture.playerId === game.user.id, "This is not the chosen Player");
  const qa = observe(fixture, "player");
  qa.targetReady = () => {
    requireRuntime("player");
    check(!qa.failed, "Previous case failed; retain diagnostics and stop");
    const target = documents(fixture).target;
    const selected = [...game.user.targets];
    if (!target || selected.length !== 1 || selected[0].document?.uuid !== target.uuid) {
      console.warn("TARGET NOT READY: use native targeting to target only QA melee target; then repeat the precheck.");
      return false;
    }
    console.log("Native target proof", {token: target.uuid, actor: target.actor.uuid});
    return true;
  };
  qa.begin = mode => {
    requireRuntime("player");
    const d = documents(fixture), prepared = marker(d.source)?.prepared;
    check(prepared?.mode === mode, "Wait for GM preparation of this case");
    check(d.sourceActor?.isToken && d.sourceActor.isOwner, "Expected owned synthetic source Actor");
    const targets = [...game.user.targets];
    check(targets.length === 1 && targets[0].document.uuid === d.target.uuid,
      "Use Foundry native targeting to target only the marked target Token");
    const action = d.sourceActor.items.get(fixture.actionId);
    check(action instanceof CONFIG.Item.documentClass && action.actor === d.sourceActor
      && action.uuid === fixture.actionRef, "Expected the real embedded WildPathItem");
    check(d.sourceActor.system.resources.action.value === 1 && d.targetActor.system.resources.health.value === 30,
      "Player Documents have not received GM preparation");
    qa.arm(mode, prepared.before);
    qa.startedAt = Date.now();
    return action;
  };
  qa.attachGM = text => {
    const gm = JSON.parse(text);
    const player = qa[`${qa.mode}Dump`] ?? qa.dump();
    const combined = combineClientDumps(gm, player);
    qa.lastCombinedDump = combined;
    console.log("Combined Action QA evidence", JSON.stringify(combined, null, 2));
    return combined;
  };
  qa.prove = async () => {
    await qa.wait(() => qa.resolutionId && qa.runtime.coordinator.getResult(qa.resolutionId));
    const result = qa.runtime.coordinator.getResult(qa.resolutionId);
    const notification = qa.runtime.coordinator.notifications.findLast(n => n.envelope?.resolutionId === qa.resolutionId);
    check(qa.declared === true, "Item.use() did not return declaration success");
    check(notification?.envelope?.senderUserId === fixture.gmId && notification.type === MESSAGE.RESOLUTION_RESULT,
      "Player did not receive the expected GM's terminal result envelope");
    check(result.resolutionId === qa.resolutionId && result.authorityUserId === fixture.gmId
      && result.initiatorUserId === fixture.playerId && result.ok && result.status === "completed", "Player terminal result mismatch");
    check(result.rolls?.length === 1, "Expected one attack roll result");
    verifyDigitalRoll(result.rolls[0].rollResult, qa.resolutionId);
    check(result.outcomes?.attack?.results?.length === 1
      && result.outcomes.attack.results[0].hit === (qa.mode === "hit"), "Player attack outcome mismatch");
    verifyPersistence(qa.before, capture(fixture), qa.mode);
    qa.passed[qa.mode] = true;
    const report = qa.dump();
    qa[`${qa.mode}Dump`] = report;
    console.log(`PASS Player ${qa.mode}`, JSON.stringify(report, null, 2));
    return report;
  };
  return qa;
}

async function proveGM(qa) {
  requireRuntime("gm");
  await qa.wait(() => qa.resolutionId && qa.runtime.coordinator.getResult(qa.resolutionId));
  const f = qa.fixture, record = qa.runtime.coordinator.getRecord(qa.resolutionId), state = record?.state;
  check(record?.authorityUserId === f.gmId && record.initiatorUserId === f.playerId
    && state?.status === "completed" && !state.errors.length && !state.pendingRequests.length, "GM terminal state mismatch");
  const d = documents(f);
  check(record.options.actor?.uuid === d.sourceActor.uuid && record.options.actor.isToken
    && record.options.source.tokenId === d.source.id
    && record.options.targetActors[f.targetRef]?.uuid === d.targetActor.uuid, "Authority reconstructed the wrong Documents");
  const intent = qa.envelopes.find(e => matchesQAIntent(e.envelope, f))?.envelope;
  check(intent?.payload.targetRefs?.length === 1 && intent.payload.targetRefs[0].tokenId === d.target.id
    && intent.payload.targetRefs[0].actorRef === d.targetActor.uuid, "Native target references did not reach the GM");
  const spatial = record.options.context?.spatial;
  check(spatial?.sourceFootprint?.fields?.length === 1 && spatial.targetFootprints?.length === 1
    && spatial.targetFootprints[0].footprint.fields.length === 1, "Missing reconstructed source/target footprints");
  const range = state.results.rangeResolution;
  check(range?.ok && range.checks?.length === 1 && range.checks[0].ok
    && range.checks[0].fields === 1 && range.checks[0].distance === 5, "Authoritative tactical reach check failed");
  check(record.options.attack?.statistic?.domain === "attack.weapon" && record.options.attack.modifierTotal === 4,
    "Authority did not derive the expected Actor statistic");
  check(state.rollRequests.length === 1 && state.rollResults.length === 1, "Expected exactly one attack RollRequest and result");
  const roll = state.rollResults[0].rollResult;
  verifyDigitalRoll(roll, qa.resolutionId);
  const routed = [...record.requestExpectations.values()];
  check(routed.length === 1 && routed[0].expectedUserId === f.playerId
    && routed[0].request.id === roll.requestId, "Attack request did not route to the chosen Player");
  check(qa.envelopes.some(e => e.envelope.messageType === MESSAGE.REQUEST_RESPONSE
    && e.envelope.senderUserId === f.playerId && e.envelope.requestId === roll.requestId), "Missing Player roll response");
  const attack = state.results.attackResolution;
  check(attack?.ok && attack.results.length === 1 && attack.results[0].hit === (qa.mode === "hit")
    && attack.results[0].defense.value === qa.before.ac, "Authoritative attack outcome/defense mismatch");
  const transaction = state.results.actionResult.steps.findLast(s => s.data?.transaction)?.data.transaction;
  check(record.options.persistencePort?.id === "foundry-v14-document-persistence"
    && state.results.actionResult.ok && transaction?.ok && state.completedStageIds.includes("action.commit"),
    "Expected a successful real Foundry transaction commit");
  verifyPersistence(qa.before, capture(f), qa.mode);
  qa.passed[qa.mode] = true;
  const report = qa.dump();
  qa[`${qa.mode}Dump`] = report;
  console.log(`PASS GM ${qa.mode}`, JSON.stringify(report, null, 2));
  return report;
}

export async function cleanupGM(runId) {
  requireRuntime("gm");
  check(typeof runId === "string" && runId.length > 0, "An exact QA runId is required");
  const qa = globalThis.wpActionRuntimeQA;
  check(!qa || qa.fixture.runId === runId, "Observer belongs to a different run");
  check(!qa?.failed && (!qa?.startedAt || qa.passed[qa.mode]),
    "Unproven or failed QA attempt; export both dumps and reload both clients before cleanup");
  // Never remove a Document under an Action that could still resume or commit.
  const records = [...game.wildpath.multiplayer.coordinator.records.values()]
    .filter(r => r.options?.actor?.getFlag?.("wildpath", QA_FLAG)?.runId === runId);
  check(records.every(r => ["completed", "failed", "cancelled"].includes(r.state?.status)),
    "Nonterminal QA Action remains; export both dumps and reload both clients before cleanup");
  qa?.detach();
  for (const scene of game.scenes) {
    const ids = [...scene.tokens].filter(t => marker(t)?.runId === runId).map(t => t.id);
    if (ids.length) await scene.deleteEmbeddedDocuments("Token", ids);
  }
  for (const actor of [...game.actors]) if (marker(actor)?.runId === runId) await actor.delete();
  if (qa) globalThis.wpActionRuntimeQAArchive = {hit: qa.hitDump, miss: qa.missDump, last: qa.lastDump};
  delete globalThis.wpActionRuntimeQA;
  delete globalThis.wpActionRuntimeQASetup;
  console.log("Removed only marked QA Documents", {runId});
}
