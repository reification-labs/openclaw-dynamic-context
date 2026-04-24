// index.ts — OpenClaw context engine plugin entry point.
// Delegates to engine.ts for testable logic.

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { assemble, type AssembleInput } from "./engine.js";
import { join } from "node:path";

export default definePluginEntry({
  id: "dynamic-context",
  name: "Dynamic Context Engine",
  description: "Tiers memory into include/reference/off via context.yaml",
  kind: "context-engine",

  register(api) {
    // Resolve paths from plugin config or workspace convention
    const workspaceDir = (api.pluginConfig?.workspaceDir as string) ?? process.cwd();
    const contextYamlPath = (api.pluginConfig?.contextYamlPath as string) ?? join(workspaceDir, "context.yaml");
    const threadsDir = (api.pluginConfig?.threadsDir as string) ?? join(workspaceDir, "threads");

    api.registerContextEngine("dynamic-context", () => ({
      info: {
        id: "dynamic-context",
        name: "Dynamic Context Engine",
        ownsCompaction: false, // delegate to OpenClaw's built-in summarization
      },

      async ingest() {
        // No-op for now — we read context.yaml fresh on each assemble
        return { ingested: true };
      },

      async assemble({ messages, tokenBudget }) {
        const input: AssembleInput = {
          contextYamlPath,
          threadsDir,
          workspaceDir,
        };

        const result = await assemble(input);

        api.logger.debug(
          `assemble: ${result.includedThreads.length} included, ` +
          `${result.referencedThreads.length} referenced, ` +
          `${result.skippedThreads.length} skipped, ` +
          `${result.systemPromptAddition.length} chars injected`
        );

        if (result.skippedThreads.length > 0) {
          api.logger.warn(`Skipped threads with missing files: ${result.skippedThreads.join(", ")}`);
        }

        return {
          messages,
          estimatedTokens: tokenBudget, // pass through; OpenClaw handles token counting
          systemPromptAddition: result.systemPromptAddition || undefined,
        };
      },

      async compact() {
        // Delegate to built-in compaction (ownsCompaction: false)
        // This should not be reached, but just in case:
        return { ok: true, compacted: false };
      },

      async afterTurn() {
        // Future: check if agent edited context.yaml, track access patterns
      },
    }));
  },
});
