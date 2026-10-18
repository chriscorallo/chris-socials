import { revokeResponse } from "../../../lib/chatgpt-mcp/oauth-routes";
import { corsPreflight } from "../../../lib/chatgpt-mcp/config";

/** RFC 7009 token revocation (revokes the whole grant). */
export const dynamic = "force-dynamic";
export const POST = revokeResponse;
export const OPTIONS = corsPreflight;
