// engine.test.ts — node:test based tests for the context engine logic.
// Run: node --test engine.test.ts

import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assemble } from "./engine.js";

// ---------------------------------------------------------------------------
// Test harness — creates temp workspace with threads/ and context.yaml
// ---------------------------------------------------------------------------

let tmpDir: string;
let threadsDir: string;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `dce-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  threadsDir = join(tmpDir, "threads");
  await mkdir(threadsDir, { recursive: true });
});

async function writeThread(name: string, content: string, frontmatter?: Record<string, unknown>) {
  const fm = frontmatter
    ? `---\n${Object.entries(frontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}\n---\n\n`
    : "";
  await writeFile(join(threadsDir, name), fm + content);
}

async function writeContextYaml(yaml: string) {
  await writeFile(join(tmpDir, "context.yaml"), yaml);
}

async function writeWorkspaceFile(path: string, content: string) {
  await writeFile(join(tmpDir, path), content);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assemble", () => {
  test("include tier injects full thread content", async () => {
    await writeThread("sealed-sender-inference.md", "# Sealed Sender\n\nBody content here", {
      summary: "Privacy-preserving decentralized inference",
      state: "include",
    });
    await writeContextYaml(`
version: 2
threads:
  sealed-sender-inference: include
`);

    const result = await assemble({
      contextYamlPath: join(tmpDir, "context.yaml"),
      threadsDir,
      workspaceDir: tmpDir,
    });

    assert.ok(result.systemPromptAddition.includes("Sealed Sender"));
    assert.ok(result.systemPromptAddition.includes("Body content here"));
    assert.deepEqual(result.includedThreads, ["sealed-sender-inference"]);
    assert.deepEqual(result.referencedThreads, []);
  });

  test("reference tier shows only summary line", async () => {
    await writeThread("event-sourced-mapreduce.md", "# The Pipe\n\nLots of detail here", {
      summary: "OOO bot to agentic map-reduce product",
    });
    await writeContextYaml(`
version: 2
threads:
  event-sourced-mapreduce: reference
`);

    const result = await assemble({
      contextYamlPath: join(tmpDir, "context.yaml"),
      threadsDir,
      workspaceDir: tmpDir,
    });

    assert.ok(result.systemPromptAddition.includes("OOO bot"));
    assert.ok(!result.systemPromptAddition.includes("Lots of detail here"));
    assert.deepEqual(result.referencedThreads, ["event-sourced-mapreduce"]);
    assert.deepEqual(result.includedThreads, []);
  });

  test("off tier produces nothing", async () => {
    await writeThread("mirror-in-the-machine.md", "# Mirrors\n\nContent", {
      summary: "AI as mirror for self-reflection",
    });
    await writeContextYaml(`
version: 2
threads:
  mirror-in-the-machine: off
`);

    const result = await assemble({
      contextYamlPath: join(tmpDir, "context.yaml"),
      threadsDir,
      workspaceDir: tmpDir,
    });

    assert.equal(result.systemPromptAddition, "");
    assert.deepEqual(result.includedThreads, []);
    assert.deepEqual(result.referencedThreads, []);
  });

  test("missing thread file is skipped gracefully", async () => {
    await writeContextYaml(`
version: 2
threads:
  exists: include
  ghost: include
`);
    await writeThread("exists.md", "content");

    const result = await assemble({
      contextYamlPath: join(tmpDir, "context.yaml"),
      threadsDir,
      workspaceDir: tmpDir,
    });

    assert.deepEqual(result.includedThreads, ["exists"]);
    assert.deepEqual(result.skippedThreads, ["ghost"]);
  });

  test("missing or empty context.yaml returns empty", async () => {
    const result = await assemble({
      contextYamlPath: join(tmpDir, "nonexistent.yaml"),
      threadsDir,
      workspaceDir: tmpDir,
    });

    assert.equal(result.systemPromptAddition, "");
  });

  test("mixed tiers produce correct sections", async () => {
    await writeThread("left-hand-path.md", "# LHP\n\nSelf-knowledge content", {
      summary: "AI self-knowledge over service",
    });
    await writeThread("reify-studio.md", "# Studio\n\nBuild details", {
      summary: "Ash-based dev environment",
    });
    await writeThread("claw-code-elixir.md", "# Old thing\n\nArchive", {
      summary: "Elixir coding with Claude",
    });
    await writeContextYaml(`
version: 2
threads:
  left-hand-path: include
  reify-studio: reference
  claw-code-elixir: off
`);

    const result = await assemble({
      contextYamlPath: join(tmpDir, "context.yaml"),
      threadsDir,
      workspaceDir: tmpDir,
    });

    // Included thread shows full content
    assert.ok(result.systemPromptAddition.includes("Self-knowledge content"));
    // Referenced thread shows summary only
    assert.ok(result.systemPromptAddition.includes("Ash-based dev environment"));
    assert.ok(!result.systemPromptAddition.includes("Build details"));
    // Off thread absent entirely
    assert.ok(!result.systemPromptAddition.includes("Archive"));
    assert.deepEqual(result.includedThreads, ["left-hand-path"]);
    assert.deepEqual(result.referencedThreads, ["reify-studio"]);
  });

  test("thread with no frontmatter works", async () => {
    await writeThread("no-fm.md", "# Plain Thread\n\nNo frontmatter here.");
    await writeContextYaml(`
version: 2
threads:
  no-fm: include
`);

    const result = await assemble({
      contextYamlPath: join(tmpDir, "context.yaml"),
      threadsDir,
      workspaceDir: tmpDir,
    });

    assert.ok(result.systemPromptAddition.includes("Plain Thread"));
    assert.ok(result.systemPromptAddition.includes("No frontmatter here."));
    assert.deepEqual(result.includedThreads, ["no-fm"]);
  });

  test("reference tier with no summary shows fallback", async () => {
    await writeThread("no-summary.md", "# No Summary\n\nContent");
    await writeContextYaml(`
version: 2
threads:
  no-summary: reference
`);

    const result = await assemble({
      contextYamlPath: join(tmpDir, "context.yaml"),
      threadsDir,
      workspaceDir: tmpDir,
    });

    assert.ok(result.systemPromptAddition.includes("(no summary)"));
    assert.ok(!result.systemPromptAddition.includes("Content"));
  });

  test("workspace file with include tier is injected", async () => {
    await writeFile(join(tmpDir, "context.yaml"), `
version: 2
files:
  STEEP.md: include
`);
    await writeWorkspaceFile("STEEP.md", "# Currently Steeping\n\nSome steeping content");

    const result = await assemble({
      contextYamlPath: join(tmpDir, "context.yaml"),
      threadsDir,
      workspaceDir: tmpDir,
    });

    assert.ok(result.systemPromptAddition.includes("Currently Steeping"));
    assert.ok(result.systemPromptAddition.includes("Some steeping content"));
    assert.deepEqual(result.includedFiles, ["STEEP.md"]);
  });

  test("workspace file with reference tier shows placeholder", async () => {
    await writeFile(join(tmpDir, "context.yaml"), `
version: 2
files:
  MODELS.md: reference
`);
    await writeWorkspaceFile("MODELS.md", "# Models\n\nSome model info");

    const result = await assemble({
      contextYamlPath: join(tmpDir, "context.yaml"),
      threadsDir,
      workspaceDir: tmpDir,
    });

    assert.ok(result.systemPromptAddition.includes("MODELS.md"));
    assert.ok(result.systemPromptAddition.includes("reference"));
  });

  test("directory-style thread (index.md) is resolved", async () => {
    await mkdir(join(threadsDir, "media-empire"));
    await writeFile(join(threadsDir, "media-empire", "index.md"), "# Media Empire\n\nContent", {
      flag: "w",
    });
    await writeContextYaml(`
version: 2
threads:
  media-empire: include
`);

    const result = await assemble({
      contextYamlPath: join(tmpDir, "context.yaml"),
      threadsDir,
      workspaceDir: tmpDir,
    });

    assert.ok(result.systemPromptAddition.includes("Media Empire"));
    assert.deepEqual(result.includedThreads, ["media-empire"]);
  });

  test("suffix-matched thread file is resolved", async () => {
    await writeThread("sealed-sender-inference.thought.md", "# Thought\n\nContent", {
      summary: "A thought thread",
    });
    await writeContextYaml(`
version: 2
threads:
  sealed-sender-inference: reference
`);

    const result = await assemble({
      contextYamlPath: join(tmpDir, "context.yaml"),
      threadsDir,
      workspaceDir: tmpDir,
    });

    assert.ok(result.systemPromptAddition.includes("A thought thread"));
    assert.deepEqual(result.referencedThreads, ["sealed-sender-inference"]);
  });
});
