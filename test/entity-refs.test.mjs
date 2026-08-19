import {test} from "node:test";
import assert from "node:assert/strict";
import {
  actorRef,
  createEntityRef,
  entityRefId,
  isEntityRefString,
  normalizeEntityRef,
  parseEntityRef,
  requireEntityRefString,
  sameEntityRef,
  tokenRef,
  uuidRef
} from "../module/helpers/entity-refs.mjs";

test("entity refs encode document identity as opaque strings", () => {
  assert.equal(actorRef("actor-a"), "actor:actor-a");
  assert.equal(tokenRef("token-a", {sceneId: "scene-a"}), "token:scene-a.token-a");
  assert.equal(uuidRef("Actor.actor-a.Item.sword"), "uuid:Actor.actor-a.Item.sword");
  assert.equal(createEntityRef("Homebrew Thing", "id"), null);
});

test("entity refs parse kind, optional scope, and id", () => {
  const token = parseEntityRef("token:scene-a.token-a");
  const uuid = parseEntityRef("uuid:Actor.actor-a.Item.sword");

  assert.equal(token.ok, true);
  assert.equal(token.kind, "token");
  assert.equal(token.scope, "scene-a");
  assert.equal(token.id, "token-a");
  assert.equal(token.key, "scene-a.token-a");
  assert.equal(uuid.scope, null);
  assert.equal(uuid.id, "Actor.actor-a.Item.sword");
});

test("entity ref normalization accepts Foundry-shaped data only at the boundary", () => {
  const input = {
    actorId: "actor-a",
    tokenId: "token-a",
    sceneId: "scene-a",
    token: {id: "changed"}
  };

  assert.equal(normalizeEntityRef(input), "token:scene-a.token-a");
  assert.equal(normalizeEntityRef({actor: {id: "actor-b"}}), "actor:actor-b");
  assert.equal(normalizeEntityRef({uuid: "Actor.actor-c"}), "uuid:Actor.actor-c");
  assert.equal(input.token.id, "changed");
});

test("explicit ref strings are canonical and comparable", () => {
  assert.equal(normalizeEntityRef(" actor:actor-a "), "actor:actor-a");
  assert.equal(normalizeEntityRef({ref: "actor:actor-a", actorId: "other"}), "actor:actor-a");
  assert.equal(entityRefId("token:scene-a.token-a"), "token-a");
  assert.equal(sameEntityRef("actor:actor-a", {actorId: "actor-a"}), true);
  assert.equal(isEntityRefString("missing-kind"), false);
});

test("domain guards reject rich object references", () => {
  assert.equal(requireEntityRefString("actor:actor-a"), "actor:actor-a");
  assert.throws(
    () => requireEntityRefString({actorId: "actor-a"}, "source"),
    /source must be an opaque string reference/
  );
});
