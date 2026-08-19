export type EntityRefKind =
  | "actor"
  | "token"
  | "item"
  | "effect"
  | "scene"
  | "combat"
  | "combatant"
  | "user"
  | "uuid"
  | "unknown";

export type ActorRef = `actor:${string}`;
export type TokenRef = `token:${string}`;
export type ItemRef = `item:${string}`;
export type EffectRef = `effect:${string}`;
export type SceneRef = `scene:${string}`;
export type CombatRef = `combat:${string}`;
export type CombatantRef = `combatant:${string}`;
export type UserRef = `user:${string}`;
export type UuidRef = `uuid:${string}`;

export type EntityRef =
  | ActorRef
  | TokenRef
  | ItemRef
  | EffectRef
  | SceneRef
  | CombatRef
  | CombatantRef
  | UserRef
  | UuidRef;

export interface ParsedEntityRef {
  readonly ok: boolean;
  readonly ref: EntityRef | null;
  readonly kind: EntityRefKind;
  readonly scope: string | null;
  readonly id: string | null;
  readonly key: string | null;
  readonly reason: string | null;
}

export interface EntityReference {
  readonly ref: EntityRef | null;
  readonly id: string | null;
  readonly uuid?: string | null;
  readonly actorId?: string | null;
  readonly tokenId?: string | null;
  readonly name?: string | null;
  readonly type?: string | null;
  readonly disposition?: string | null;
  readonly tags: readonly string[];
}

