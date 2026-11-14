import {test} from "node:test";
import assert from "node:assert/strict";
import {sameTargetRefs, targetLookupRefs} from "../module/helpers/target-actor-refs.mjs";

test("sameTargetRefs tells unlinked Tokens of one Actor apart, and falls back to any shared ref without a Token on both sides", () => {
  const a = targetLookupRefs({id: "actor-ogre", actorId: "actor-ogre", tokenId: "token-a"});
  const b = targetLookupRefs({id: "actor-ogre", actorId: "actor-ogre", tokenId: "token-b", sceneId: "scene"});
  assert.equal(sameTargetRefs(a, b), false, "two Tokens share the Actor's refs, not their own");
  assert.equal(sameTargetRefs(a, targetLookupRefs({tokenId: "token-a", sceneId: "scene"})), true, "one Token with or without its Scene");
  const linked = targetLookupRefs({id: "actor-hero", actorId: "actor-hero"});
  assert.equal(sameTargetRefs(linked, targetLookupRefs({actorId: "actor-hero", tokenId: "token-hero"})), true, "a Token-less ref finds its Actor's Token");
  assert.equal(sameTargetRefs(["actor:actor-ogre"], b), true, "a list written with actor refs only still matches");
  assert.equal(sameTargetRefs(linked, a), false);
  const candidate = targetLookupRefs({id: "a", target: {actorId: "actor-ogre", tokenId: "token-a"}, actor: {id: "actor-ogre"}});
  assert.equal(sameTargetRefs(candidate, b), false, "a candidate keeps its wrapped target's Token");
});
