// Level-5 representative Action gate (CODEX §28: one of each mechanic, live, before volume).
// The GM sets up one case at a time on the viewed Scene; the initiating client targets natively and calls
// the real Item.use(); each client exports its own evidence. Procedure: representative-live-qa.md.
export const REP_FLAG = "representativeQA";

export const REPRESENTATIVE_ATTACK_MODIFIER = Object.freeze({id:"rep-attack",selector:"attack.weapon",
  domains:["attack.weapon"],label:"Representative attack modifier",type:"untyped",value:4,enabled:true});

const cost = capability => ({allOf:[{capability,amount:1}]});
const single = {type:"single",required:true,count:1};
const reach = {type:"reach",distance:{value:5,unit:"ft"}};
const noCriticals = {naturalCriticalHits:false,naturalCriticalMisses:false};

export const REPRESENTATIVE_DEFINITIONS = Object.freeze({
  meleeDice: () => ({schemaVersion:1,id:"action:rep-melee-dice",label:"Representative melee",costs:cost("action"),
    targeting:single,range:reach,attack:{type:"melee",statistic:"weapon",defenseKey:"ac",policy:noCriticals},
    damage:[{id:"blade",expression:{type:"dice",number:1,faces:8},damageType:"slashing",provenance:"weapon-base"}]}),
  ranged: () => ({schemaVersion:1,id:"action:rep-ranged",label:"Representative ranged",costs:cost("action"),
    targeting:single,range:{type:"ranged",normal:{value:80,unit:"ft"},long:{value:320,unit:"ft"}},
    attack:{type:"ranged",statistic:"weapon",defenseKey:"ac",policy:noCriticals},
    damage:[{id:"shot",expression:{type:"constant",value:5},damageType:"piercing",provenance:"weapon-base"}]}),
  bonusStrike: () => ({schemaVersion:1,id:"action:rep-bonus",label:"Representative bonus strike",
    costs:cost("bonus-action"),targeting:single,range:reach,
    attack:{type:"melee",statistic:"weapon",defenseKey:"ac",policy:noCriticals},
    damage:[{id:"jab",expression:{type:"constant",value:3},damageType:"bludgeoning",provenance:"weapon-base"}]}),
  trip: () => ({schemaVersion:1,id:"action:rep-trip",label:"Representative trip",costs:cost("action"),
    targeting:single,range:reach,attack:{type:"melee",statistic:"weapon",defenseKey:"ac",policy:noCriticals},
    effects:[{id:"trip-prone",type:"condition",conditionId:"prone"}]}),
  saveForHalf: dc => ({schemaVersion:1,id:"action:rep-save-half",label:"Representative save for half",
    costs:cost("action"),targeting:single,range:reach,save:{ability:"fortitude",dc:{value:dc}},
    damage:[{id:"venom",expression:{type:"dice",number:2,faces:6},damageType:"poison",provenance:"spell-base",
      saveOutcomePolicy:{success:"half",failure:"full"}}],
    effects:[{id:"venom-poisoned",type:"condition",conditionId:"poisoned",saveOutcomePolicy:"failure"}]}),
  healing: () => ({schemaVersion:1,id:"action:rep-healing",label:"Representative healing",costs:cost("action"),
    targeting:single,range:reach,healing:[{id:"mend",expression:{type:"constant",value:8},healingType:"healing"}]}),
  scaling: () => ({schemaVersion:1,id:"action:rep-scaling",label:"Representative scaling",tags:["spell"],
    costs:{allOf:[]},targeting:single,range:reach,
    damage:[{id:"bolt",expression:{type:"dice",number:2,faces:6},damageType:"fire",provenance:"spell-base"}],
    configuration:[{id:"casting-resource",type:"resource",label:"Cast At",required:true,
      cost:{anyOf:[[{capability:"spell-slot.1",amount:1}],[{capability:"spell-slot.2",amount:1}]]},
      levelByResourceId:{"spell-slot.1":1,"spell-slot.2":2},
      effects:[{type:"scaleDamage",componentIds:["bolt"],levelChoiceId:"casting-resource",baseLevel:1,
        dice:{number:1,faces:6}}]}]})
});

export const SPELL_SLOT_POOLS = Object.freeze([
  {id:"spell-slot.1",label:"Slot 1",base:1,value:1},
  {id:"spell-slot.2",label:"Slot 2",base:1,value:1}
]);

