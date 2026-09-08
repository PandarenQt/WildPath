type TargetData = Readonly<Record<string, unknown>>;

/** Condition plans may carry a TargetCandidate; its outer ID identifies the Token, not the Actor. */
export function mutationTargetIdentity(target: TargetData): TargetData {
  const identity = target.target;
  return identity !== null && typeof identity === "object" && !Array.isArray(identity)
    ? identity as TargetData : target;
}
