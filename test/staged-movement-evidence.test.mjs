// Deterministic coverage for the Level-5 evidence wrapper. Real Foundry/browser export is manual.
import {test} from "node:test";
import assert from "node:assert/strict";
import {
  PRIVATE_TRANSPORT_MESSAGE_TYPES, STAGED_MOVEMENT_EVIDENCE_FILES, STAGED_MOVEMENT_SENTINELS, buildStagedMovementLevel5Evidence,
  projectEnvelopeForEvidence, sentinelForCase, summarizeTransportEvidence, transportEvidenceEntry
} from "../docs/development/staged-movement-qa-proof.mjs";

const SHA = "997a21b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9";
const STAMP = "2026-09-17T10:00:00.000Z";
const RESOLUTION = "qa-movement:run-1:abc";
const runtime = () => ({foundryVersion:"14.367", generation:14, build:367, systemId:"wildpath", systemVersion:"0.0.1"});

// Sentinel roles: ordinary = player mover with the GM as authority; reaction sentinels = GM mover with
// a player controlling the reactor, so the reaction prompt really crosses the targeted transport.
const roles = mode => mode === "ordinary" ? {moverUserId:"player", reactorUserId:"gm"} : {moverUserId:"gm", reactorUserId:"player"};

const entry = (direction, transport, messageType, senderUserId, recipientUserId, disclosure, extra={}) => ({
  direction, transport, messageType, messageId:`m:${messageType}:${direction}`, senderUserId, recipientUserId,
  recipientPolicy:recipientUserId ? null : "all", disclosure, resolutionId:RESOLUTION, requestId:messageType.includes("REQUEST") ? "req-1" : null,
  ...extra});

function gmTransport(mode) {
  const list = mode === "ordinary" ? [
    entry("incoming","broadcast","ACTION_INTENT","player","gm","BROADCAST_SAFE"),
    entry("outgoing","targeted","RESOLUTION_RESULT","gm","player","PARTICIPANT_PRIVATE"),
    entry("outgoing","broadcast","RESOLUTION_RESULT","gm",null,"BROADCAST_SAFE")
  ] : [
    entry("outgoing","local","ACTION_INTENT","gm","gm","BROADCAST_SAFE"),
    entry("outgoing","targeted","PENDING_REQUEST","gm","player","PARTICIPANT_PRIVATE"),
    entry("incoming","targeted","REQUEST_RESPONSE","player","gm","PARTICIPANT_PRIVATE"),
    entry("outgoing","broadcast","RESOLUTION_RESULT","gm",null,"BROADCAST_SAFE")
  ];
  return summarizeTransportEvidence(list);
}

function playerTransport(mode) {
  const list = mode === "ordinary" ? [
    entry("outgoing","broadcast","ACTION_INTENT","player","gm","BROADCAST_SAFE"),
    entry("incoming","targeted","RESOLUTION_RESULT","gm","player","PARTICIPANT_PRIVATE"),
    entry("incoming","broadcast","RESOLUTION_RESULT","gm",null,"BROADCAST_SAFE")
  ] : [
    entry("incoming","targeted","PENDING_REQUEST","gm","player","PARTICIPANT_PRIVATE"),
    entry("outgoing","targeted","REQUEST_RESPONSE","player","gm","PARTICIPANT_PRIVATE"),
    entry("incoming","broadcast","RESOLUTION_RESULT","gm",null,"BROADCAST_SAFE")
  ];
  return summarizeTransportEvidence(list);
}

