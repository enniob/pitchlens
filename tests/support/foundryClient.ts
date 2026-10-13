/**
 * The live adapter from `@azure/ai-projects` to the narrow `EvalsApi` in
 * ./foundryEval.ts. Dev/test-only: imported dynamically by the opt-in live
 * runners, never by application code, so the production bundle carries
 * neither `@azure/ai-projects` nor `@azure/identity`.
 *
 * Authentication is `DefaultAzureCredential` (locally, `az login`); no key is
 * read or added. The caller needs the Foundry User role on the project.
 */
import type { EvalOutputItem, EvalRunState, EvalsApi } from "./foundryEval";

export const FOUNDRY_EVAL_SDK = "@azure/ai-projects 2.7.1, @azure/identity 4.13.3, openai (evals API via getOpenAIClient)";

export async function createEvalsApi(projectEndpoint: string): Promise<EvalsApi> {
  const [{ AIProjectClient }, { DefaultAzureCredential }] = await Promise.all([import("@azure/ai-projects"), import("@azure/identity")]);
  const openai = new AIProjectClient(projectEndpoint, new DefaultAzureCredential()).getOpenAIClient();
  return {
    // `azure_ai_evaluator` criteria are a Foundry extension the OpenAI types do not list.
    create: (body) => openai.evals.create(body as Parameters<typeof openai.evals.create>[0]),
    createRun: async (evalId, body) =>
      (await openai.evals.runs.create(evalId, body as Parameters<typeof openai.evals.runs.create>[1])) as unknown as EvalRunState,
    retrieveRun: async (evalId, runId) => (await openai.evals.runs.retrieve(runId, { eval_id: evalId })) as unknown as EvalRunState,
    listOutputItems: (evalId, runId) => openai.evals.runs.outputItems.list(runId, { eval_id: evalId }) as unknown as AsyncIterable<EvalOutputItem>,
  };
}
