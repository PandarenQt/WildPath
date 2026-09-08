import { createResolutionState, runResolutionPipeline, resumeResolutionPipeline, updateResolutionState } from "../helpers/resolution-state.mjs";
import { createReactionWindowStage, completeReactionChildResolution } from "./reaction-resolver.mjs";
import { createActionReactionChildState } from "./action-pipeline-resolver.mjs";
const STAGE = "event.reactions";
/** An event has no Action cost, targeting, or commit. Its children are ordinary staged Actions. */
export function createTriggeredEventHost({ event, services = {} }) {
    if (!event.id)
        throw new Error("A triggered event host requires a canonical event ID.");
    const stages = [createReactionWindowStage({
            id: STAGE,
            timing: "after-event",
            event,
            discovery: ({ state, services: current }) => {
                const options = current.reactions;
                const resolve = (value) => typeof value === "function" ? value({ state, event, services: current }) : value;
                return { ...options, triggers: resolve(options?.triggers) ?? [],
                    resourcesByActor: resolve(options?.resourcesByActor) ?? {},
                    controllerUserIdsByActor: resolve(options?.controllerUserIdsByActor) ?? {} };
            },
            createChildState: createActionReactionChildState
        })];
    return {
        state: createResolutionState({ id: `event-host:${event.id}`, sourceEvent: event, source: event.source,
            metadata: { host: "triggered-event" } }),
        services,
        plan: ({ state, services: current = services }) => runResolutionPipeline({ state, stages, services: current }),
        resume: ({ state, response, services: current = services }) => resumeResolutionPipeline({ state, response, stages, services: current }),
        completeChild: (options) => {
            const result = completeReactionChildResolution(options);
            if (result.state.status !== "running")
                return result;
            // Re-enter the same window so ReactionResolver offers the next ordered group.
            // Its handled IDs survive both declines and accepted children.
            return { ...result, state: updateResolutionState(result.state, {
                    currentStageId: STAGE,
                    completedStageIds: result.state.completedStageIds.filter((id) => id !== STAGE)
                }) };
        }
    };
}
