# Representative Action gate (Level 5, two browsers)

`CODEX.md` §28 asks for one live proof of each mechanic before content volume. The mechanics
themselves run on one GM client in the `wildpath.representative-actions` Quench batch (melee with dice
damage, ranged bands, bonus-action cost, trip, save for half with a save-gated condition, healing,
configuration scaling). This gate proves what one client cannot: who rolls and who answers.

| Case | Initiator | Target owner | Proves |
| --- | --- | --- | --- |
| `melee-dice` | Player | GM | attack and damage rolls routed to the Player; card with both rolls |
| `trip` | Player | GM | condition on a hit through the Player's attack |
| `save-routed` | GM | Player | the save is rolled by the target's Player; full damage and Poisoned on failure |
| `healing` | Player | Player | healing commit on a Player-owned Token |
| `configuration` | Player | GM | the configuration prompt is answered by the Player in the real dialog; slot spent |
| `refinement` | Player | GM | two Tokens of one base Actor targeted for a single-target attack; the Player keeps one in the refinement prompt and only that Token is attacked and damaged |
| `save-fan-out` | GM | Player + GM | a save against two creatures with different controllers: each controller rolls its own target's save |

## Procedure

Helper: `docs/development/representative-live-qa.mjs`. Preconditions: Foundry 14.369, the GM and one
Player logged in, both viewing an empty square Scene (5 ft fields) with no other Tokens, the served build
committed (its SHA goes into the evidence).

For each case:

1. **GM**: `const qa = await import("/systems/wildpath/docs/development/representative-live-qa.mjs");`
   `await qa.setupRepresentativeCase(caseId, playerId)`, which creates two marked Actors and unlinked
   Tokens at fields (2,2) and (3,2) and the embedded Action.
2. **Initiator** (Player, or GM for `save-routed`): `await qa.useRepresentativeCase(fixture)`. It targets
   the case Token natively and calls the real `Item.use()`. For `configuration`, the Player answers
   the dialog: select Slot 2, Submit.
3. **GM**: `qa.exportRepresentativeGM({fixture, resolutionId, gitSha})` → `evidence/representative-<case>-gm.json`.
   Its `proof` must be `{passed: true}`.
4. **Player**: `qa.exportRepresentativeClient({fixture, resolutionId, gitSha})` →
   `evidence/representative-<case>-player.json`.
5. **GM**: `qa.cleanupRepresentative({resolutionIds:[resolutionId]})`.

`test/representative-evidence.test.mjs` validates the committed exports.

## Acceptance record

Accepted on 2026-10-13, Foundry 14.369. The agent drove two isolated browser profiles: GM
`hUdU40DWftTFyJzW` and Player1 `6JWzwo5Aln6gZUWH`. All rolls used the `foundry-digital` provider.

| Case | Build | Resolution | Result |
| --- | --- | --- | --- |
| `melee-dice` | `efe50de` | `4q3gyetj` | Player1 rolled attack 14 → 18 (hit) and 1d8 = 6; HP 30 → 24; Action 1 → 0 |
| `trip` | `efe50de` | `sdr1rdme` | Player1 rolled 14 → 18 (hit); Prone applied; HP unchanged |
| `save-routed` | `efe50de` | `5p1g435y` | save rolled by Player1 (natural 9 vs DC 100, failed); 2d6 = 7 full damage; Poisoned |
| `healing` | `efe50de` | `bbjmeral` | HP 10 → 18 |
| `configuration` | `765259f` | `tarxm1w0` | prompt answered by Player1 (Slot 2); 3d6 = 7; Slot 2 spent, Slot 1 kept |
| `save-fan-out` | `702e8d8` | `ywum9zz3` | Player1 rolled their Token's save (1), the GM the other's (16); both failed DC 100; 2d6 = 5 to each; both Poisoned; card with three rolls |
| `refinement` | `d96dbcb` | `j36enua4` | both Tokens preselected; Player1 unticked the second; attack vs the kept Token's AC 1 (hit), 1d8 = 2; kept 30 → 28, dropped 30 → 30 |

Every case posted one card authored by the initiator, and each card was visible to the Player.
`765259f` differs from `efe50de` only in the payment option ids of multi-branch (`anyOf`) costs,
which only the configuration case uses.

The gate's runs found five defects. Each is fixed with a Node regression test:

- The save routed to the GM fallback (`a5131b0`). The target controller map was keyed only by the
  synthetic Actor uuid, while a canvas target is identified by its Token. Fixed in `efe50de`.
- The configuration dialog offered "Slot 1" and "Slot 2" with the same value `payment-1`, so the
  Player could never pick Slot 2. Fixed in `765259f`.
- The refinement prompt showed every candidate unticked while the authority's default was all of them,
  so keeping one of three counted as all three. Fixed in `c9742c8`.
- With that fixed, the kept Token was correct but the other Token took the damage, against its own AC.
  Unlinked Tokens of one base Actor share its id, and the runtime keyed target Actors by it. Fixed in
  `d96dbcb`, which drops ambiguous keys and adds Token keys.
- Before the gate, the single-client batch had found that Foundry expands dotted keys in persisted
  definitions, and that V14 silently drops ArrayField element paths, so no pool payment persisted.
  Fixed in `6052b39`.

## Limits

- **No third client:** a third, unrelated Player is not connected, so "an unrelated client sees nothing
  private" rests on the disclosure tests and the staged-movement sentinel.
- **Not covered here:**
  - areas (Stage I);
  - physical and manual dice (request/roll gaps);
  - reactions inside an Action (covered by the movement sentinels);
  - the ranged and bonus-action cases (single-client Quench only; their routing is the same as `melee-dice`).
- **Dialog titles:** these runs showed raw request types (`action-configuration`); prompts now carry
  localized titles and labels.
