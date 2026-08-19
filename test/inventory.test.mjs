import {test} from "node:test";
import assert from "node:assert/strict";
import {
  INVENTORY_CODES,
  INVENTORY_OPERATIONS,
  INVENTORY_WEIGHT_POLICY,
  createInventoryDebugSnapshot,
  calculateInventoryWeights,
  calculateSpaceInternalWeight,
  commitInventoryTransfer,
  createInventoryState,
  getAccessibleInventorySpaces,
  inventorySpaceContents,
  planInventoryTransfer,
  wouldCreateContainmentCycle
} from "../module/helpers/inventory.mjs";
import {createInMemoryInventoryRepository} from "../module/helpers/inventory-repository.mjs";

const actorA = {type: "actor", id: "actor-a"};
const actorB = {type: "actor", id: "actor-b"};

function baseState(extra={}) {
  return createInventoryState({
    spaces: [
      {id: "a.personal", label: "A Personal", host: actorA, weightPolicy: INVENTORY_WEIGHT_POLICY.TRACK_AND_PROPAGATE},
      {id: "b.personal", label: "B Personal", host: actorB, weightPolicy: INVENTORY_WEIGHT_POLICY.TRACK_AND_PROPAGATE},
      ...(extra.spaces ?? [])
    ],
    items: extra.items ?? [],
    accessGrants: extra.accessGrants ?? []
  });
}

test("actor can access default personal inventory space", () => {
  const state = baseState();
  const access = getAccessibleInventorySpaces(actorA, state);
  assert.equal(access.some(entry => entry.space.id === "a.personal"), true);
  assert.equal(access.find(entry => entry.space.id === "a.personal").operations.includes(INVENTORY_OPERATIONS.WITHDRAW), true);
});

test("item grants access to a linked space while carried", () => {
  const state = baseState({
    spaces: [{id: "bag.space", label: "Bag", host: {type: "item", id: "bag"}, weightPolicy: INVENTORY_WEIGHT_POLICY.TRACK_BUT_IGNORE_FOR_CARRIER}],
    items: [{
      id: "bag",
      label: "Bag",
      spaceId: "a.personal",
      weight: 2,
      accessGrants: [{
        spaceId: "bag.space",
        granteePolicy: "holder",
        operations: [INVENTORY_OPERATIONS.VIEW, INVENTORY_OPERATIONS.DEPOSIT, INVENTORY_OPERATIONS.WITHDRAW]
      }]
    }]
  });
  const access = getAccessibleInventorySpaces(actorA, state);
  assert.equal(access.some(entry => entry.space.id === "bag.space"), true);
});

test("item-granted access disappears when the item is removed, but space contents remain", () => {
  const state = baseState({
    spaces: [
      {id: "bag.space", host: {type: "item", id: "bag"}, weightPolicy: INVENTORY_WEIGHT_POLICY.TRACK_BUT_IGNORE_FOR_CARRIER},
      {id: "lost", host: {type: "world", id: "lost"}, weightPolicy: INVENTORY_WEIGHT_POLICY.TRACK_INDEPENDENTLY}
    ],
    items: [
      {
        id: "bag",
        spaceId: "lost",
        accessGrants: [{spaceId: "bag.space", granteePolicy: "holder", operations: [INVENTORY_OPERATIONS.VIEW]}]
      },
      {id: "gem", label: "Gem", spaceId: "bag.space", weight: 1}
    ]
  });
  const access = getAccessibleInventorySpaces(actorA, state);
  assert.equal(access.some(entry => entry.space.id === "bag.space"), false);
  assert.equal(inventorySpaceContents(state, "bag.space").length, 1);
});

test("access-granting item transfer moves access from Actor A to Actor B", () => {
  const state = baseState({
    spaces: [{id: "bag.space", host: {type: "item", id: "bag"}, weightPolicy: INVENTORY_WEIGHT_POLICY.TRACK_INDEPENDENTLY}],
    items: [{
      id: "bag",
      spaceId: "a.personal",
      accessGrants: [{spaceId: "bag.space", granteePolicy: "holder", operations: [INVENTORY_OPERATIONS.VIEW]}]
    }]
  });
  const plan = planInventoryTransfer({
    state,
    itemId: "bag",
    sourceSpaceId: "a.personal",
    destinationSpaceId: "b.personal",
    actorRef: actorA,
    ignoreAccess: true
  });
  const moved = commitInventoryTransfer(state, plan).state;

  assert.equal(getAccessibleInventorySpaces(actorA, moved).some(entry => entry.space.id === "bag.space"), false);
  assert.equal(getAccessibleInventorySpaces(actorB, moved).some(entry => entry.space.id === "bag.space"), true);
});

