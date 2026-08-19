# TargetResolver

`module/resolvers/target-resolver.mjs` is the resolver-facing bridge over the existing pure
targeting primitives.

## Current Flow

```text
target refs / target candidates / target set
-> physical TargetSet
-> eligibility policy
-> refinement policy + decisions
-> target contexts
-> selection request state
```

The resolver does not calculate area geometry. Area geometry still belongs to the tactical area
helpers and area-targeting bridge. TargetResolver consumes target sets once physical target
candidates are known.

## What It Does Now

`resolveActionTargets()`:

- normalizes plain target references, target candidates, or an existing target set
- handles required-target failure before deeper validation
- applies eligibility policy through `resolveTargetEligibility()`
- applies refinement policy through `refineTargetSet()`
- returns target contexts and selection request state
- preserves rejected candidates for audit/debug output

`createSelfTargetSet()`:

- converts a source Actor/Token reference into a self-target set
- supports self-targeting actions without special branches in ActionResolver later

## Result Codes

Resolver-level codes describe action-facing state:

- `OK`
- `NO_TARGETS`
- `NO_VALID_TARGETS`
- `TARGETING_FAILED`

The lower-level targeting code is preserved as `targetCode` so UI and debug output can still report
selection-limit, predicate, and eligibility details.

## What It Does Not Do Yet

TargetResolver does not:

- read Foundry user targets
- inspect the canvas
- calculate range
- place templates
- calculate AoE footprints
- prompt the user
- mutate ActionResult

Foundry adapters should gather selected Tokens and Scene information, then pass plain target data
into this resolver.

## Next Integration

The next ActionResolver slice should call TargetResolver when an action declares target
requirements, attach final target contexts to the `ActionResult`, and emit a semantic
`targets.selected` event before payment, attack, save, damage, or effect resolution continues.