/**
 * The two-browser cases: what one client cannot prove. `initiator` uses the Action; `targetOwner` owns the
 * target, so a target-controller roll is routed to that user.
 */
export const REPRESENTATIVE_CASES = Object.freeze({
  "melee-dice": {initiator:"player",targetOwner:"gm",ac:1,definition:REPRESENTATIVE_DEFINITIONS.meleeDice},
  trip: {initiator:"player",targetOwner:"gm",ac:1,definition:REPRESENTATIVE_DEFINITIONS.trip},
  "save-routed": {initiator:"gm",targetOwner:"player",definition:() => REPRESENTATIVE_DEFINITIONS.saveForHalf(100)},
  healing: {initiator:"player",targetOwner:"player",targetHealth:10,definition:REPRESENTATIVE_DEFINITIONS.healing},
  configuration: {initiator:"player",targetOwner:"gm",pools:SPELL_SLOT_POOLS,definition:REPRESENTATIVE_DEFINITIONS.scaling}
});

const check = (condition, message) => { if (!condition) throw new Error(`REPRESENTATIVE QA: ${message}`); };
const flags = data => ({wildpath:{[REP_FLAG]:data}});
const marked = document => document.getFlag?.("wildpath", REP_FLAG) ?? null;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function snapshot(fixture) {
  const tokens = canvas.scene.tokens;
  const source = tokens.get(fixture.sourceTokenId)?.actor;
  const target = tokens.get(fixture.targetTokenId)?.actor;
  return {
    source:{action:source?.system.resources.action.value, bonus:source?.system.resources.bonus.value,
      pools:Object.fromEntries((source?.system.pools ?? []).map(pool => [pool.id, pool.value]))},
    target:{hp:target?.system.resources.health.value,
      conditions:(target?.effects ?? []).filter(effect => effect.type === "condition").map(effect => effect.system.type)}
  };
}

/** GM: create the case's Actors, Tokens and embedded Action on the viewed Scene. */
export async function setupRepresentativeCase(caseId, playerId) {
  check(game.user.isGM, "Run setup on the GM.");
  const spec = REPRESENTATIVE_CASES[caseId];
  check(spec, `Unknown case ${caseId}.`);
  check(game.users.get(playerId)?.active && !game.users.get(playerId).isGM, "The Player must be active.");
  check(game.release.build === 369, "Foundry must be 14.369.");
  const runId = foundry.utils.randomID();
  const owned = owner => owner === "player" ? {default:0,[playerId]:3} : {default:0};
  const fixture = {caseId, runId, playerId, gmId:game.user.id, sceneId:canvas.scene.id,
    initiatorUserId:spec.initiator === "player" ? playerId : game.user.id};
  const actors = {};
  for (const [role, owner, system] of [
    ["source", spec.initiator, {resources:{action:{base:1,value:1},bonus:{base:1,value:1}},
      ...(spec.pools ? {pools:structuredClone(spec.pools)} : {})}],
    ["target", spec.targetOwner, {resources:{health:{base:30,value:spec.targetHealth ?? 30}}}]
  ]) {
    actors[role] = await CONFIG.Actor.documentClass.create({name:`Rep ${caseId} ${role}`, type:"character",
      ownership:owned(owner), flags:flags({...fixture, role}), system}, {renderSheet:false});
  }
  const size = canvas.scene.grid.size;
  for (const [role, column] of [["source", 2], ["target", 3]]) {
    const token = await actors[role].getTokenDocument({x:column * size, y:2 * size, actorLink:false,
      name:`Rep ${role}`, flags:flags({...fixture, role})});
    const [created] = await canvas.scene.createEmbeddedDocuments("Token", [token.toObject()]);
    fixture[`${role}TokenId`] = created.id;
  }
  const target = canvas.scene.tokens.get(fixture.targetTokenId).actor;
  if (spec.ac !== undefined) await target.update({"system.defenses.ac.value":spec.ac});
  const source = canvas.scene.tokens.get(fixture.sourceTokenId).actor;
  const [action] = await source.createEmbeddedDocuments("Item", [{name:`Rep ${caseId}`, type:"action",
    flags:flags({...fixture, role:"action"}),
    system:{active:true, modifiers:[structuredClone(REPRESENTATIVE_ATTACK_MODIFIER)], definition:spec.definition()}}]);
  fixture.actionId = action.id;
  fixture.before = snapshot(fixture);
  globalThis.wpRepQA = {role:"gm", fixture};
  return fixture;
}

