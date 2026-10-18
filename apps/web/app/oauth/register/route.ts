import { registerResponse } from "../../../lib/chatgpt-mcp/oauth-routes";
import { corsPreflight } from "../../../lib/chatgpt-mcp/config";

/** RFC 7591 dynamic client registration (public PKCE clients, ChatGPT redirect URIs only). */
export const dynamic = "force-dynamic";
export const POST = registerResponse;
export const OPTIONS = corsPreflight;
