export type EntityRefKind =
  | "actor"
  | "token"
  | "item"
  | "effect"
  | "scene"
  | "scene-level"
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
export type SceneLevelRef = `scene-level:${string}`;
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
  | SceneLevelRef
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

export type GridTopology = "square" | "hex";
export type TacticalGridKind = GridTopology | "gridless";
export type FoundryGridType = 0 | 1 | 2 | 3 | 4 | 5;
export type FoundryHexOffsetVariant = "odd-r" | "even-r" | "odd-q" | "even-q";

export interface SquareGridField {
  readonly x: number;
  readonly y: number;
}

export interface HexGridField {
  readonly q: number;
  readonly r: number;
}

export type GridField = SquareGridField | HexGridField;

export interface FoundryGridOffset {
  readonly i: number;
  readonly j: number;
  readonly k?: number;
}

export interface GridVertex {
  readonly id: string;
  readonly topology: GridTopology;
  readonly x?: number;
  readonly y?: number;
  readonly incidentFields: readonly GridField[];
  readonly occupiedIncidentFields?: readonly GridField[];
  readonly external?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TokenFootprintDefinition {
  readonly size: string;
  readonly topology: GridTopology;
  readonly offsets: readonly GridField[];
  readonly fieldCount: number;
  readonly creaturesPerField: number;
  readonly minimumFields: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface TokenGridFootprint {
  readonly type: "TokenGridFootprint";
  readonly topology: GridTopology;
  readonly size: string;
  readonly effectiveSize: string;
  readonly anchor: GridField;
  readonly definition: TokenFootprintDefinition;
  readonly fields: readonly GridField[];
  readonly fieldKeys: readonly string[];
  readonly boundaryFields: readonly GridField[];
  readonly boundaryEdges: readonly Readonly<Record<string, unknown>>[];
  readonly boundaryVertices: readonly GridVertex[];
  readonly internalVertices: readonly GridVertex[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface GridFootprint {
  readonly type?: "GridFootprint";
  readonly topology?: GridTopology;
  readonly shape?: string | null;
  readonly origin?: unknown;
  readonly direction?: unknown;
  readonly fields: readonly GridField[];
  readonly fieldKeys?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TacticalSceneContext {
  readonly type: "TacticalSceneContext";
  readonly scene: {
    readonly id: string | null;
    readonly ref: SceneRef | string | null;
    readonly uuid: string | null;
    readonly name: string | null;
  };
  readonly grid: {
    readonly type: TacticalGridKind;
    readonly topology: GridTopology | null;
    readonly gridless: boolean;
    readonly foundryType: FoundryGridType | number | null;
    readonly distance: number;
    readonly units: string;
    readonly size: number;
    readonly sizeX: number;
    readonly sizeY: number;
    readonly columns: boolean | null;
    readonly even: boolean | null;
    readonly orientation: string;
    readonly offsetVariant: FoundryHexOffsetVariant | null;
  };
  readonly dimensions: Readonly<Record<string, unknown>>;
  readonly levels: {
    readonly initialLevelRef: SceneLevelRef | string | null;
    readonly availableLevelRefs: readonly (SceneLevelRef | string)[];
  };
  readonly capabilities: Readonly<Record<string, boolean | string>>;
  readonly foundryApisUsed: readonly string[];
}

export interface TacticalGridDiagnostic {
  readonly ok: boolean;
  readonly code: string;
  readonly reason?: string | null;
  readonly expectedFields?: readonly GridField[];
  readonly representedFields?: readonly GridField[];
  readonly missingFields?: readonly GridField[];
  readonly extraFields?: readonly GridField[];
}

export interface FoundryTokenTargetFootprint {
  readonly id: TokenRef | string | null;
  readonly target: EntityReference | Readonly<Record<string, unknown>>;
  readonly actor: EntityReference | Readonly<Record<string, unknown>> | null;
  readonly occupiedFields: readonly GridField[];
  readonly footprint: TokenGridFootprint;
  readonly kind: string;
  readonly disposition: unknown;
  readonly willing: boolean;
  readonly size: string | null;
  readonly tags: readonly string[];
  readonly conditions: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface TacticalGridPort {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  getSceneContext(): ResolverResult<string, {readonly context: TacticalSceneContext}> | Readonly<Record<string, unknown>>;
  getCapabilities(): Readonly<Record<string, unknown>>;
  offsetToField(offset: FoundryGridOffset | Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
  fieldToOffset(field: GridField): Readonly<Record<string, unknown>>;
  pointToField(point: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
  fieldToCenterPoint(field: GridField): Readonly<Record<string, unknown>>;
  fieldToVertices(field: GridField): Readonly<Record<string, unknown>>;
  pointToVertex(point: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
  compareAdjacentOffsets(field: GridField): Readonly<Record<string, unknown>>;
  distanceToGridFields(distance: number): Readonly<Record<string, unknown>>;
  tokenToFootprint(token: unknown, options?: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
  tokenToTargetFootprint(token: unknown, options?: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
  collectTokenTargetFootprints(options?: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
  resolveAreaTargetCandidates(options?: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
  resolveAreaTargetSet(options?: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
  compareTokenOccupiedSpaces(token: unknown, options?: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
  validateTokenLevelRelation(sourceToken: unknown, targetToken: unknown, options?: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
}

export interface PersistenceOperationResult {
  readonly ok: boolean;
  readonly code: string;
  readonly reason?: string | null;
  readonly actorRef?: ActorRef | string | null;
  readonly documentRef?: EntityRef | string | null;
  readonly embeddedName?: string | null;
  readonly updates?: Readonly<Record<string, unknown>>;
  readonly documents?: readonly Readonly<Record<string, unknown>>[];
  readonly result?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ActorUpdatePersistenceOperation {
  readonly actor?: unknown;
  readonly actorRef?: ActorRef | string | null;
  readonly updates: Readonly<Record<string, unknown>>;
  readonly operation?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface EmbeddedDocumentCreatePersistenceOperation {
  readonly parent?: unknown;
  readonly actor?: unknown;
  readonly actorRef?: ActorRef | string | null;
  readonly embeddedName: string;
  readonly documents: readonly Readonly<Record<string, unknown>>[];
  readonly operation?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface DocumentUpdatePersistenceOperation {
  readonly document?: unknown;
  readonly documentRef?: EntityRef | string | null;
  readonly updates: Readonly<Record<string, unknown>>;
  readonly operation?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface DocumentDeletePersistenceOperation {
  readonly document?: unknown;
  readonly documentRef?: EntityRef | string | null;
  readonly operation?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ToggleStatusEffectPersistenceOperation {
  readonly actor?: unknown;
  readonly actorRef?: ActorRef | string | null;
  readonly statusId: string;
  readonly active?: boolean;
  readonly operation?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface DocumentPersistencePort {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  updateActor(operation: ActorUpdatePersistenceOperation): Promise<PersistenceOperationResult> | PersistenceOperationResult;
  createEmbeddedDocuments(operation: EmbeddedDocumentCreatePersistenceOperation): Promise<PersistenceOperationResult> | PersistenceOperationResult;
  updateDocument(operation: DocumentUpdatePersistenceOperation): Promise<PersistenceOperationResult> | PersistenceOperationResult;
  deleteDocument(operation: DocumentDeletePersistenceOperation): Promise<PersistenceOperationResult> | PersistenceOperationResult;
  toggleStatusEffect?(operation: ToggleStatusEffectPersistenceOperation): Promise<PersistenceOperationResult> | PersistenceOperationResult;
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

export type ActionChoiceType =
  | "select-one"
  | "select-many"
  | "boolean"
  | "number"
  | "resource"
  | "damage-type"
  | "option";

export interface ActionChoiceOption {
  readonly id: string;
  readonly label: string;
  readonly value?: unknown;
  readonly paymentOptionId?: string | null;
  readonly paymentPlan?: PaymentOption | null;
  readonly resources?: readonly unknown[];
  readonly source?: unknown;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ActionChoiceDependency {
  readonly choiceId: string;
  readonly equals?: unknown;
  readonly selected?: boolean | null;
}

export interface ActionChoiceRequest {
  readonly id: string;
  readonly type: ActionChoiceType;
  readonly label: string;
  readonly description: string | null;
  readonly required: boolean;
  readonly source: unknown;
  readonly predicate: Predicate | null;
  readonly dependsOn: readonly ActionChoiceDependency[];
  readonly conflictsWith: readonly string[];
  readonly min: ValueExpression | number | null;
  readonly max: ValueExpression | number | null;
  readonly options: readonly ActionChoiceOption[];
  readonly defaultValue: unknown;
  readonly payment?: {
    readonly status: string;
    readonly code: string;
    readonly defaultOptionId: string | null;
    readonly options: readonly unknown[];
    readonly failures: readonly unknown[];
  };
  readonly stateFingerprint: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly choiceDefinition: Readonly<Record<string, unknown>>;
}

export interface ActionChoiceSelection {
  readonly id: string;
  readonly type: ActionChoiceType;
  readonly value: unknown;
  readonly values?: readonly unknown[] | null;
  readonly optionId?: string | null;
  readonly label: string | null;
  readonly source: unknown;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ResolvedActionConfiguration {
  readonly id: string;
  readonly actionDefinitionId: string | null;
  readonly schemaVersion: number;
  readonly baseDefinition: ActionDefinition;
  readonly effectiveDefinition: ActionDefinition;
  readonly choices: readonly ActionChoiceSelection[];
  readonly selectedPayments: readonly PaymentOption[];
  readonly selectedPaymentPlan: PaymentOption | null;
  readonly selectedPaymentOptionId: string | null;
  readonly castingLevel: number | null;
  readonly optionSelections: readonly ActionChoiceSelection[];
  readonly selectedDamageTypes: Readonly<Record<string, string>>;
  readonly effectiveActionModes: readonly unknown[];
  readonly appliedConfigurationSources: readonly unknown[];
  readonly payment: {
    readonly discovery: PaymentDiscovery;
    readonly selectedPaymentOptionId: string | null;
    readonly selectedPaymentPlan: PaymentOption | null;
  };
  readonly trace: readonly unknown[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ResolvedActionPreview {
  readonly actionDefinitionId: string | null;
  readonly configurationId: string;
  readonly selectedOptions: readonly ActionChoiceSelection[];
  readonly costs: Readonly<Record<string, unknown>>;
  readonly actionEconomyPayments: readonly PaymentPlanResource[];
  readonly damage: Readonly<Record<string, unknown>>;
  readonly damageExpressions: readonly unknown[];
  readonly damageTypes: readonly unknown[];
  readonly healing: Readonly<Record<string, unknown>>;
  readonly range: RangeDefinition | null;
  readonly reach: unknown;
  readonly area: AreaDefinition | null;
  readonly targetCount: ValueExpression | number | null;
  readonly save: SaveDefinition | null;
  readonly check: CheckDefinition | null;
  readonly duration: DurationDefinition | null;
  readonly effects: readonly EffectApplicationDefinition[];
  readonly conditions: readonly EffectApplicationDefinition[];
  readonly resourceConsequences: readonly unknown[];
  readonly deltas: readonly unknown[];
  readonly trace: readonly unknown[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type ResolutionStateStatus =
  | "created"
  | "running"
  | "awaiting-configuration"
  | "awaiting-targets"
  | "awaiting-roll"
  | "awaiting-choice"
  | "paused"
  | "ready-to-commit"
  | "committing"
  | "completed"
  | "failed"
  | "cancelled";

export type ResolutionStageStatus =
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "skipped"
  | "failed"
  | "cancelled";

export type ResolutionStageResultType =
  | "continue"
  | "wait"
  | "fail"
  | "complete";

export type ResolutionRequestType =
  | "action-configuration"
  | "target-selection"
  | "target-refinement"
  | "roll"
  | "reaction-choice"
  | "choice"
  | (string & {});

export interface ResolutionRequest {
  readonly id: string;
  readonly resolutionId: string | null;
  readonly stageId: string | null;
  readonly type: ResolutionRequestType;
  readonly expectedResponseType: string | null;
  readonly validation: Readonly<Record<string, unknown>>;
  readonly chooser: unknown;
  readonly authority: unknown;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ResolutionResponse {
  readonly requestId: string | null;
  readonly resolutionId: string | null;
  readonly type: ResolutionRequestType | null;
  readonly value: unknown;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ResolutionRequestResponse {
  readonly request: ResolutionRequest;
  readonly response: ResolutionResponse;
}

export type PromptPortOutcomeStatus =
  | "response"
  | "declined"
  | "cancelled"
  | "failure"
  | "unhandled";

export interface PromptControlViewModel {
  readonly id: string;
  readonly choiceId?: string;
  readonly type: string;
  readonly choiceType?: string;
  readonly label: string;
  readonly description?: string | null;
  readonly required?: boolean;
  readonly min?: unknown;
  readonly max?: unknown;
  readonly defaultValue?: unknown;
  readonly options: readonly Readonly<Record<string, unknown>>[];
  readonly source?: unknown;
  readonly payment?: unknown;
  readonly stateFingerprint?: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface PromptViewModel {
  readonly schemaVersion: number;
  readonly id: string;
  readonly resolutionId: string | null;
  readonly requestId: string | null;
  readonly requestType: ResolutionRequestType;
  readonly expectedResponseType: string | null;
  readonly title: string;
  readonly required: boolean;
  readonly chooser: unknown;
  readonly authority: unknown;
  readonly controls: readonly PromptControlViewModel[];
  readonly payload: Readonly<Record<string, unknown>>;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface PromptPortResult {
  readonly ok: boolean;
  readonly status: PromptPortOutcomeStatus;
  readonly code: string;
  readonly reason?: string | null;
  readonly requestId?: string | null;
  readonly resolutionId?: string | null;
  readonly type?: ResolutionRequestType | null;
  readonly responseType?: string | null;
  readonly value?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface PromptPortContext {
  readonly state?: ResolutionState;
  readonly viewModel?: PromptViewModel;
  readonly currentUserId?: string | null;
  readonly currentUserRef?: string | null;
  readonly currentUser?: Readonly<Record<string, unknown>>;
  readonly isGM?: boolean;
  readonly localAuthorityKinds?: readonly string[];
  readonly authorityKinds?: readonly string[];
  readonly remoteAuthorityKinds?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface PromptPort {
  readonly id: string;
  readonly type?: string | null;
  readonly label?: string | null;
  canHandle?: (request: ResolutionRequest, context?: PromptPortContext) => boolean | {readonly ok?: boolean; readonly value?: boolean};
  request(request: ResolutionRequest, context?: PromptPortContext): Promise<PromptPortResult>;
}

export interface ChoiceCoordinatorResult {
  readonly ok: boolean;
  readonly status: PromptPortOutcomeStatus | string;
  readonly code: string;
  readonly reason?: string | null;
  readonly state: ResolutionState | null;
  readonly request?: ResolutionRequest | null;
  readonly response?: ResolutionResponse;
  readonly port?: Readonly<Record<string, unknown>> | null;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface ResolutionTraceEntry {
  readonly id: string;
  readonly stageId: string | null;
  readonly status: ResolutionStageStatus;
  readonly result: ResolutionStageResultType;
  readonly code: string;
  readonly reason: string | null;
  readonly requestIds: readonly string[];
  readonly data: Readonly<Record<string, unknown>>;
}

export interface ResolutionAncestryEntry {
  readonly id: string;
  readonly parentId: string | null;
  readonly relationship: string | null;
  readonly sourceEvent: unknown;
  readonly depth: number;
}

export interface ResolutionState {
  readonly schemaVersion: number;
  readonly id: string;
  readonly parentId: string | null;
  readonly relationship: string | null;
  readonly sourceEvent: unknown;
  readonly depth: number;
  readonly maxDepth: number;
  readonly ancestry: readonly ResolutionAncestryEntry[];
  readonly triggerIdentities: readonly string[];
  readonly actionDefinition: ActionDefinition | Readonly<Record<string, unknown>> | null;
  readonly source: unknown;
  readonly origin: unknown;
  readonly actionContext: ActionContext | Readonly<Record<string, unknown>> | null;
  readonly configuration: ResolvedActionConfiguration | Readonly<Record<string, unknown>> | null;
  readonly targets: readonly unknown[];
  readonly targetSet: unknown;
  readonly targetRefinement: unknown;
  readonly rollRequests: readonly ResolutionRequest[];
  readonly rollResults: readonly (RollResult | Readonly<Record<string, unknown>>)[];
  readonly outcomes: Readonly<Record<string, unknown>>;
  readonly results: Readonly<Record<string, unknown>>;
  readonly pendingRequests: readonly ResolutionRequest[];
  readonly requestResponses: Readonly<Record<string, ResolutionRequestResponse>>;
  readonly responses: readonly ResolutionResponse[];
  readonly mutationPlans: readonly MutationPlan[];
  readonly events: readonly AutomationEvent[];
  readonly currentStageId: string | null;
  readonly completedStageIds: readonly string[];
  readonly stageStatuses: Readonly<Record<string, ResolutionStageStatus | string>>;
  readonly status: ResolutionStateStatus;
  readonly trace: readonly ResolutionTraceEntry[];
  readonly validation: readonly unknown[];
  readonly errors: readonly unknown[];
  readonly warnings: readonly unknown[];
  readonly input: Readonly<Record<string, unknown>>;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ResolutionStageResult {
  readonly type: ResolutionStageResultType;
  readonly state?: ResolutionState | null;
  readonly status?: ResolutionStateStatus | null;
  readonly code?: string;
  readonly reason?: string | null;
  readonly requests?: readonly ResolutionRequest[];
  readonly errors?: readonly unknown[];
  readonly data?: Readonly<Record<string, unknown>>;
  readonly trace?: readonly ResolutionTraceEntry[];
  readonly nextStageId?: string | null;
}

export interface ResolutionPipelineStage {
  readonly id: string;
  readonly canRun?: ((state: ResolutionState, services?: unknown) => boolean | {readonly ok?: boolean; readonly value?: boolean; readonly run?: boolean; readonly reason?: string | null}) | null;
  readonly run: (state: ResolutionState, services?: unknown) => ResolutionStageResult | ResolutionState | ResolverFailure;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ResolutionPipelineResult {
  readonly ok: boolean;
  readonly code: string;
  readonly status: ResolutionStateStatus;
  readonly waiting: boolean;
  readonly completed: boolean;
  readonly state: ResolutionState;
}

export interface ResolutionSerializableValidationResult {
  readonly ok: boolean;
  readonly code: string;
  readonly path: string | null;
  readonly reason: string | null;
}

export type RollRequestId = string;

export type SemanticRollType =
  | "attack"
  | "saving-throw"
  | "ability-check"
  | "skill-check"
  | "damage"
  | "healing"
  | "initiative"
  | "concentration"
  | "death-save"
  | "custom"
  | (string & {});

export type RollMode = "normal" | "advantage" | "disadvantage";

export type RollVisibilityPolicy =
  | "system"
  | "public"
  | "private"
  | "self"
  | "gm-only"
  | "blind"
  | (string & {});

export type RollAuthorityKind =
  | "source-controller"
  | "target-controller"
  | "gm"
  | "automatic"
  | "specific"
  | (string & {});

export type RollInputMode = "natural" | "total" | "structured" | (string & {});

export type RollProvenanceType =
  | "foundry-digital"
  | "manual"
  | "physical"
  | "fake"
  | "imported"
  | "unknown"
  | (string & {});

export type RollProviderOutcomeStatus = "result" | "pending" | "failure" | "cancelled";

export interface RollDieTermDefinition {
  readonly id: string;
  readonly number: number;
  readonly faces: number;
  readonly modifiers: readonly string[];
  readonly purpose: string | null;
  readonly source: unknown;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RollDefinition {
  readonly formula: string | null;
  readonly expression: ValueExpression | Readonly<Record<string, unknown>> | null;
  readonly dice: readonly RollDieTermDefinition[];
  readonly terms: readonly unknown[];
  readonly modifierTotal: number | null;
  readonly components: readonly unknown[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RollModifier {
  readonly id: string;
  readonly value: number;
  readonly label: string | null;
  readonly source: unknown;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RollDC {
  readonly value: number | null;
  readonly slug: string;
  readonly ability?: string | null;
  readonly source: unknown;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RollAuthority {
  readonly kind?: RollAuthorityKind;
  readonly providerId?: string | null;
  readonly userRef?: EntityRef | string | null;
  readonly actorRef?: EntityRef | string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RollExpectedResult {
  readonly primaryDieFaces: number | null;
  readonly requireNatural: boolean;
  readonly manualInputMode: RollInputMode;
  readonly validateTotalFromNatural: boolean;
  readonly modifierTotal: number | null;
  readonly staleAfterStageId: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RollProvenance {
  readonly type: RollProvenanceType;
  readonly providerId: string | null;
  readonly method: string | null;
  readonly userRef: EntityRef | string | null;
  readonly authority: unknown;
  readonly source: unknown;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RollRequest {
  readonly schemaVersion: number;
  readonly id: RollRequestId;
  readonly resolutionId: string | null;
  readonly type: SemanticRollType;
  readonly formula: string | null;
  readonly data: Readonly<Record<string, unknown>>;
  readonly definition: RollDefinition;
  readonly modifiers: readonly RollModifier[];
  readonly rollMode: RollMode;
  readonly dc: RollDC | null;
  readonly visibility: RollVisibilityPolicy;
  readonly chooser: unknown;
  readonly authority: RollAuthority | unknown;
  readonly source: unknown;
  readonly target: unknown;
  readonly provenance: RollProvenance;
  readonly expected: RollExpectedResult;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RollDieResult {
  readonly index: number;
  readonly result: number | null;
  readonly active: boolean;
  readonly discarded: boolean;
  readonly rerolled: boolean;
  readonly exploded: boolean;
  readonly critical: boolean;
  readonly fumble: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RollDieResultGroup {
  readonly id: string;
  readonly number: number;
  readonly faces: number;
  readonly modifiers: readonly string[];
  readonly purpose: string | null;
  readonly results: readonly RollDieResult[];
  readonly source: unknown;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RollProviderReference {
  readonly id: string | null;
  readonly type: RollProvenanceType;
  readonly label: string | null;
}

export interface RollValidationResult {
  readonly ok: boolean;
  readonly code: string;
  readonly reason: string | null;
  readonly path: string | null;
  readonly request?: RollRequest;
  readonly result?: RollResult;
}

export interface RollResult {
  readonly schemaVersion: number;
  readonly requestId: RollRequestId;
  readonly resolutionId: string | null;
  readonly type: SemanticRollType;
  readonly total: number;
  readonly natural: number | null;
  readonly dice: readonly RollDieResultGroup[];
  readonly formula: string | null;
  readonly terms: readonly unknown[];
  readonly modifiers: readonly RollModifier[];
  readonly rollMode: RollMode;
  readonly provider: RollProviderReference;
  readonly provenance: RollProvenance;
  readonly validation: {
    readonly ok: boolean;
    readonly code: string;
    readonly reason: string | null;
  };
  readonly raw: unknown;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RollProviderContext {
  readonly providerId?: string | null;
  readonly preferredProviderId?: string | null;
  readonly policy?: Readonly<Record<string, unknown>>;
  readonly manualResults?: unknown;
  readonly physicalRolls?: unknown;
  readonly suppliedRolls?: unknown;
  readonly completedRequestIds?: readonly RollRequestId[];
  readonly authority?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RollProviderPendingResult {
  readonly ok: false;
  readonly status: "pending";
  readonly code: string;
  readonly reason: string | null;
  readonly request: RollRequest;
  readonly provider: RollProviderReference;
  readonly inputRequest: Readonly<Record<string, unknown>>;
}

export interface RollProviderFailureResult {
  readonly ok: false;
  readonly status: "failure" | "cancelled";
  readonly code: string;
  readonly reason: string | null;
  readonly request?: RollRequest | null;
  readonly provider?: RollProviderReference | null;
  readonly validation?: RollValidationResult | null;
}

export interface RollProviderSuccessResult {
  readonly ok: true;
  readonly status: "result";
  readonly code: "OK" | string;
  readonly request: RollRequest;
  readonly provider: RollProviderReference;
  readonly result: RollResult;
  readonly validation?: RollValidationResult;
}

export type RollProviderExecutionResult =
  | RollProviderSuccessResult
  | RollProviderPendingResult
  | RollProviderFailureResult;

export interface RollProvider {
  readonly id: string;
  readonly type: RollProvenanceType | string;
  readonly label?: string | null;
  canHandle(request: RollRequest, context?: RollProviderContext): boolean;
  execute(request: RollRequest, context?: RollProviderContext): Promise<RollProviderExecutionResult>;
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
