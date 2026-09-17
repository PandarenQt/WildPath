// Deterministic coverage for the Level-5 evidence wrapper. Real Foundry/browser export is manual.
import {test} from "node:test";
import assert from "node:assert/strict";
import {
  STAGED_MOVEMENT_EVIDENCE_FILES, STAGED_MOVEMENT_SENTINELS, buildStagedMovementLevel5Evidence, sentinelForCase
} from "../docs/development/staged-movement-qa-proof.mjs";

const SHA = "997a21b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9";
const STAMP = "2026-09-17T10:00:00.000Z";
const runtime = () => ({foundryVersion:"14.367", generation:14, build:367, systemId:"wildpath", systemVersion:"0.0.1"});

function gmDump({mode="ordinary", variant="square", proofPassed=true, status="completed", pending=undefined, captureErrors=[]}={}) {
  const isReaction = mode !== "ordinary";
  return {
    runId:"run-1", role:"gm", mode, variant, resolutionId:"qa-movement:run-1:abc", moverUserId:"player", reactorUserId:"gm",
    moverTokenId:"mover", reactorTokenId:"reactor", sceneId:"scene", origin:{x:0,y:50}, route:[{x:50,y:50},{x:100,y:50},{x:150,y:50}],
    before:{x:0,y:50,movement:30,hp:30,reaction:1,effects:[]}, proofPassed,
    after:{x:150,y:50,movement:15,hp:30,reaction:1,effects:[]},
    footprintProof:{pending:pending === undefined ? (isReaction ? {resolutionId:"qa-movement:run-1:abc", pendingChoice:true} : null) : pending,
      children:[], captureErrors, route:[], final:{topology:variant === "square" ? "square" : "hex"}},
    state:{status, errors:[], movement:{completedTransitionCount:3, intendedTransitionCount:3, stopped:false, committed:true},
      reactions:null, windows:[], transaction:{ok:true}},
    routing:[], history:[], envelopes:[], result:{resolutionId:"qa-movement:run-1:abc", status, ok:true}
  };
}

function playerDump({mode="ordinary", variant="square", result="completed"}={}) {
  const base = {
    runId:"run-1", role:"player", mode, variant, resolutionId:"qa-movement:run-1:abc", moverUserId:"player", reactorUserId:"gm",
    moverTokenId:"mover", reactorTokenId:"reactor", sceneId:"scene", origin:{x:0,y:50}, route:[{x:50,y:50},{x:100,y:50},{x:150,y:50}],
    before:{x:0,y:50,movement:30,hp:30,reaction:1,effects:[]}, after:{x:150,y:50,movement:15,hp:30,reaction:1,effects:[]},
    notifications:[]
  };
  if (result === "missing") return {...base, result:null};
  if (result === "other") return {...base, result:{resolutionId:"qa-movement:run-1:other", status:"completed", ok:true}};
  return {...base, result:{resolutionId:"qa-movement:run-1:abc", status:result, ok:result === "completed"}};
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
  assert.equal(object.schemaVersion, 1);
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
  assert.equal(object.resolutionId, "qa-movement:run-1:abc");
  assert.equal(object.evidenceFile, "evidence/gm-large-hex-decline.json");
  assert.deepEqual(object.evidence, gmDump({mode:"decline", variant:"large-hex-decline"}));
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
