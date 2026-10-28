#!/usr/bin/env node
import { AgentError, runAgentQuestion } from "./agent.js";
import { createConfiguredMcpGateway } from "./agent-mcp.js";
import { createOpenAIModelRouter, isRetryableOpenAIError, MAX_MODEL_OUTPUT_TOKENS, openAIErrorCategory } from "./openai-model-router.js";
import { modelMaximumAttempts, ReliableModelSelector } from "./reliable-model-selector.js";

const abortController = new AbortController();
const interrupt = (): void => abortController.abort();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);

try {
  const argumentsValue = process.argv.slice(2);
  if (argumentsValue.length !== 1) throw new AgentError("invalid_question");
  const router = new ReliableModelSelector(createOpenAIModelRouter(), {
    maximumAttempts: modelMaximumAttempts(),
    isRetryable: isRetryableOpenAIError,
    failureCategory: openAIErrorCategory,
    outputTokenLimit: MAX_MODEL_OUTPUT_TOKENS,
  });
  const gateway = await createConfiguredMcpGateway();
  const output = await runAgentQuestion(argumentsValue[0] as string, router, gateway, abortController.signal);
  if (!abortController.signal.aborted) console.log(output);
} catch (error: unknown) {
  console.error(error instanceof AgentError ? error.message : "The secure shipment request could not be completed.");
  process.exitCode = abortController.signal.aborted ? 130 : 1;
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
