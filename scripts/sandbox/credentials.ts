import { existsSync } from "node:fs";
import { config } from "dotenv";

/**
 * Credentials for operator scripts that talk to Vercel Sandbox from a laptop. On Vercel the SDK
 * uses OIDC automatically; locally it needs VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID.
 * SANDBOX_ENV_FILE points at a dotenv file holding VERCEL_TOKEN (never printed); the team and
 * project default to this product's Vercel project.
 */
export const DEFAULT_TEAM_ID = "team_CymMudtT4A4Q7D2pHpYjRYzz";
export const DEFAULT_PROJECT_ID = "prj_Lpfb2ByCfy7GFtBNa95VLSL7vSCp";

export function loadSandboxCredentials(): { token: string; teamId: string; projectId: string } {
  const file = process.env.SANDBOX_ENV_FILE;
  if (file && existsSync(file)) config({ path: file, quiet: true, override: false });
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error("VERCEL_TOKEN is not set (set it, or SANDBOX_ENV_FILE=<dotenv file containing it>).");
  return {
    token,
    teamId: process.env.VERCEL_TEAM_ID || DEFAULT_TEAM_ID,
    projectId: process.env.VERCEL_PROJECT_ID || DEFAULT_PROJECT_ID,
  };
}