function gmDump({mode="ordinary", variant="square", proofPassed=true, status="completed", pending=undefined, captureErrors=[], transport=undefined}={}) {
  const isReaction = mode !== "ordinary";
  return {
    runId:"run-1", role:"gm", mode, variant, resolutionId:RESOLUTION, ...roles(mode), authorityUserId:"gm",
    moverTokenId:"mover", reactorTokenId:"reactor", sceneId:"scene", origin:{x:0,y:50}, route:[{x:50,y:50},{x:100,y:50},{x:150,y:50}],
    before:{x:0,y:50,movement:30,hp:30,reaction:1,effects:[]}, proofPassed,
    after:{x:150,y:50,movement:15,hp:30,reaction:1,effects:[]},
    footprintProof:{pending:pending === undefined ? (isReaction ? {resolutionId:RESOLUTION, pendingChoice:true} : null) : pending,
      children:[], captureErrors, route:[], final:{topology:variant === "square" ? "square" : "hex"}},
    state:{status, errors:[], movement:{completedTransitionCount:3, intendedTransitionCount:3, stopped:false, committed:true},
      reactions:null, windows:[], transaction:{ok:true}},
    routing:[], history:[],
    envelopes:isReaction ? [
      {messageType:"PENDING_REQUEST", messageId:"m:PENDING_REQUEST:outgoing", disclosure:"PARTICIPANT_PRIVATE", resolutionId:RESOLUTION,
        payload:{request:{id:"req-1", type:"reaction-choice", payload:{candidates:[{id:"cand"}]}}}},
      {messageType:"RESOLUTION_RESULT", messageId:"m:RESOLUTION_RESULT:outgoing", disclosure:"BROADCAST_SAFE", resolutionId:RESOLUTION,
        payload:{result:{status:"completed", disclosure:"BROADCAST_SAFE"}}}
    ] : [],
    transport:transport === undefined ? gmTransport(mode) : transport,
    result:{resolutionId:RESOLUTION, status, ok:true, disclosure:"PARTICIPANT_PRIVATE", authorityUserId:"gm"}
  };
}

function playerDump({mode="ordinary", variant="square", result="completed", transport=undefined, disclosure=undefined}={}) {
  const base = {
    runId:"run-1", role:"player", mode, variant, resolutionId:RESOLUTION, ...roles(mode),
    moverTokenId:"mover", reactorTokenId:"reactor", sceneId:"scene", origin:{x:0,y:50}, route:[{x:50,y:50},{x:100,y:50},{x:150,y:50}],
    before:{x:0,y:50,movement:30,hp:30,reaction:1,effects:[]}, after:{x:150,y:50,movement:15,hp:30,reaction:1,effects:[]},
    notifications:[], transport:transport === undefined ? playerTransport(mode) : transport
  };
  const projection = disclosure ?? (mode === "ordinary" ? "PARTICIPANT_PRIVATE" : "BROADCAST_SAFE");
  if (result === "missing") return {...base, result:null};
  if (result === "other") return {...base, result:{resolutionId:"qa-movement:run-1:other", status:"completed", ok:true, disclosure:projection, authorityUserId:"gm"}};
  return {...base, result:{resolutionId:RESOLUTION, status:result, ok:result === "completed", disclosure:projection, authorityUserId:"gm"}};
}

const build = (overrides={}) => buildStagedMovementLevel5Evidence({
  role:"gm", evidence:gmDump(), gitSha:SHA, runtime:runtime(), capturedAt:STAMP, ...overrides
});

test("sentinel labels map only the three canonical mode/variant pairs", () => {
  assert.deepEqual(Object.keys(STAGED_MOVEMENT_SENTINELS), ["ordinary","decline","large-hex-decline"]);
  assert.equal(sentinelForCase("ordinary","square"), "ordinary");
  assert.equal(sentinelForCase("decline","square"), "decline");
  assert.equal(sentinelForCase("decline","large-hex-decline"), "large-hex-decline");
  for (const [mode, variant] of [["ordinary","large-hex-decline"],["miss","square"],["hit","square"],["stop","square"],["ordinary",undefined],["decline",null]]) {
    assert.equal(sentinelForCase(mode, variant), null, `${mode}/${variant}`);
  }
});

