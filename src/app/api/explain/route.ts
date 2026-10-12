/**
 * POST /api/explain: "Explain this moment". The contract is in
 * src/explain/api.ts and docs/explain-service.md; the work happens in
 * src/server/explainHandler.ts. Model credentials are read from server
 * environment variables and never reach the browser.
 */
import { defaultDeps, handleExplain } from "@/server/explainHandler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 75;

// One set of limits and caches per server instance.
const deps = defaultDeps();

export async function POST(request: Request): Promise<Response> {
  return handleExplain(request, deps);
}
