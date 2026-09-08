import type {AutomationEvent, ResolutionState, ResolutionPipelineStage} from "../types/contracts.js";
import {
  createResolutionState, runResolutionPipeline, resumeResolutionPipeline, updateResolutionState
} from "../helpers/resolution-state.mjs";
import {createReactionWindowStage, completeReactionChildResolution} from "./reaction-resolver.mjs";
import {createActionReactionChildState} from "./action-pipeline-resolver.mjs";

type State = ResolutionState;
type Services = Record<string, unknown>;
export interface ReactionStageOptions {
  id?: string;
  timing?: string;
  event?: AutomationEvent | null;
  eventSelector?: ((state: State, services: Services) => AutomationEvent | null) | null;
  discovery?: ((context: {state: State; services: Services; event: AutomationEvent}) => object) | object | null;
  createChildState?: typeof createActionReactionChildState | null;
  metadata?: Record<string, unknown>;
}
const STAGE = "event.reactions";

/** An event has no Action cost, targeting, or commit. Its children are ordinary staged Actions. */
export function createTriggeredEventHost({event, services = {}}: {event: AutomationEvent; services?: Services}) {
  if ( !event.id ) throw new Error("A triggered event host requires a canonical event ID.");
  const stages: ResolutionPipelineStage[] = [createReactionWindowStage({
    id: STAGE,
    timing: "after-event",
    event,
    discovery: ({state, services: current}: {state: State; services: Record<string, unknown>}) => {
      const options = current.reactions as Record<string, unknown> | undefined;
      const resolve = (value: unknown): unknown => typeof value === "function" ? value({state, event, services: current}) : value;
      return {...options, triggers: resolve(options?.triggers) ?? [],
        resourcesByActor: resolve(options?.resourcesByActor) ?? {},
        controllerUserIdsByActor: resolve(options?.controllerUserIdsByActor) ?? {}};
    },
    createChildState: createActionReactionChildState
  })];
  return {
    state: createResolutionState({id: `event-host:${event.id}`, sourceEvent: event, source: event.source,
      metadata: {host: "triggered-event"}}),
    services,
    plan: ({state, services: current = services}: {state: State; services?: Services}) =>
      runResolutionPipeline({state, stages, services: current}),
    resume: ({state, response, services: current = services}: {
      state: State; response: unknown; services?: Services;
    }) => resumeResolutionPipeline({state, response, stages, services: current}),
    completeChild: (options: Parameters<typeof completeReactionChildResolution>[0]) => {
      const result = completeReactionChildResolution(options);
      if ( result.state.status !== "running" ) return result;
      // Re-enter the same window so ReactionResolver offers the next ordered group.
      // Its handled IDs survive both declines and accepted children.
      return {...result, state: updateResolutionState(result.state, {
        currentStageId: STAGE,
        completedStageIds: result.state.completedStageIds.filter((id: string) => id !== STAGE)
      })};
    }
  };
}