test("GM export rejects until the final proof has passed with a completed resolution", () => {
  assert.throws(() => build({evidence:gmDump({proofPassed:false})}), /passed final proof/);
  assert.throws(() => build({evidence:gmDump({status:"running"})}), /completed resolution/);
  assert.throws(() => build({evidence:gmDump({mode:"decline", pending:null})}), /pending proof/);
  assert.throws(() => build({evidence:gmDump({captureErrors:["observer failed"]})}), /capture errors/);
  assert.throws(() => build({evidence:{...gmDump(), role:"player"}}), /captured as player, not gm/);
  assert.equal(build().proofPassed, undefined, "wrapper does not duplicate proof flags outside the evidence object");
  assert.equal(build().evidence.proofPassed, true);
});

test("player export requires the terminal result for the same resolution", () => {
  const player = overrides => build({role:"player", evidence:playerDump(overrides)});
  assert.throws(() => player({result:"missing"}), /terminal result/);
  assert.throws(() => player({result:"other"}), /different resolution/);
  assert.throws(() => player({result:"running"}), /completed terminal result/);
  assert.throws(() => player({result:"failed"}), /completed terminal result/);
  assert.throws(() => player({disclosure:"everyone"}), /classified projection/);
  const object = player({});
  assert.equal(object.role, "player");
  assert.equal(object.evidence.result.status, "completed");
});

test("ordinary, decline and Large-hex decline each require their exact mode and variant", () => {
  assert.equal(build({evidence:gmDump({mode:"ordinary", variant:"square"})}).case, "ordinary");
  assert.equal(build({evidence:gmDump({mode:"decline", variant:"square"})}).case, "decline");
  assert.equal(build({evidence:gmDump({mode:"decline", variant:"large-hex-decline"})}).case, "large-hex-decline");
  assert.throws(() => build({evidence:gmDump({mode:"ordinary", variant:"large-hex-decline"})}), /not a Level-5 sentinel case/);
  assert.throws(() => build({evidence:gmDump({mode:"miss", variant:"square"})}), /not a Level-5 sentinel case/);
  assert.throws(() => build({evidence:gmDump({mode:"hit", variant:"square"})}), /not a Level-5 sentinel case/);
  assert.throws(() => build({evidence:gmDump({mode:"stop", variant:"square"})}), /not a Level-5 sentinel case/);
  // A requested label must agree with the prepared state instead of relabeling it.
  assert.throws(() => build({evidence:gmDump({mode:"decline", variant:"square"}), sentinel:"large-hex-decline"}), /does not match the prepared case/);
  assert.throws(() => build({evidence:gmDump({mode:"decline", variant:"large-hex-decline"}), sentinel:"decline"}), /does not match the prepared case/);
  assert.equal(build({evidence:gmDump({mode:"decline", variant:"large-hex-decline"}), sentinel:"large-hex-decline"}).case, "large-hex-decline");
});

test("wrapper carries schema, type, role, case, variant, Foundry, Git, timestamp, ids, file and evidence", () => {
  const object = build({evidence:gmDump({mode:"decline", variant:"large-hex-decline"})});
  assert.equal(object.schemaVersion, 2);
  assert.equal(object.evidenceType, "staged-movement-level5");
  assert.equal(object.role, "gm");
  assert.equal(object.case, "large-hex-decline");
  assert.equal(object.mode, "decline");
  assert.equal(object.variant, "large-hex-decline");
  assert.equal(object.foundryVersion, "14.367");
  assert.deepEqual(object.foundry, {generation:14, build:367});
  assert.equal(object.systemId, "wildpath");
  assert.equal(object.systemVersion, "0.0.1");
  assert.equal(object.gitSha, SHA);
  assert.equal(object.capturedAt, STAMP);
  assert.equal(object.runId, "run-1");
  assert.equal(object.resolutionId, RESOLUTION);
  assert.equal(object.evidenceFile, "evidence/gm-large-hex-decline.json");
  const expected = gmDump({mode:"decline", variant:"large-hex-decline"});
  assert.deepEqual({...object.evidence, envelopes:null}, {...expected, envelopes:null});
  assert.deepEqual(STAGED_MOVEMENT_EVIDENCE_FILES, {
    ordinary:{gm:"evidence/gm-movement-ordinary.json", player:"evidence/player-movement-ordinary.json"},
    decline:{gm:"evidence/gm-movement-decline.json", player:"evidence/player-movement-decline.json"},
    "large-hex-decline":{gm:"evidence/gm-large-hex-decline.json", player:"evidence/player-large-hex-decline.json"}
  });
  assert.equal(build({role:"player", evidence:playerDump({mode:"decline"})}).evidenceFile, "evidence/player-movement-decline.json");
});

