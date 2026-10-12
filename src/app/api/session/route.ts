/**
 * /api/session: judge access sessions. GET reports the session state, POST
 * exchanges the access code for an HttpOnly session cookie and DELETE ends
 * the session. The work happens in src/server/sessionHandler.ts.
 */
import { defaultSessionDeps, handleSessionDelete, handleSessionGet, handleSessionPost } from "@/server/sessionHandler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One attempt limiter per server instance.
const deps = defaultSessionDeps();

export async function GET(request: Request): Promise<Response> {
  return handleSessionGet(request, deps);
}

export async function POST(request: Request): Promise<Response> {
  return handleSessionPost(request, deps);
}

export async function DELETE(request: Request): Promise<Response> {
  return handleSessionDelete(request, deps);
}