/** Initiator: target natively and call the real Item.use(); returns the declared resolution ID. */
export async function useRepresentativeCase(fixture) {
  check(game.user.id === fixture.initiatorUserId, "Run use() on the initiating client.");
  const target = canvas.tokens.get(fixture.targetTokenId);
  check(target, "The target Token must be on the viewed Scene.");
  target.setTarget(true, {releaseOthers:true});
  check(game.user.targets.size === 1 && game.user.targets.has(target), "Exactly the case target must be targeted.");
  let resolutionId = null;
  const stop = game.wildpath.multiplayer.transport.observe(event => {
    if (event.direction === "sending" && event.envelope.messageType === "ACTION_INTENT") resolutionId ??= event.envelope.resolutionId;
  });
  try {
    const action = canvas.scene.tokens.get(fixture.sourceTokenId).actor.items.get(fixture.actionId);
    const declared = await action.use();
    check(declared === true, "Item.use() must declare.");
  } finally { stop(); }
  check(resolutionId, "The ACTION_INTENT resolution ID was not observed.");
  globalThis.wpRepQA = {...(globalThis.wpRepQA ?? {}), resolutionId};
  return resolutionId;
}

/** Any client: wait for this client's view of the result and card. */
export async function awaitRepresentativeResult(resolutionId, {timeoutMs=20000}={}) {
  const coordinator = game.wildpath.multiplayer.coordinator;
  const card = () => game.messages.find(message => message.getFlag("wildpath", "resolutionId") === resolutionId);
  for (let waited = 0; waited < timeoutMs && !(coordinator.getResult(resolutionId) && card()); waited += 100) await sleep(100);
  return {result:coordinator.getResult(resolutionId), card:card() ?? null};
}