export interface ActionReference {
  readonly id: string | null;
  readonly ref?: EntityRef | null;
  readonly uuid: string | null;
  readonly type: string;
  readonly name: string | null;
  readonly slug?: string | null;
  readonly tags: readonly string[];
  readonly cost?: unknown;
  readonly activationCost?: ActivationCost | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ActivationRequirement {
  readonly capability: string;
  readonly amount: number;
  readonly unit?: string | null;
}

export interface ActivationCost {
  readonly allOf?: readonly ActivationRequirement[];
  readonly anyOf?: readonly (readonly ActivationRequirement[])[];
  readonly requirements?: readonly ActivationRequirement[];
}

export interface EconomyResource {
  readonly id: string;
  readonly category: string;
  readonly current: number;
  readonly maximum: number;
  readonly unit: string;
  readonly paymentCapabilities: readonly string[];
  readonly predicate?: unknown;
  readonly refreshPolicies: readonly RefreshPolicy[];
  readonly source: Readonly<Record<string, unknown>> | null;
  readonly priority: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RefreshPolicy {
  readonly event: string;
  readonly [key: string]: unknown;
}

export interface PaymentPlanResource {
  readonly resourceId: string;
  readonly amount: number;
  readonly capability: string;
  readonly unit?: string | null;
  readonly mode: "direct" | "alternative" | string;
  readonly alternativeFor?: string | null;
  readonly policy?: string | null;
  readonly source?: Readonly<Record<string, unknown>> | null;
}

export interface PaymentOption {
  readonly id: string;
  readonly resources: readonly PaymentPlanResource[];
  readonly trace: readonly unknown[];
}

export interface PaymentDiscovery {
  readonly status: "available" | "unavailable" | string;
  readonly code: string;
  readonly options: readonly PaymentOption[];
  readonly failures: readonly unknown[];
}

export interface MutationPlan {
  readonly ok?: boolean;
  readonly type?: string;
  readonly updates?: Readonly<Record<string, unknown>>;
  readonly payments?: readonly unknown[];
  readonly [key: string]: unknown;
}

export interface ResolutionTransactionOperation {
  readonly id: string | null;
  readonly type: string;
  readonly actorRef: string | null;
  readonly updates: Readonly<Record<string, unknown>>;
  readonly rollbackUpdates: Readonly<Record<string, unknown>>;
  readonly rollbackAvailable: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ResolutionTransactionResult {
  readonly ok: boolean;
  readonly code: string;
  readonly committed: readonly ResolutionTransactionOperation[];
  readonly rollbacks: readonly ResolutionTransactionOperation[];
  readonly failures: readonly unknown[];
  readonly rolledBack: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ConditionEffectMutationPlan {
  readonly type: "conditionEffect";
  readonly conditionId: string;
  readonly levels: number;
  readonly action: "create" | "update" | "delete" | "noop";
  readonly stacking: boolean;
  readonly maxLevel: number | null;
  readonly fromLevel: number | null;
  readonly toLevel: number | null;
  readonly existingEffectId: string | null;
  readonly existingEffectUuid: string | null;
  readonly target: unknown;
  readonly definition: Readonly<Record<string, unknown>>;
  readonly duration: Readonly<Record<string, unknown>> | null;
  readonly concentration: Readonly<Record<string, unknown>> | null;
  readonly sourceRef: EntityRef | string | null;
  readonly originRef: EntityRef | string | null;
  readonly source: unknown;
  readonly origin: unknown;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ConditionEffectResult {
  readonly ok: boolean;
  readonly code: string;
  readonly resolver: "EffectResolver";
  readonly effectType: "condition";
  readonly conditionId: string | null;
  readonly action?: ConditionEffectMutationPlan["action"];
  readonly levels?: number;
  readonly stacking?: boolean;
  readonly fromLevel?: number | null;
  readonly toLevel?: number | null;
  readonly duration?: Readonly<Record<string, unknown>> | null;
  readonly concentration?: Readonly<Record<string, unknown>> | null;
  readonly sourceRef?: EntityRef | string | null;
  readonly originRef?: EntityRef | string | null;
  readonly mutationPlan: ConditionEffectMutationPlan | null;
  readonly committed?: boolean;
  readonly reason?: string | null;
}

export interface EffectLifecycleResult {
  readonly ok: boolean;
  readonly code: string;
  readonly resolver: "EffectLifecycleResolver";
  readonly conditionPlans: readonly ConditionEffectResult[];
  readonly mutationPlans: readonly ConditionEffectMutationPlan[];
  readonly expired: readonly unknown[];
  readonly concentrationBroken: readonly unknown[];
  readonly unchanged: readonly unknown[];
  readonly failures: readonly unknown[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ConcentrationDecisionResult {
  readonly ok: boolean;
  readonly code: string;
  readonly resolver: "ConcentrationResolver";
  readonly breakEvents: readonly unknown[];
  readonly maintained: readonly unknown[];
  readonly ignored: readonly unknown[];
  readonly failures: readonly unknown[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ConcentrationCheckRequest {
  readonly id: string;
  readonly type: "damage" | string;
  readonly actorId: string | null;
  readonly actorRef: EntityRef | string | null;
  readonly sourceRef: EntityRef | string | null;
  readonly originRef: EntityRef | string | null;
  readonly itemRef: EntityRef | string | null;
  readonly target: unknown;
  readonly targetRef: EntityRef | string | null;
  readonly damageTaken: number;
  readonly dc: number;
  readonly saveKey: string;
  readonly ability: string;
  readonly damageResult: unknown;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ConcentrationCheckPlanningResult {
  readonly ok: boolean;
  readonly code: string;
  readonly resolver: "ConcentrationResolver";
  readonly checkRequests: readonly ConcentrationCheckRequest[];
  readonly skipped: readonly unknown[];
  readonly failures: readonly unknown[];
  readonly policy: Readonly<Record<string, unknown>>;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ConcentrationCheckResolutionResult {
  readonly ok: boolean;
  readonly code: string;
  readonly resolver: "ConcentrationResolver";
  readonly decisionEvents: readonly unknown[];
  readonly decisions: readonly unknown[];
  readonly breakEvents: readonly unknown[];
  readonly maintained: readonly unknown[];
  readonly ignored: readonly unknown[];
  readonly missing: readonly unknown[];
  readonly failures: readonly unknown[];
  readonly policy: Readonly<Record<string, unknown>>;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface EffectLifecycleCommitResult {
  readonly ok: boolean;
  readonly code: string;
  readonly resolver: "EffectLifecycleCommitResolver";
  readonly concentration: ConcentrationDecisionResult | null;
  readonly lifecycleResults: readonly EffectLifecycleResult[];
  readonly mutationPlans: readonly ConditionEffectMutationPlan[];
  readonly failures: readonly unknown[];
  readonly targetOperations: unknown;
  readonly transaction: ResolutionTransactionResult | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ResolverSuccess<TCode extends string = "OK", TData extends object = Record<string, never>> {
  readonly ok: true;
  readonly code: TCode;
  readonly status?: string;
  readonly data?: TData;
}

export interface ResolverFailure<TCode extends string = string> {
  readonly ok: false;
  readonly code: TCode;
  readonly status?: string;
  readonly reason?: string | null;
  readonly errors?: readonly unknown[];
  readonly warnings?: readonly unknown[];
}

export type ResolverResult<
  TCode extends string = string,
  TData extends object = Record<string, never>
> = ResolverSuccess<TCode, TData> | ResolverFailure<TCode>;

export interface ActionContext {
  readonly id: string | null;
  readonly action: ActionReference | null;
  readonly source: EntityReference;
  readonly actorId: string | null;
  readonly tokenId: string | null;
  readonly targets: readonly EntityReference[];
  readonly targetSet: unknown;
  readonly area: unknown;
  readonly resources: readonly unknown[];
  readonly rollMode: string;
  readonly rulesVersion: string | null;
  readonly policies: Readonly<Record<string, unknown>>;
  readonly events: readonly AutomationEvent[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ActionResolutionStep {
  readonly stage: string;
  readonly status: string;
  readonly code: string;
  readonly reason?: string | null;
  readonly data?: unknown;
}

export interface ActionResult {
  readonly ok: boolean;
  readonly status: string;
  readonly code: string;
  readonly context: ActionContext | null;
  readonly steps: readonly ActionResolutionStep[];
  readonly events: readonly AutomationEvent[];
  readonly consequences: readonly unknown[];
  readonly mutationPlans: readonly MutationPlan[];
  readonly errors: readonly unknown[];
  readonly warnings: readonly unknown[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface AutomationEvent {
  readonly id: string | null;
  readonly type: string;
  readonly phase: string;
  readonly actorId: string | null;
  readonly tokenId: string | null;
  readonly source: EntityReference;
  readonly targets: readonly EntityReference[];
  readonly tags: readonly string[];
  readonly data: Readonly<Record<string, unknown>>;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ResourceViewModel {
  readonly id: string;
  readonly category: string;
  readonly label: string;
  readonly current: number;
  readonly maximum: number;
  readonly unit: string;
  readonly depleted: boolean;
  readonly full: boolean;
  readonly ratio: number;
  readonly paymentCapabilities: readonly string[];
  readonly refreshEvents: readonly string[];
  readonly source: Readonly<Record<string, unknown>> | null;
}

export interface ActionBarEntryViewModel {
  readonly id: string | null;
  readonly ref: EntityRef | null;
  readonly label: string;
  readonly img: string | null;
  readonly type: string;
  readonly group: string;
  readonly tags: readonly string[];
  readonly enabled: boolean;
  readonly selected: boolean;
  readonly state: "ready" | "selected" | "unavailable";
  readonly disabledCode: string | null;
  readonly cost: unknown;
  readonly payment: {
    readonly status: string;
    readonly code: string;
    readonly defaultOptionId: string | null;
    readonly options: readonly unknown[];
    readonly failures: readonly unknown[];
  };
  readonly command: UICommand | null;
  readonly previewCommand: UICommand;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface UICommand {
  readonly type: string;
  readonly actorRef?: EntityRef | null;
  readonly tokenRef?: EntityRef | null;
  readonly actionRef?: EntityRef | null;
  readonly actionId?: string | null;
  readonly combatRef?: EntityRef | null;
  readonly selectedPaymentOptionId?: string | null;
}

export interface ActionBarViewModel {
  readonly actorRef: EntityRef | null;
  readonly actorName: string | null;
  readonly resources: readonly ResourceViewModel[];
  readonly actions: readonly ActionBarEntryViewModel[];
  readonly groups: readonly {
    readonly id: string;
    readonly label: string;
    readonly actions: readonly (EntityRef | null)[];
  }[];
  readonly summary: Readonly<Record<string, number>>;
}

export interface CombatCarouselTurnViewModel {
  readonly id: string;
  readonly ref: CombatantRef | null;
  readonly actorRef: ActorRef | null;
  readonly tokenRef: TokenRef | null;
  readonly label: string;
  readonly index: number;
  readonly initiative: number | null;
  readonly active: boolean;
  readonly previous: boolean;
  readonly next: boolean;
  readonly distanceFromActive: number | null;
  readonly defeated: boolean;
  readonly hidden: boolean;
  readonly resources: readonly ResourceViewModel[];
  readonly statuses: readonly unknown[];
  readonly command: UICommand | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface CombatCarouselViewModel {
  readonly combatRef: CombatRef | null;
  readonly round: number;
  readonly turn: number;
  readonly activeRef: CombatantRef | null;
  readonly activeActorRef: ActorRef | null;
  readonly activeTokenRef: TokenRef | null;
  readonly turns: readonly CombatCarouselTurnViewModel[];
  readonly previous: CombatCarouselTurnViewModel | null;
  readonly next: CombatCarouselTurnViewModel | null;
  readonly commands: Readonly<Record<string, UICommand | null>>;
  readonly summary: Readonly<Record<string, number>>;
}

export interface CharacterSheetViewModel {
  readonly actor: {
    readonly id: string;
    readonly ref: EntityRef;
    readonly uuid: string | null;
    readonly type: string;
    readonly name: string;
    readonly img: string;
  };
  readonly header: Readonly<Record<string, unknown>>;
  readonly sections: readonly {
    readonly id: string;
    readonly label: string;
    readonly anchor: string;
  }[];
  readonly abilities: readonly unknown[];
  readonly resources: readonly unknown[];
  readonly pools: readonly unknown[];
  readonly actionItems: readonly unknown[];
  readonly featureItems: readonly unknown[];
  readonly gearItems: readonly unknown[];
  readonly otherItems: readonly unknown[];
  readonly effects: readonly unknown[];
  readonly conditions: readonly unknown[];
  readonly actionBar: ActionBarViewModel;
  readonly summary: Readonly<Record<string, number>>;
}
