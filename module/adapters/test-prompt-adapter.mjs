import {
  CHOICE_COORDINATOR_CODES,
  PROMPT_PORT_OUTCOMES
} from "../resolvers/choice-coordinator.mjs";
import {clonePromptData, createPromptViewModel} from "../helpers/prompt-view-models.mjs";

export function createTestPromptAdapter({
  id="test-prompt",
  label="Test Prompt Adapter",
  type="test",
  responses={},
  queue=[],
  canHandle=null
}={}) {
  const queued = [...queue];
  const keyed = responses;
  return {
    id,
    type,
    label,
    canHandle(request, context={}) {
      if ( typeof canHandle === "function" ) return canHandle(request, context);
      return true;
    },
    async request(request, context={}) {
      const response = responseForRequest({request, context, responses: keyed, queue: queued});
      if ( response === undefined ) return {
        ok: false,
        status: PROMPT_PORT_OUTCOMES.FAILURE,
        code: CHOICE_COORDINATOR_CODES.PROMPT_PORT_FAILURE,
        reason: `No test prompt response for request ${request.id}.`,
        requestId: request.id,
        resolutionId: request.resolutionId,
        type: request.type,
        responseType: request.expectedResponseType,
        metadata: {
          adapterId: id,
          viewModel: createPromptViewModel(request, context).id
        }
      };
      const value = typeof response === "function"
        ? await response(request, context)
        : response;
      if ( isPromptResult(value) ) return {
        requestId: request.id,
        resolutionId: request.resolutionId,
        type: request.type,
        responseType: request.expectedResponseType,
        ...value,
        metadata: {
          adapterId: id,
          ...(clonePromptData(value.metadata ?? {}, "testPrompt.metadata") ?? {})
        }
      };
      return {
        ok: true,
        status: PROMPT_PORT_OUTCOMES.RESPONSE,
        code: CHOICE_COORDINATOR_CODES.OK,
        requestId: request.id,
        resolutionId: request.resolutionId,
        type: request.type,
        responseType: request.expectedResponseType,
        value: clonePromptData(value, "testPrompt.value"),
        metadata: {
          adapterId: id,
          viewModel: createPromptViewModel(request, context).id
        }
      };
    }
  };
}

function responseForRequest({request, context, responses, queue}) {
  const scopedKey = `${request.resolutionId}:${request.id}`;
  if ( Object.hasOwn(responses ?? {}, scopedKey) ) return responses[scopedKey];
  if ( Object.hasOwn(responses ?? {}, request.id) ) return responses[request.id];
  if ( request.resolutionId && Object.hasOwn(responses ?? {}, request.resolutionId) ) {
    const scoped = responses[request.resolutionId];
    if ( scoped && typeof scoped === "object" && Object.hasOwn(scoped, request.id) ) return scoped[request.id];
  }
  if ( context.response !== undefined ) return context.response;
  if ( context.responses && Object.hasOwn(context.responses, scopedKey) ) return context.responses[scopedKey];
  if ( context.responses && Object.hasOwn(context.responses, request.id) ) return context.responses[request.id];
  return queue.length ? queue.shift() : undefined;
}

function isPromptResult(value) {
  return value
    && typeof value === "object"
    && (
      value.ok != null
      || value.status != null
      || value.requestId != null
      || value.resolutionId != null
      || value.type != null
      || value.responseType != null
      || Object.hasOwn(value, "value")
      || Object.hasOwn(value, "result")
      || Object.hasOwn(value, "response")
    );
}
