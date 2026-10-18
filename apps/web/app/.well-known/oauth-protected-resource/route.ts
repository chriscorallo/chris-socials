import { protectedResourceMetadataResponse } from "../../../lib/chatgpt-mcp/oauth-routes";
import { corsPreflight } from "../../../lib/chatgpt-mcp/config";

/** RFC 9728 protected resource metadata (root form). See lib/chatgpt-mcp. */
export const dynamic = "force-dynamic";
export const GET = protectedResourceMetadataResponse;
export const OPTIONS = corsPreflight;
