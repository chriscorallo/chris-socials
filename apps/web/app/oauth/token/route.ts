import { tokenResponse } from "../../../lib/chatgpt-mcp/oauth-routes";
import { corsPreflight } from "../../../lib/chatgpt-mcp/config";

/** OAuth token endpoint: authorization_code (+PKCE) and refresh_token grants. */
export const dynamic = "force-dynamic";
export const POST = tokenResponse;
export const OPTIONS = corsPreflight;