test("shared space is one authoritative storage space for multiple actors", () => {
  const state = baseState({
    spaces: [{id: "party.chest", label: "Party Chest", host: {type: "party", id: "main"}, weightPolicy: INVENTORY_WEIGHT_POLICY.TRACK_INDEPENDENTLY}],
    items: [{id: "coin", label: "Coin", quantity: 10, spaceId: "party.chest"}],
    accessGrants: [
      {spaceId: "party.chest", grantee: actorA, operations: [INVENTORY_OPERATIONS.VIEW]},
      {spaceId: "party.chest", grantee: actorB, operations: [INVENTORY_OPERATIONS.VIEW]}
    ]
  });

  assert.equal(getAccessibleInventorySpaces(actorA, state).find(e => e.space.id === "party.chest").space.id, "party.chest");
  assert.equal(getAccessibleInventorySpaces(actorB, state).find(e => e.space.id === "party.chest").space.id, "party.chest");
  assert.equal(inventorySpaceContents(state, "party.chest")[0].quantity, 10);
});

test("two storage item instances can link separate private spaces", () => {
  const state = baseState({
    spaces: [
      {id: "bag-a.space", host: {type: "item", id: "bag-a"}, weightPolicy: INVENTORY_WEIGHT_POLICY.TRACK_INDEPENDENTLY},
      {id: "bag-b.space", host: {type: "item", id: "bag-b"}, weightPolicy: INVENTORY_WEIGHT_POLICY.TRACK_INDEPENDENTLY}
    ],
    items: [
      {id: "bag-a", spaceId: "a.personal", accessGrants: [{spaceId: "bag-a.space", granteePolicy: "holder", operations: [INVENTORY_OPERATIONS.VIEW]}]},
      {id: "bag-b", spaceId: "a.personal", accessGrants: [{spaceId: "bag-b.space", granteePolicy: "holder", operations: [INVENTORY_OPERATIONS.VIEW]}]},
      {id: "ruby", spaceId: "bag-a.space"},
      {id: "sapphire", spaceId: "bag-b.space"}
    ]
  });
  assert.equal(inventorySpaceContents(state, "bag-a.space")[0].id, "ruby");
  assert.equal(inventorySpaceContents(state, "bag-b.space")[0].id, "sapphire");
});

test("two items can intentionally grant access to the same shared linked space", () => {
  const state = baseState({
    spaces: [{id: "guild.vault", host: {type: "world", id: "guild"}, weightPolicy: INVENTORY_WEIGHT_POLICY.TRACK_INDEPENDENTLY}],
    items: [
      {id: "key-a", spaceId: "a.personal", accessGrants: [{spaceId: "guild.vault", granteePolicy: "holder", operations: [INVENTORY_OPERATIONS.VIEW]}]},
      {id: "key-b", spaceId: "b.personal", accessGrants: [{spaceId: "guild.vault", granteePolicy: "holder", operations: [INVENTORY_OPERATIONS.VIEW]}]}
    ]
  });
  assert.equal(getAccessibleInventorySpaces(actorA, state).some(e => e.space.id === "guild.vault"), true);
  assert.equal(getAccessibleInventorySpaces(actorB, state).some(e => e.space.id === "guild.vault"), true);
});

test("weight policies count, ignore, and independently track contents", () => {
  const state = baseState({
    spaces: [
      {id: "bag.space", host: {type: "item", id: "bag"}, weightPolicy: INVENTORY_WEIGHT_POLICY.TRACK_BUT_IGNORE_FOR_CARRIER},
      {id: "chest", host: {type: "world", id: "room"}, weightPolicy: INVENTORY_WEIGHT_POLICY.TRACK_INDEPENDENTLY}
    ],
    items: [
      {id: "armor", spaceId: "a.personal", weight: 40},
      {id: "bag", spaceId: "a.personal", weight: 15},
      {id: "ingots", quantity: 12, spaceId: "bag.space", weight: 10},
      {id: "statue", spaceId: "chest", weight: 100}
    ]
  });
  const weight = calculateInventoryWeights(state, actorA);
  assert.equal(weight.total, 55);
  assert.equal(calculateSpaceInternalWeight(state, "bag.space"), 120);
  assert.equal(calculateSpaceInternalWeight(state, "chest"), 100);
});

