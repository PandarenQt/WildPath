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

export interface ActionDefinition {
  readonly schemaVersion: number;
  readonly id: string | null;
  readonly slug: string | null;
  readonly label: string | null;
  readonly category: string;
  readonly tags: readonly string[];
  readonly source: Readonly<Record<string, unknown>> | null;
  readonly origin: ActionOriginDefinition;
  readonly activation: Readonly<Record<string, unknown>> | null;
  readonly costs: ActionCostDefinition;
  readonly range: RangeDefinition | null;
  readonly targeting: TargetingDefinition | null;
  readonly area: AreaDefinition | null;
  readonly attack: AttackDefinition | null;
  readonly save: SaveDefinition | null;
  readonly check: CheckDefinition | null;
  readonly damage: readonly DamageDefinition[];
  readonly healing: readonly HealingDefinition[];
  readonly effects: readonly EffectApplicationDefinition[];
  readonly duration: DurationDefinition | null;
  readonly configuration: readonly Readonly<Record<string, unknown>>[];
  readonly ruleElements: readonly RuleElementDefinition[];
  readonly policies: Readonly<Record<string, unknown>>;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ActionOriginDefinition {
  readonly type: string;
  readonly ref?: EntityRef | string | null;
  readonly predicate?: Predicate | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ActionCostDefinition {
  readonly allOf?: readonly ActionCostRequirement[];
  readonly anyOf?: readonly (readonly ActionCostRequirement[])[];
}

export interface ActionCostRequirement {
  readonly type?: "actionEconomy" | "resource" | string;
  readonly capability: string | null;
  readonly amount: number;
  readonly unit?: string | null;
  readonly predicate?: Predicate | null;
  readonly source?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RangeDefinition {
  readonly type: string;
  readonly distance?: DistanceDefinition | null;
  readonly normal?: DistanceDefinition | null;
  readonly long?: DistanceDefinition | null;
  readonly unit?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface DistanceDefinition {
  readonly type?: string;
  readonly value?: number;
  readonly unit?: string;
}

export interface TargetingDefinition {
  readonly type: string;
  readonly required: boolean;
  readonly count?: ValueExpression | null;
  readonly targetPolicy?: string | null;
  readonly predicate?: Predicate | null;
  readonly eligibilityPolicy: Readonly<Record<string, unknown>>;
  readonly refinementPolicy: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AreaDefinition {
  readonly shape: string | null;
  readonly size?: DistanceDefinition | null;
  readonly width?: DistanceDefinition | null;
  readonly placement?: Readonly<Record<string, unknown>> | null;
  readonly persistence?: Readonly<Record<string, unknown>> | null;
  readonly targetPolicy?: Readonly<Record<string, unknown>> | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AttackDefinition {
  readonly type?: string;
  readonly statistic?: string;
  readonly statisticSource?: string;
  readonly ability?: string;
  readonly proficiency?: string;
  readonly rangeMode?: string;
  readonly defenseKey?: string;
  readonly selectors?: readonly string[];
  readonly policy?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SaveDefinition {
  readonly ability?: string;
  readonly saveKey?: string;
  readonly dc: SaveDCDefinition | number;
  readonly dcKey?: string;
  readonly policy?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SaveDCDefinition {
  readonly value?: number;
  readonly dc?: number;
  readonly valueExpression?: ValueExpression;
  readonly expression?: ValueExpression;
  readonly ability?: string;
  readonly source?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type CheckDefinition = Readonly<Record<string, unknown>>;

export interface DamageDefinition {
  readonly id: string;
  readonly expression: ValueExpression | null;
  readonly damageType: string;
  readonly provenance: string;
  readonly scalingCategory: string;
  readonly weaponSizeScalable: boolean;
  readonly outcomePolicy: Readonly<Record<string, unknown>>;
  readonly saveOutcomePolicy?: Readonly<Record<string, unknown>> | string | null;
  readonly predicate?: Predicate | null;
  readonly targetPolicy: string;
  readonly scaling?: Readonly<Record<string, unknown>>;
  readonly source?: unknown;
  readonly tags: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface HealingDefinition {
  readonly id: string;
  readonly expression: ValueExpression | null;
  readonly healingType: string;
  readonly targetPolicy: string;
  readonly predicate?: Predicate | null;
  readonly scaling?: Readonly<Record<string, unknown>>;
  readonly source?: unknown;
  readonly tags: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface EffectApplicationDefinition {
  readonly id: string;
  readonly type: string;
  readonly ref?: EntityRef | string | null;
  readonly conditionId?: string | null;
  readonly levels?: number;
  readonly application?: Readonly<Record<string, unknown>>;
  readonly duration?: DurationDefinition | null;
  readonly concentration?: unknown;
  readonly saveOutcomePolicy?: Readonly<Record<string, unknown>> | string | null;
  readonly predicate?: Predicate | null;
  readonly source?: unknown;
  readonly origin?: unknown;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type DurationDefinition = Readonly<Record<string, unknown>>;

export interface PredicateEquals {
  readonly path: string;
  readonly value: unknown;
}

export interface PredicateOneOf {
  readonly path: string;
  readonly values: readonly unknown[];
}

export interface PredicateClause {
  readonly tagsAny?: readonly string[];
  readonly tagsAll?: readonly string[];
  readonly notTagsAny?: readonly string[];
  readonly hasCondition?: string;
  readonly missingCondition?: string;
  readonly equals?: PredicateEquals;
  readonly oneOf?: PredicateOneOf;
}

export interface PredicateAll {
  readonly all: readonly Predicate[];
}

export interface PredicateAny {
  readonly any: readonly Predicate[];
}

export interface PredicateNot {
  readonly not: Predicate;
}

export type Predicate = PredicateClause | PredicateAll | PredicateAny | PredicateNot;

export type ValueExpression =
  | number
  | ConstantValueExpression
  | ContextValueExpression
  | AbilityValueExpression
  | ProficiencyBonusValueExpression
  | CharacterLevelValueExpression
  | ClassLevelValueExpression
  | SpellcastingModifierValueExpression
  | ResourceValueExpression
  | ArithmeticValueExpression
  | UnaryValueExpression
  | DiceValueExpression;

export interface ConstantValueExpression {
  readonly type: "constant";
  readonly value: number;
}

export interface ContextValueExpression {
  readonly type: "context";
  readonly path: string;
}

export interface AbilityValueExpression {
  readonly type: "ability-score" | "abilityScore" | "ability-modifier" | "abilityModifier";
  readonly ability: string;
}

export interface ProficiencyBonusValueExpression {
  readonly type: "proficiency-bonus" | "proficiencyBonus";
}

export interface CharacterLevelValueExpression {
  readonly type: "character-level" | "characterLevel";
}

export interface ClassLevelValueExpression {
  readonly type: "class-level" | "classLevel";
  readonly class?: string;
  readonly classId?: string;
  readonly key?: string;
  readonly slug?: string;
  readonly name?: string;
}

export interface SpellcastingModifierValueExpression {
  readonly type: "spellcasting-modifier" | "spellcastingModifier";
  readonly ability?: string;
}

export interface ResourceValueExpression {
  readonly type: "resource-current" | "resourceCurrent" | "resource-max" | "resourceMax";
  readonly resource?: string;
  readonly resourceId?: string;
  readonly id?: string;
  readonly key?: string;
}

export interface ArithmeticValueExpression {
  readonly type: "add" | "subtract" | "multiply" | "divide" | "min" | "max";
  readonly terms?: readonly ValueExpression[];
  readonly left?: ValueExpression;
  readonly right?: ValueExpression;
  readonly numerator?: ValueExpression;
  readonly denominator?: ValueExpression;
  readonly value?: ValueExpression;
  readonly minus?: ValueExpression;
  readonly round?: "floor" | "ceil" | "round";
}

export interface UnaryValueExpression {
  readonly type: "floor" | "ceil";
  readonly value: ValueExpression;
}

export interface DiceValueExpression {
  readonly type: "dice";
  readonly number?: number;
  readonly count?: number;
  readonly faces?: number;
  readonly sides?: number;
  readonly bonus?: ValueExpression;
  readonly total?: number;
  readonly rolled?: number;
  readonly roll?: number;
  readonly formula?: string;
  readonly evaluation?: "average";
  readonly mode?: "average";
}

export interface ValueExpressionResult {
  readonly ok: boolean;
  readonly code: string;
  readonly value: number;
  readonly reason?: string;
}

export interface PredicateResult {
  readonly ok: boolean;
  readonly code: string;
  readonly reason?: string;
}

export interface ModifierDefinition {
  readonly id?: string;
  readonly slug?: string;
  readonly label?: string;
  readonly selector?: string | null;
  readonly domains?: readonly string[];
  readonly type?: string;
  readonly value?: number;
  readonly valueExpression?: ValueExpression | null;
  readonly predicate?: Predicate | null;
  readonly priority?: number;
  readonly order?: number;
  readonly source?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly enabled?: boolean;
  readonly suppressed?: boolean;
}

export interface ModifierTraceEntry {
  readonly id: string;
  readonly slug: string;
  readonly label: string;
  readonly selector: string | null;
  readonly domains: readonly string[];
  readonly type: string;
  readonly value: number;
  readonly valueExpression: ValueExpression;
  readonly valueResult: ValueExpressionResult;
  readonly predicate: Predicate | null;
  readonly predicateResult: PredicateResult;
  readonly priority: number;
  readonly source: unknown;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly status: string;
}

export interface ModifierTrace {
  readonly domain: string;
  readonly total: number;
  readonly candidates: readonly ModifierTraceEntry[];
  readonly applied: readonly ModifierTraceEntry[];
}

export type RuleElementType =
  | "Modifier"
  | "GrantResource"
  | "GrantActionEconomyResource"
  | "GrantResistance"
  | "GrantImmunity"
  | "GrantMovement"
  | "Trigger"
  | (string & {});

export type RuleElementTraceStatus =
  | "contributed"
  | "disabled"
  | "suppressed"
  | "predicate-failed"
  | "failed";

export interface RuleElementDefinition {
  readonly schemaVersion?: number;
  readonly id?: string;
  readonly slug?: string;
  readonly type?: RuleElementType;
  readonly key?: RuleElementType | string;
  readonly rule?: RuleElementType | string;
  readonly label?: string | null;
  readonly name?: string | null;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly predicate?: Predicate | null;
  readonly priority?: number;
  readonly order?: number;
  readonly source?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly enabled?: boolean;
  readonly suppressed?: boolean;
}

export interface RuleElementSource {
  readonly type: string;
  readonly uuid?: string | null;
  readonly id?: string | null;
  readonly name?: string | null;
  readonly conditionId?: string | null;
  readonly ruleElementId?: string | null;
  readonly ruleElementType?: RuleElementType | null;
  readonly parent?: RuleElementSource | Readonly<Record<string, unknown>> | null;
}

export interface RuleElementContext {
  readonly actor?: unknown;
  readonly actorSystem?: unknown;
  readonly item?: unknown;
  readonly effect?: unknown;
  readonly condition?: unknown;
  readonly action?: unknown;
  readonly target?: unknown;
  readonly event?: unknown;
  readonly domain?: string | null;
  readonly ruleElements?: readonly RuleElementDefinition[];
  readonly [key: string]: unknown;
}

export interface RuleElementTrace {
  readonly schemaVersion: number;
  readonly id: string;
  readonly type: RuleElementType | null;
  readonly label: string | null;
  readonly priority: number;
  readonly source: unknown;
  readonly predicate: Predicate | null;
  readonly predicateResult: PredicateResult | null;
  readonly status: RuleElementTraceStatus;
  readonly reason: string | null;
  readonly contributionCounts: Readonly<Record<string, number>>;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RuleElementResourceContribution {
  readonly id: string;
  readonly label: string;
  readonly current: number;
  readonly maximum: number;
  readonly recovery: string;
  readonly source: unknown;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface DamageAdjustmentContribution {
  readonly id?: string;
  readonly damageTypes?: readonly string[];
  readonly tags?: readonly string[];
  readonly multiplier?: number;
  readonly type?: string;
  readonly amount?: number | null;
  readonly scale?: number | null;
  readonly resourceId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface MovementCapability {
  readonly mode: string;
  readonly distance: number;
  readonly unit: string;
}

export interface RuleElementMovementContribution {
  readonly id: string;
  readonly capability: MovementCapability;
  readonly source: unknown;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface TriggerDefinition {
  readonly id: string;
  readonly kind: string;
  readonly event: Readonly<Record<string, unknown>>;
  readonly predicate: Predicate | null;
  readonly priority: number;
  readonly once: boolean;
  readonly enabled: boolean;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly owner: EntityReference | null;
  readonly reaction: Readonly<Record<string, unknown>> | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RuleElementContributions {
  readonly modifiers: readonly ModifierDefinition[];
  readonly resources: readonly RuleElementResourceContribution[];
  readonly economyResources: readonly EconomyResource[];
  readonly damageAdjustments: {
    readonly immunities: readonly DamageAdjustmentContribution[];
    readonly resistances: readonly DamageAdjustmentContribution[];
    readonly vulnerabilities: readonly DamageAdjustmentContribution[];
    readonly reductions: readonly DamageAdjustmentContribution[];
    readonly absorptions: readonly DamageAdjustmentContribution[];
  };
  readonly movement: readonly RuleElementMovementContribution[];
  readonly triggers: readonly TriggerDefinition[];
}

export interface RuleElementCollectionResult {
  readonly ok: boolean;
  readonly code: string;
  readonly contributions: RuleElementContributions;
  readonly traces: readonly RuleElementTrace[];
  readonly failures: readonly unknown[];
}

export interface RuleElementEvaluationResult {
  readonly ok: boolean;
  readonly code: string;
  readonly active: boolean;
  readonly reason?: string | null;
  readonly ruleElement: RuleElementDefinition;
  readonly contributions: RuleElementContributions;
  readonly trace: RuleElementTrace;
}

export interface RuleElementValidationResult {
  readonly ok: boolean;
  readonly code: string;
  readonly reason?: string | null;
  readonly path?: string | null;
  readonly ruleElement?: RuleElementDefinition | null;
  readonly failures: readonly unknown[];
}

export interface SerializedRuleElementResult {
  readonly ok: boolean;
  readonly code: string;
  readonly reason?: string | null;
  readonly definition: RuleElementDefinition;
}

export interface ConditionDurabilityTriggerPayload {
  readonly type: "durabilityChange";
  readonly changeType?: "damage" | "healing";
  readonly resourceId?: string;
  readonly resource?: string;
  readonly amount: ValueExpression;
  readonly damageType?: string | null;
  readonly tags?: readonly string[];
}

export interface ConditionTriggerPlanningResult {
  readonly ok: boolean;
  readonly code: string;
  readonly events: readonly AutomationEvent[];
  readonly dispatches: readonly unknown[];
  readonly mutationPlans: readonly MutationPlan[];
  readonly skipped: readonly unknown[];
  readonly traces: readonly RuleElementTrace[];
  readonly failures: readonly unknown[];
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
  readonly predicate?: Predicate | null;
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

export interface ConcentrationCheckCommitResult {
  readonly ok: boolean;
  readonly code: string;
  readonly resolver: "ConcentrationCheckCommitResolver";
  readonly checkResolution: ConcentrationCheckResolutionResult | null;
  readonly lifecycleCommit: EffectLifecycleCommitResult | null;
  readonly decisionEvents: readonly unknown[];
  readonly breakEvents: readonly unknown[];
  readonly mutationPlans: readonly ConditionEffectMutationPlan[];
  readonly failures: readonly unknown[];
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
  readonly requestId?: string | null;
  readonly requestIds?: readonly string[];
  readonly actorRefs?: readonly (EntityRef | string)[];
  readonly sourceRef?: EntityRef | string | null;
  readonly sourceRefs?: readonly (EntityRef | string)[];
  readonly targetRef?: EntityRef | string | null;
  readonly dc?: number | null;
  readonly ability?: string | null;
  readonly mode?: string | null;
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

export interface ConcentrationCheckPromptEntryViewModel {
  readonly id: string;
  readonly type: string;
  readonly actorId: string | null;
  readonly actorRef: EntityRef | string | null;
  readonly sourceRef: EntityRef | string | null;
  readonly originRef: EntityRef | string | null;
  readonly itemRef: EntityRef | string | null;
  readonly targetRef: EntityRef | string | null;
  readonly actorLabel: string;
  readonly originLabel: string | null;
  readonly dc: number | null;
  readonly ability: string;
  readonly saveKey: string;
  readonly damageTaken: number | null;
  readonly state: "pending" | "resolved";
  readonly result: Readonly<Record<string, unknown>> | null;
  readonly command: UICommand;
  readonly physicalCommand: UICommand | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ConcentrationCheckPromptViewModel {
  readonly checks: readonly ConcentrationCheckPromptEntryViewModel[];
  readonly pending: readonly ConcentrationCheckPromptEntryViewModel[];
  readonly resolved: readonly ConcentrationCheckPromptEntryViewModel[];
  readonly commitCommand: UICommand | null;
  readonly summary: Readonly<Record<string, number>>;
  readonly metadata: Readonly<Record<string, unknown>>;
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
