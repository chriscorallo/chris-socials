import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { loadPromptRegistry, getActivePrompt, PromptRegistryError } from "../registry";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const SHARED_DIR = join(REPO_ROOT, "prompts", "shared");
const AGENTS_DIR = join(REPO_ROOT, "prompts", "agents");

describe("prompt registry", () => {
  it("loads every real prompt file under /prompts/shared and /prompts/agents", () => {
    const prompts = loadPromptRegistry([SHARED_DIR, AGENTS_DIR]);
    expect(prompts.length).toBeGreaterThan(15);
    expect(getActivePrompt(prompts, "SYSTEM_BASE")).toBeDefined();
    expect(getActivePrompt(prompts, "CREATIVE_DIRECTOR")).toBeDefined();
    expect(getActivePrompt(prompts, "CLAIMS_GATE")).toBeDefined();
  });

  it("every real prompt file has exactly one active version per prompt_id", () => {
    // loadPromptRegistry itself throws if this invariant is violated — reaching this line
    // without throwing is the assertion.
    expect(() => loadPromptRegistry([SHARED_DIR, AGENTS_DIR])).not.toThrow();
  });

  it("rejects a deliberately malformed prompt fixture (missing frontmatter)", () => {
    const dir = mkdtempSync(join(tmpdir(), "prompt-fixture-"));
    try {
      writeFileSync(join(dir, "BROKEN.md"), "# No frontmatter here\n\nJust a body.");
      expect(() => loadPromptRegistry([dir])).toThrow(PromptRegistryError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects two active versions sharing the same prompt_id", () => {
    const dir = mkdtempSync(join(tmpdir(), "prompt-fixture-"));
    try {
      const frontmatter = (id: string) => `---
prompt_id: ${id}
version: 1.0.0
role: Test
model_class: LOW
active: true
eval_status: unevaluated
rollback_version: null
---

body`;
      writeFileSync(join(dir, "A.md"), frontmatter("DUPLICATE_ID"));
      writeFileSync(join(dir, "B.md"), frontmatter("DUPLICATE_ID"));
      expect(() => loadPromptRegistry([dir])).toThrow(PromptRegistryError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid frontmatter (bad model_class)", () => {
    const dir = mkdtempSync(join(tmpdir(), "prompt-fixture-"));
    try {
      writeFileSync(
        join(dir, "BAD.md"),
        `---
prompt_id: BAD
version: 1.0.0
role: Test
model_class: SUPER_HIGH
active: true
eval_status: unevaluated
rollback_version: null
---

body`,
      );
      expect(() => loadPromptRegistry([dir])).toThrow(PromptRegistryError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
