# SaveResolver

`module/resolvers/save-resolver.mjs` is the pure saving-throw foundation for future spell, area,
condition, and feature resolution.

## Current Flow

```text
known save total / natural die
-> save DC
-> save policy
-> per-target save outcome
```

The resolver accepts already-known numeric save totals and DCs. Those numbers can later come from
Foundry dice, physical dice entry, imported results, or roll-request UI. Once the number exists,
save outcome logic is the same.

`ActionResolver` can now call this resolver as an optional roll step after target validation and
before damage/payment planning.

## What It Does Now

`resolveSaveAgainstDC()`:

- normalizes a plain save roll and DC
- resolves success, failure, optional critical success, or optional critical failure
- treats ties as success by default
- keeps natural critical save behavior policy-controlled instead of assumed globally
- returns structured failure data for missing save totals or DCs

`resolveSaveTargets()`:

- consumes selected `TargetResolver` target contexts or plain targets
- resolves each selected target against its own save roll and the supplied or per-target DC
- records excluded/unselected targets as skipped audit entries
- preserves partial invalid results when one target is missing save data

## What It Does Not Do Yet

SaveResolver does not:

- roll dice
- derive save bonuses or DCs from Actor documents
- inspect selected canvas targets
- apply half damage, no damage, or other success-degree consequences
- consume resources
- create chat messages
- mutate Actor, Token, or ActiveEffect documents

Foundry adapters should gather the save total, natural die, ability, and DC from documents or UI,
then pass plain values into this resolver.

## Current Integration

`ActionResolver` can use resolved save outcomes to drive target-specific damage policies, such as
half damage on success or no damage on success, without moving save roll logic into DamageResolver.