test("shared space weight is not multiplied across accessors", () => {
  const state = baseState({
    spaces: [{id: "party.chest", host: {type: "party", id: "main"}, weightPolicy: INVENTORY_WEIGHT_POLICY.TRACK_INDEPENDENTLY}],
    items: [{id: "rocks", quantity: 100, weight: 1, spaceId: "party.chest"}],
    accessGrants: [
      {spaceId: "party.chest", grantee: actorA, operations: [INVENTORY_OPERATIONS.VIEW]},
      {spaceId: "party.chest", grantee: actorB, operations: [INVENTORY_OPERATIONS.VIEW]}
    ]
  });
  assert.equal(calculateInventoryWeights(state, actorA).total, 0);
  assert.equal(calculateInventoryWeights(state, actorB).total, 0);
  assert.equal(calculateSpaceInternalWeight(state, "party.chest"), 100);
});

test("capacity rejects transfer before mutation", () => {
  const state = baseState({
    spaces: [{id: "small", host: {type: "world", id: "small"}, weightPolicy: INVENTORY_WEIGHT_POLICY.TRACK_INDEPENDENTLY, capacity: {maxWeight: 5}}],
    items: [{id: "anvil", spaceId: "a.personal", weight: 10}]
  });
  const plan = planInventoryTransfer({
    state,
    itemId: "anvil",
    sourceSpaceId: "a.personal",
    destinationSpaceId: "small",
    actorRef: actorA,
    ignoreAccess: true
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, INVENTORY_CODES.CAPACITY_EXCEEDED);
  assert.equal(inventorySpaceContents(state, "a.personal")[0].id, "anvil");
});

test("partial stack transfer can merge with destination stack", () => {
  const state = baseState({
    items: [
      {id: "arrows-a", label: "Arrows", quantity: 10, stackKey: "arrow", spaceId: "a.personal"},
      {id: "arrows-b", label: "Arrows", quantity: 2, stackKey: "arrow", spaceId: "b.personal"}
    ]
  });
  const plan = planInventoryTransfer({
    state,
    itemId: "arrows-a",
    sourceSpaceId: "a.personal",
    destinationSpaceId: "b.personal",
    actorRef: actorA,
    quantity: 4,
    ignoreAccess: true
  });
  const next = commitInventoryTransfer(state, plan).state;
  assert.equal(next.items.find(i => i.id === "arrows-a").quantity, 6);
  assert.equal(next.items.find(i => i.id === "arrows-b").quantity, 6);
});

test("transfer planning rejects destination access before mutation", () => {
  const state = baseState({items: [{id: "apple", quantity: 1, spaceId: "a.personal"}]});
  const plan = planInventoryTransfer({
    state,
    itemId: "apple",
    sourceSpaceId: "a.personal",
    destinationSpaceId: "b.personal",
    actorRef: actorA
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, INVENTORY_CODES.DEPOSIT_NOT_ALLOWED);
  assert.equal(state.items.find(i => i.id === "apple").spaceId, "a.personal");
});

test("transfer planning and failed commit do not mutate source state", () => {
  const state = baseState({items: [{id: "apple", quantity: 2, spaceId: "a.personal"}]});
  const plan = planInventoryTransfer({
    state,
    itemId: "apple",
    sourceSpaceId: "a.personal",
    destinationSpaceId: "b.personal",
    actorRef: actorA,
    quantity: 1
  });
  assert.equal(state.items.find(i => i.id === "apple").quantity, 2);

  const failed = commitInventoryTransfer(state, {...plan, quantity: 99});
  assert.equal(failed.ok, false);
  assert.equal(state.items.find(i => i.id === "apple").quantity, 2);
});

test("self containment and recursive containment cycles are rejected", () => {
  const state = baseState({
    spaces: [
      {id: "bag-a.space", host: {type: "item", id: "bag-a"}, parentItemId: "bag-a", weightPolicy: INVENTORY_WEIGHT_POLICY.TRACK_INDEPENDENTLY},
      {id: "bag-b.space", host: {type: "item", id: "bag-b"}, parentItemId: "bag-b", weightPolicy: INVENTORY_WEIGHT_POLICY.TRACK_INDEPENDENTLY}
    ],
    items: [
      {id: "bag-a", spaceId: "a.personal", containsSpaceIds: ["bag-a.space"]},
      {id: "bag-b", spaceId: "bag-a.space", containsSpaceIds: ["bag-b.space"]}
    ]
  });

  assert.equal(wouldCreateContainmentCycle(state, "bag-a", "bag-a.space"), true);
  assert.equal(wouldCreateContainmentCycle(state, "bag-a", "bag-b.space"), true);
  const plan = planInventoryTransfer({
    state,
    itemId: "bag-a",
    sourceSpaceId: "a.personal",
    destinationSpaceId: "bag-b.space",
    actorRef: actorA,
    ignoreAccess: true
  });
  assert.equal(plan.code, INVENTORY_CODES.CONTAINMENT_CYCLE);
});

test("inventory debug snapshot exposes access provenance, containment, and weight trace", () => {
  const state = baseState({
    spaces: [
      {id: "bag.space", host: {type: "item", id: "bag"}, parentItemId: "bag", weightPolicy: INVENTORY_WEIGHT_POLICY.TRACK_BUT_IGNORE_FOR_CARRIER}
    ],
    items: [
      {
        id: "bag",
        label: "Bag",
        spaceId: "a.personal",
        weight: 2,
        containsSpaceIds: ["bag.space"],
        accessGrants: [{spaceId: "bag.space", granteePolicy: "holder", operations: [INVENTORY_OPERATIONS.VIEW]}]
      },
      {id: "gem", label: "Gem", spaceId: "bag.space", weight: 5}
    ]
  });
  const snapshot = createInventoryDebugSnapshot(state, {actorRef: actorA});

  assert.equal(snapshot.counts.spaces, 3);
  assert.equal(snapshot.counts.items, 2);
  assert.deepEqual(snapshot.containment, [{itemId: "bag", spaceId: "bag.space"}]);
  assert.equal(snapshot.spaces.find(space => space.id === "bag.space").accessible, true);
  assert.equal(snapshot.spaces.find(space => space.id === "bag.space").internalWeight, 5);
  assert.equal(snapshot.access.find(entry => entry.spaceId === "bag.space").sources[0].type, "item");
  assert.equal(snapshot.weights.total, 2);
});

test("in-memory inventory repository plans and commits without exposing mutable state", async () => {
  const repository = createInMemoryInventoryRepository(baseState({
    items: [{id: "apple", label: "Apple", quantity: 2, spaceId: "a.personal"}]
  }));

  const loaded = await repository.loadState();
  loaded.items[0].quantity = 99;
  assert.equal((await repository.loadState()).items[0].quantity, 2);

  const plan = await repository.planTransfer({
    itemId: "apple",
    sourceSpaceId: "a.personal",
    destinationSpaceId: "b.personal",
    actorRef: actorA,
    quantity: 1,
    ignoreAccess: true
  });
  assert.equal(plan.ok, true);

  const committed = await repository.commitTransfer(plan);
  assert.equal(committed.ok, true);
  const after = await repository.loadState();
  assert.equal(after.items.find(item => item.id === "apple").quantity, 1);
  assert.equal(after.items.find(item => item.id === plan.newItemId).spaceId, "b.personal");
});

test("in-memory inventory repository keeps failed transfers from mutating state", async () => {
  const repository = createInMemoryInventoryRepository(baseState({
    spaces: [{id: "tiny", host: {type: "world", id: "tiny"}, capacity: {maxItems: 0}}],
    items: [{id: "stone", label: "Stone", spaceId: "a.personal"}]
  }));
  const result = await repository.transferItem({
    itemId: "stone",
    sourceSpaceId: "a.personal",
    destinationSpaceId: "tiny",
    actorRef: actorA,
    ignoreAccess: true
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, INVENTORY_CODES.CAPACITY_EXCEEDED);
  assert.equal((await repository.listContents("a.personal"))[0].id, "stone");
});