test("the wrapper survives a JSON round trip and detaches from the source dump", () => {
  const dump = gmDump();
  const object = build({evidence:dump});
  assert.deepEqual(JSON.parse(JSON.stringify(object)), object);
  assert.notStrictEqual(object.evidence, dump);
  dump.after.movement = 0;
  assert.equal(object.evidence.after.movement, 15, "exported evidence must be a detached copy");
});

test("live Document instances, functions, Maps, Dates and cycles are rejected instead of serialized lossily", () => {
  class FakeActorDocument {constructor() {this.id = "actor"; this.system = {};}}
  const withRouting = value => ({...gmDump(), routing:[{expectedUserId:"gm", chooser:value}]});
  assert.throws(() => build({evidence:withRouting(new FakeActorDocument())}), /plain object \(found FakeActorDocument\)/);
  assert.throws(() => build({evidence:{...gmDump(), after:{...gmDump().after, snapshot:() => 1}}}), /JSON data, not function/);
  assert.throws(() => build({evidence:{...gmDump(), history:[new Map()]}}), /plain object \(found Map\)/);
  assert.throws(() => build({evidence:{...gmDump(), capturedAt:new Date()}}), /plain object \(found Date\)/);
  assert.throws(() => build({evidence:{...gmDump(), after:{...gmDump().after, nan:NaN}}}), /finite number/);
  assert.throws(() => build({evidence:{...gmDump(), after:{...gmDump().after, missing:undefined}}}), /JSON data, not undefined/);
  const circular = gmDump(); circular.history.push(circular);
  assert.throws(() => build({evidence:circular}), /circular/);
  assert.equal(build({evidence:withRouting({userId:"gm", policy:"target-controller"})}).evidence.routing[0].chooser.userId, "gm");
});

test("canonical evidence is never produced without an exact Git SHA or sound runtime metadata", () => {
  for (const gitSha of [undefined, null, "", "   ", "unknown", "HEAD", "997a21b?", 12345]) {
    assert.throws(() => build({gitSha}), /exact Git commit SHA/, String(gitSha));
  }
  assert.equal(build({gitSha:" 997A21B "}).gitSha, "997a21b", "abbreviated SHAs are accepted, trimmed and lower-cased");
  assert.throws(() => build({runtime:{...runtime(), foundryVersion:""}}), /foundryVersion/);
  assert.throws(() => build({runtime:{...runtime(), systemId:"dnd5e"}}), /wildpath system/);
  assert.throws(() => build({runtime:{...runtime(), build:"367"}}), /runtime.build must be an integer/);
  assert.throws(() => build({runtime:null}), /runtime metadata/);
  const minimal = build({runtime:{foundryVersion:"14.367", systemId:"wildpath"}});
  assert.deepEqual(minimal.foundry, {generation:null, build:null});
  assert.equal(minimal.systemVersion, null);
});

