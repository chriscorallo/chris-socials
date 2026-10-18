import { authorizationServerMetadataResponse } from "../../../lib/chatgpt-mcp/oauth-routes";
import { corsPreflight } from "../../../lib/chatgpt-mcp/config";

/** RFC 8414 authorization server metadata for the ChatGPT connector. */
export const dynamic = "force-dynamic";
export const GET = authorizationServerMetadataResponse;
export const OPTIONS = corsPreflight;
