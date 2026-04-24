// engine.ts — Pure logic for the dynamic context engine.
// No OpenClaw SDK imports. Testable in isolation.

import { readFile, stat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Tier = "include" | "reference" | "off";

export interface ContextYaml {
  version: number;
  threads: Record<string, Tier>;
  files?: Record<string, Tier>;
  topic_areas?: Record<string, Tier>;
}

export interface ThreadFile {
  /** Path to the file on disk. */
  path: string;
  /** The short key from context.yaml. */
  key: string;
  /** Full content of the file (minus frontmatter). */
  content: string;
  /** Summary line extracted from YAML frontmatter, if present. */
  summary: string | null;
}

export interface AssembleInput {
  /** Absolute path to context.yaml. */
  contextYamlPath: string;
  /** Absolute path to the threads directory. */
  threadsDir: string;
  /** Absolute path to the workspace root (for files tracked in context.yaml). */
  workspaceDir: string;
}

export interface AssembleOutput {
  systemPromptAddition: string;
  includedThreads: string[];
  referencedThreads: string[];
  skippedThreads: string[];
  includedFiles: string[];
}

// ---------------------------------------------------------------------------
// YAML frontmatter parser
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n/;

interface Frontmatter {
  summary?: string;
  state?: string;
  [key: string]: unknown;
}

function parseFrontmatter(content: string): { frontmatter: Frontmatter | null; body: string } {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return { frontmatter: null, body: content };

  try {
    const frontmatter = parseYaml(match[1]) as Frontmatter;
    return {
      frontmatter,
      body: content.slice(match[0].length),
    };
  } catch {
    // If YAML parsing fails, treat entire file as content
    return { frontmatter: null, body: content };
  }
}

// ---------------------------------------------------------------------------
// File lookup — threads/{key}*.md or threads/{key}/index.md
// ---------------------------------------------------------------------------

async function resolveThreadFile(threadsDir: string, key: string): Promise<string | null> {
  // Try threads/{key}/index.md (directory-style threads)
  const indexPath = join(threadsDir, key, "index.md");
  try {
    if ((await stat(indexPath)).isFile()) return indexPath;
  } catch { /* not found */ }

  // Try glob-like: threads/{key}*.md
  try {
    const entries = await readdir(threadsDir);
    // Exact match: threads/{key}.md
    const exact = `${key}.md`;
    if (entries.includes(exact)) return join(threadsDir, exact);

    // Prefix match: threads/{key}*.md (but not index.md inside a subdir)
    const prefix = `${key}.`;
    const match = entries.find(e => e.startsWith(prefix) && e.endsWith(".md"));
    if (match) return join(threadsDir, match);

    // Also check {key}.thought.md, {key}.substack.md etc.
    const suffixMatch = entries.find(e => e.startsWith(`${key}-`) || e.startsWith(`${key}_`));
    if (suffixMatch && suffixMatch.endsWith(".md")) return join(threadsDir, suffixMatch);
  } catch { /* dir doesn't exist */ }

  return null;
}

// ---------------------------------------------------------------------------
// Read thread file with optional frontmatter
// ---------------------------------------------------------------------------

async function readThreadFile(path: string, key: string): Promise<ThreadFile> {
  const raw = await readFile(path, "utf-8");
  const { frontmatter, body } = parseFrontmatter(raw);
  return {
    path,
    key,
    content: body.trim(),
    summary: frontmatter?.summary ?? null,
  };
}

// ---------------------------------------------------------------------------
// File lookup — workspace root for files tracked in context.yaml
// ---------------------------------------------------------------------------

async function resolveWorkspaceFile(workspaceDir: string, relativePath: string): Promise<string | null> {
  const fullPath = resolve(workspaceDir, relativePath);
  try {
    if ((await stat(fullPath)).isFile()) return fullPath;
  } catch { /* not found */ }
  return null;
}

// ---------------------------------------------------------------------------
// Assemble — the core function
// ---------------------------------------------------------------------------

export async function assemble(input: AssembleInput): Promise<AssembleOutput> {
  const { contextYamlPath, threadsDir, workspaceDir } = input;

  // 1. Parse context.yaml
  let yaml: ContextYaml;
  try {
    const raw = await readFile(contextYamlPath, "utf-8");
    yaml = parseYaml(raw) as ContextYaml;
  } catch (err) {
    // If context.yaml doesn't exist or is malformed, return empty
    return {
      systemPromptAddition: "",
      includedThreads: [],
      referencedThreads: [],
      skippedThreads: [],
      includedFiles: [],
    };
  }

  const parts: string[] = [];
  const includedThreads: string[] = [];
  const referencedThreads: string[] = [];
  const skippedThreads: string[] = [];
  const includedFiles: string[] = [];

  // 2. Process threads
  const threads = yaml.threads ?? {};

  for (const [key, tier] of Object.entries(threads)) {
    if (tier === "off") continue;

    const filePath = await resolveThreadFile(threadsDir, key);
    if (!filePath) {
      skippedThreads.push(key);
      continue;
    }

    if (tier === "include") {
      const thread = await readThreadFile(filePath, key);
      parts.push(`## Thread: ${key}\n\n${thread.content}`);
      includedThreads.push(key);
    } else if (tier === "reference") {
      const thread = await readThreadFile(filePath, key);
      const summary = thread.summary ?? "(no summary)";
      parts.push(`- **${key}**: ${summary}`);
      referencedThreads.push(key);
    }
  }

  // 3. Process workspace files
  const files = yaml.files ?? {};
  for (const [relativePath, tier] of Object.entries(files)) {
    if (tier === "off") continue;

    const filePath = await resolveWorkspaceFile(workspaceDir, relativePath);
    if (!filePath) {
      skippedThreads.push(relativePath);
      continue;
    }

    if (tier === "include") {
      const content = await readFile(filePath, "utf-8");
      parts.push(`## File: ${relativePath}\n\n${content.trimEnd()}`);
      includedFiles.push(relativePath);
    } else if (tier === "reference") {
      parts.push(`- **${relativePath}**: (reference, load on demand)`);
      referencedThreads.push(relativePath);
    }
  }

  // 4. Build the system prompt addition
  // Parts are accumulated in order: included threads, included files, referenced items.
  const includeCount = includedThreads.length + includedFiles.length;
  const sections: string[] = [];

  // Included content (full thread bodies + workspace files)
  if (includeCount > 0) {
    const includeLines = parts.slice(0, includeCount).join("\n\n");
    sections.push(`# Dynamic Context\n${includeLines}`);
  }

  // Referenced content (one-liner summaries)
  if (referencedThreads.length > 0) {
    const refLines = parts.slice(includeCount).join("\n");
    sections.push(`# Known Threads\n${refLines}`);
  }

  const systemPromptAddition = sections.join("\n\n");

  return {
    systemPromptAddition,
    includedThreads,
    referencedThreads,
    skippedThreads,
    includedFiles,
  };
}