/** GM: authoritative evidence and the case-specific proof. */
export async function exportRepresentativeGM({fixture, resolutionId, gitSha}) {
  check(typeof gitSha === "string" && /^[0-9a-f]{7,40}$/i.test(gitSha), "gitSha of the served build is required.");
  const {card} = await awaitRepresentativeResult(resolutionId);
  const record = game.wildpath.multiplayer.coordinator.getRecord(resolutionId);
  check(record, "No authoritative record for this resolution.");
  const state = record.state;
  const after = snapshot(fixture);
  const evidence = {
    schema:1, role:"gm", caseId:fixture.caseId, runId:fixture.runId, gitSha:gitSha.toLowerCase(),
    capturedAt:new Date().toISOString(), runtime:{foundryVersion:game.version, build:game.release.build,
      systemId:game.system.id, systemVersion:game.system.version},
    users:{gmId:fixture.gmId, playerId:fixture.playerId, initiatorUserId:record.initiatorUserId,
      authorityUserId:record.authorityUserId},
    resolutionId, status:state.status,
    routing:[...record.requestExpectations.values()].map(entry => ({type:entry.request?.type,
      rollType:entry.request?.payload?.rollRequest?.type ?? null, expectedUserId:entry.expectedUserId})),
    rolls:(state.rollResults ?? []).map(entry => ({type:entry.type ?? entry.semanticType,
      provider:entry.rollResult?.provenance?.providerId ?? null, method:entry.rollResult?.provenance?.method ?? null,
      natural:entry.rollResult?.natural ?? null, total:entry.rollResult?.total ?? null,
      dice:(entry.rollResult?.dice ?? []).reduce((count, die) => count + (die.results?.length ?? 1), 0)})),
    outcomes:{attack:state.results?.attackResolution?.results?.map(entry => ({hit:entry.hit, defense:entry.defense?.value})) ?? null,
      save:state.results?.saveResolution?.results?.map(entry => ({success:entry.success, outcome:entry.outcome})) ?? null},
    configuration:state.configuration ? {choices:state.configuration.choices ?? null,
      selectedPaymentOptionId:state.configuration.selectedPaymentOptionId ?? null} : null,
    before:fixture.before, after,
    card:card ? {author:card.author?.id, whisper:[...card.whisper], blind:card.blind, rolls:card.rolls.length,
      outcomeKeys:card.content.match(/class="outcome[^>]*>[^<]*/g)?.length ?? 0} : null
  };
  evidence.proof = proveRepresentativeCase(evidence);
  return evidence;
}

/** Initiator / other client: what this client received. */
export async function exportRepresentativeClient({fixture, resolutionId, gitSha}) {
  const {result, card} = await awaitRepresentativeResult(resolutionId);
  return {
    schema:1, role:game.user.isGM ? "gm-client" : "player", caseId:fixture.caseId, runId:fixture.runId,
    gitSha:gitSha.toLowerCase(), capturedAt:new Date().toISOString(), userId:game.user.id, resolutionId,
    result:result ? {status:result.status, keys:Object.keys(result).sort(), disclosure:result.disclosure,
      rolls:(result.rolls ?? []).map(entry => ({type:entry.type, visibility:entry.visibility,
        total:entry.rollResult?.total ?? entry.total ?? null}))} : null,
    card:card ? {visible:card.visible, isContentVisible:card.isContentVisible, rolls:card.rolls.length} : null
  };
}

function proveRepresentativeCase(evidence) {
  const failures = [];
  const expect = (condition, message) => { if (!condition) failures.push(message); };
  const {before, after, routing, rolls, users} = evidence;
  const routedTo = kind => routing.filter(entry => (entry.rollType ?? entry.type)?.includes(kind)).map(entry => entry.expectedUserId);
  const roll = kind => rolls.find(entry => entry.type?.includes(kind));
  expect(evidence.status === "completed", `status ${evidence.status}`);
  expect(evidence.card?.author === users.initiatorUserId, "one card authored by the initiator");
  for (const entry of rolls) expect(entry.provider === "foundry-digital", `${entry.type} provider ${entry.provider}`);
  switch (evidence.caseId) {
    case "melee-dice":
      expect(routedTo("attack").every(id => id === users.playerId) && routedTo("attack").length === 1, "attack roll routed to the Player");
      expect(routedTo("damage").every(id => id === users.playerId) && routedTo("damage").length === 1, "damage roll routed to the Player");
      expect(after.target.hp === before.target.hp - (roll("damage")?.total ?? NaN), "HP drops by the rolled damage");
      expect(after.source.action === before.source.action - 1, "the Action is paid");
      break;
    case "trip":
      expect(after.target.conditions.includes("prone"), "Prone applied on the hit");
      expect(after.target.hp === before.target.hp, "a trip deals no damage");
      break;
    case "save-routed":
      expect(routedTo("sav").length === 1 && routedTo("sav")[0] === users.playerId, "the save is routed to the target's Player");
      expect(evidence.outcomes.save?.[0]?.success === false, "DC 100 fails");
      expect(after.target.hp === before.target.hp - (roll("damage")?.total ?? NaN), "a failed save takes full damage");
      expect(after.target.conditions.includes("poisoned"), "Poisoned on a failed save");
      break;
    case "healing":
      expect(after.target.hp === before.target.hp + 8, "healing restores 8");
      break;
    case "configuration":
      expect(routing.some(entry => entry.type === "action-configuration" && entry.expectedUserId === users.playerId),
        "the configuration prompt is routed to the Player");
      expect(roll("damage")?.dice === 3, "slot 2 scales 2d6 to three dice");
      expect(after.source.pools["spell-slot.2"] === 0 && after.source.pools["spell-slot.1"] === 1, "slot 2 is spent, slot 1 kept");
      expect(after.target.hp === before.target.hp - (roll("damage")?.total ?? NaN), "HP drops by the scaled damage");
      break;
  }
  return {passed:failures.length === 0, failures};
}

/** GM: delete only this gate's marked Tokens, Actors and cards. */
export async function cleanupRepresentative({resolutionIds=[]}={}) {
  check(game.user.isGM, "Run cleanup on the GM.");
  const tokens = canvas.scene.tokens.filter(token => marked(token)).map(token => token.id);
  if (tokens.length) await canvas.scene.deleteEmbeddedDocuments("Token", tokens);
  const actors = game.actors.filter(actor => marked(actor)).map(actor => actor.id);
  if (actors.length) await CONFIG.Actor.documentClass.deleteDocuments(actors);
  const cards = game.messages.filter(message => resolutionIds.includes(message.getFlag("wildpath", "resolutionId"))).map(m => m.id);
  if (cards.length) await ChatMessage.deleteDocuments(cards);
  return {tokens:tokens.length, actors:actors.length, cards:cards.length};
}