test("capturedAt is an ISO-8601 UTC timestamp, injected for tests or generated at export time", () => {
  assert.equal(build().capturedAt, STAMP);
  assert.throws(() => build({capturedAt:"2026-09-17"}), /ISO-8601/);
  assert.throws(() => build({capturedAt:"yesterday"}), /ISO-8601/);
  const generated = buildStagedMovementLevel5Evidence({role:"gm", evidence:gmDump(), gitSha:SHA, runtime:runtime()});
  assert.match(generated.capturedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(Math.abs(Date.parse(generated.capturedAt) - Date.now()) < 60_000);
});

/* -------------------------------------------- */
/*  Schema 2: transport / confidentiality evidence */
/* -------------------------------------------- */

test("transport entries and summaries never carry payloads and classify by transport", () => {
  const event = {direction:"sending", transport:"targeted", recipientUserId:"player", attestedSenderUserId:null,
    envelope:{messageType:"PENDING_REQUEST", messageId:"m1", senderUserId:"gm", recipientUserId:"player", disclosure:"PARTICIPANT_PRIVATE",
      resolutionId:RESOLUTION, requestId:"req-1", payload:{request:{secret:true}}}};
  const normalized = transportEvidenceEntry(event);
  assert.equal(normalized.direction, "outgoing");
  assert.equal(normalized.payload, undefined);
  assert.equal(normalized.transport, "targeted");
  const summary = summarizeTransportEvidence([normalized,
    transportEvidenceEntry({direction:"incoming", transport:"broadcast", envelope:{messageType:"ACTION_INTENT", messageId:"m2", senderUserId:"player",
      recipientUserId:"gm", disclosure:"BROADCAST_SAFE", resolutionId:RESOLUTION, payload:{}}}),
    transportEvidenceEntry({direction:"refused", transport:null, code:"UNCLASSIFIED_DISCLOSURE", envelope:{messageType:"RESOLUTION_RESULT", messageId:"m3",
      senderUserId:"gm", resolutionId:RESOLUTION, payload:{}}}),
    transportEvidenceEntry({direction:"outgoing", transport:"targeted", envelope:{messageType:"PENDING_REQUEST", messageId:"m1"}})]);
  assert.deepEqual(summary.broadcastMessageTypes, ["ACTION_INTENT"]);
  assert.equal(summary.targeted.length, 2);
  assert.equal(summary.targeted[0].recipientUserId, "player");
  assert.deepEqual(summary.local, []);
  assert.deepEqual(summary.refused.map(e => e.code), ["UNCLASSIFIED_DISCLOSURE"]);
  assert.equal(JSON.stringify(summary).includes("secret"), false);
  assert.deepEqual(PRIVATE_TRANSPORT_MESSAGE_TYPES, ["PENDING_REQUEST","REQUEST_RESPONSE","RESOLUTION_CANCEL","RESOLUTION_ERROR",
    "MOVEMENT_APPROVAL","MOVEMENT_RESULT","MOVEMENT_CONTINUATION"]);
});

test("exported envelopes keep public payloads and omit private ones", () => {
  const object = build({evidence:gmDump({mode:"decline"})});
  const [request, result] = object.evidence.envelopes;
  assert.deepEqual(request.payload, {omitted:true, disclosure:"PARTICIPANT_PRIVATE", keys:["request"]});
  assert.equal(JSON.stringify(object).includes("cand"), false, "private request contents never enter evidence");
  assert.deepEqual(result.payload, {result:{status:"completed", disclosure:"BROADCAST_SAFE"}});
  assert.deepEqual(projectEnvelopeForEvidence({disclosure:null, payload:{a:1, b:2}}).payload, {omitted:true, disclosure:null, keys:["a","b"]});
  assert.equal(projectEnvelopeForEvidence(null), null);
});

test("evidence refuses private message types on the broadcast bus, refused sends, and missing transport data", () => {
  const leaked = {...gmTransport("decline"), broadcastMessageTypes:["PENDING_REQUEST","RESOLUTION_RESULT"]};
  assert.throws(() => build({evidence:gmDump({mode:"decline", transport:leaked})}), /Private message types crossed the broadcast bus: PENDING_REQUEST/);
  const unsafe = gmTransport("ordinary"); unsafe.broadcast[1].disclosure = "PARTICIPANT_PRIVATE";
  assert.throws(() => build({evidence:gmDump({transport:unsafe})}), /must be classified BROADCAST_SAFE/);
  const refused = {...gmTransport("ordinary"), refused:[{messageType:"PENDING_REQUEST", code:"UNCLASSIFIED_DISCLOSURE"}]};
  assert.throws(() => build({evidence:gmDump({transport:refused})}), /refused 1 envelope/);
  assert.throws(() => build({evidence:gmDump({transport:null})}), /transport summary/);
  const noResult = {...gmTransport("ordinary"), broadcastMessageTypes:["ACTION_INTENT"]};
  assert.throws(() => build({evidence:gmDump({transport:noResult})}), /public RESOLUTION_RESULT projection/);
  assert.throws(() => build({evidence:{...gmDump(), authorityUserId:null}}), /authority user/);
});

test("the ordinary sentinel proves the participant projection reached the player mover on the targeted transport", () => {
  assert.equal(build().case, "ordinary");
  const noTargetedResult = {...gmTransport("ordinary"), targeted:[]};
  assert.throws(() => build({evidence:gmDump({transport:noTargetedResult})}), /participant RESOLUTION_RESULT projection sent to the mover/);
  assert.throws(() => build({evidence:{...gmDump(), moverUserId:"gm", reactorUserId:"player"}}), /player mover with the GM as authority/);
  const player = overrides => build({role:"player", evidence:playerDump(overrides)});
  assert.equal(player({}).evidence.result.disclosure, "PARTICIPANT_PRIVATE");
  assert.throws(() => player({disclosure:"BROADCAST_SAFE"}), /must hold the PARTICIPANT_PRIVATE projection/);
  assert.throws(() => player({transport:{...playerTransport("ordinary"), targeted:[]}}), /arriving on the targeted transport/);
});

test("reaction sentinels require a remote chooser and prove the targeted request/response exchange on both roles", () => {
  assert.equal(build({evidence:gmDump({mode:"decline"})}).case, "decline");
  assert.throws(() => build({evidence:{...gmDump({mode:"decline"}), moverUserId:"player", reactorUserId:"gm"}}), /remote chooser/);
  const noRequest = {...gmTransport("decline"), targeted:gmTransport("decline").targeted.filter(e => e.messageType !== "PENDING_REQUEST")};
  assert.throws(() => build({evidence:gmDump({mode:"decline", transport:noRequest})}), /PENDING_REQUEST sent to the reactor controller/);
  const noAnswer = {...gmTransport("decline"), targeted:gmTransport("decline").targeted.filter(e => e.messageType !== "REQUEST_RESPONSE")};
  assert.throws(() => build({evidence:gmDump({mode:"decline", transport:noAnswer})}), /REQUEST_RESPONSE arriving on the targeted transport/);
  const intentOnBus = {...gmTransport("decline"), local:[], broadcastMessageTypes:["ACTION_INTENT","RESOLUTION_RESULT"]};
  assert.throws(() => build({evidence:gmDump({mode:"decline", transport:intentOnBus})}), /GM-initiated intent must be delivered locally/);
  const player = overrides => build({role:"player", evidence:playerDump({mode:"decline", ...overrides})});
  assert.equal(player({}).evidence.result.disclosure, "BROADCAST_SAFE");
  assert.throws(() => player({transport:{...playerTransport("decline"), targeted:[]}}), /PENDING_REQUEST arriving on the targeted transport/);
  const noResponse = {...playerTransport("decline"), targeted:playerTransport("decline").targeted.filter(e => e.messageType !== "REQUEST_RESPONSE")};
  assert.throws(() => player({transport:noResponse}), /REQUEST_RESPONSE sent to the authority/);
});
