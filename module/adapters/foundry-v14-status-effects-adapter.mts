interface ConditionStatus {
  readonly id: string;
  readonly name: string;
  readonly img: string;
}

/** V14.367 consumes CONFIG.statusEffects by ID. Keep Foundry's registry/proxy intact. */
export function registerFoundryV14ConditionStatuses(
  registry: Record<string, unknown>, conditions: Readonly<Record<string, ConditionStatus>>
): void {
  // WildPath intentionally supplies its own status set; replacing the registry with an array
  // loses Foundry's ID lookup even though the HUD can still enumerate the array entries.
  for ( const id of Object.keys(registry) ) delete registry[id];
  for ( const condition of Object.values(conditions) ) {
    registry[condition.id] = {
      id: condition.id, name: condition.name, img: condition.img, type: "condition",
      system: {type: condition.id, level: null}
    };
  }
}
