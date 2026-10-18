import { protectedResourceMetadataResponse } from "../../../../../lib/chatgpt-mcp/oauth-routes";
import { corsPreflight } from "../../../../../lib/chatgpt-mcp/config";

/** RFC 9728 protected resource metadata for the resource at /api/mcp (path-suffixed form). */
export const dynamic = "force-dynamic";
export const GET = protectedResourceMetadataResponse;
export const OPTIONS = corsPreflight;
