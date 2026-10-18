import { handleMcpRequest } from "../../../lib/chatgpt-mcp/server";
import { corsPreflight } from "../../../lib/chatgpt-mcp/config";

/** The ChatGPT connector's MCP endpoint (Streamable HTTP, stateless, OAuth bearer tokens).
 * See apps/web/lib/chatgpt-mcp/server.ts and docs/decisions-pending/chatgpt-connector.md. */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  return handleMcpRequest(request);
}

export async function GET(request: Request) {
  return handleMcpRequest(request);
}

export async function DELETE(request: Request) {
  return handleMcpRequest(request);
}

export function OPTIONS() {
  return corsPreflight();
}
