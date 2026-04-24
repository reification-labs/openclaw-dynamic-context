# SDD: Dynamic Context Engine Plugin

**Status:** Draft v2  
**Date:** 2026-04-21  

---

## 1. Problem Statement

Memory in OpenClaw is currently static. MEMORY.md is loaded fully on every session, mixing identity (always needed) with threads (sometimes needed) with cold archives (rarely needed). This wastes context tokens on irrelevant content and has no mechanism for the agent or human to dynamically control what's in context.

Key failures:
- **Context bloat:** Everything loads every time, regardless of relevance
- **Silent data loss:** Pruning MEMORY.md bullets without backing files evaporates ideas
- **No HITL control:** Human can't easily review or override what the agent considers important
- **No agent-driven discovery:** Agent can't promote a thread when it detects cross-thread connections
- **Single state:** No distinction between "I know this exists" and "I have this loaded"

## 2. Goals

1. **Dynamic context window** — control which memories/threads are fully loaded vs referenced vs hidden
2. **Nothing disappears** — every tracked idea gets its own file; MEMORY.md becomes a derived view
3. **HITL control** — human can review, promote, demote, and override
4. **Agent-driven discovery** — agent can promote reference→include when connections are found
5. **Persistent across resets** — context.yaml survives `/new`, `/reset`, and gateway restarts
6. **KV-cache aware** — minimize changes to the static prefix (identity files) to preserve caching

## 3. Architecture

### 3.1 Source of Truth Hierarchy

```
context.yaml     ← what matters (state: include/reference/off)
threads/*.md     ← what it is (content)
memory/topics/   ← deep knowledge (content)
```

**MEMORY.md is no longer edited directly.** It's regenerated from context.yaml + file contents. Humans and agents edit the YAML and files; MEMORY.md is a rendering.

### 3.2 Context Loading Tiers

| Tier | YAML State | System Prompt | Agent Behavior |
|------|-----------|---------------|----------------|
| **Include** | `include` | Full content injected | Always aware, can reason deeply |
| **Reference** | `reference` | Name + one-line summary in a "known threads" list | Knows it exists, can `read` file on demand |
| **Off** | `off` | Nothing | Doesn't know it exists unless searching |

### 3.3 Static Prefix (always loaded, never in YAML)

These files form the unchanging cache-friendly prefix:
- SOUL.md
- IDENTITY.md
- USER.md
- TOOLS.md
- OpenClaw base system prompt + tool definitions
- Agent skills snapshot

**These are NOT managed by context.yaml.** They're hardcoded always-include.

## 4. Data Model

### 4.1 context.yaml Schema

```yaml
version: 2

threads:
  # Format: short-name: state
  # States: include | reference | off
  # File lookup: threads/{short-name}*.md or threads/{short-name}/index.md

  active-project: include
  relevant-idea: reference
  archived-topic: off

files:
  # Non-thread workspace files to track
  NOTES.md: include

topic_areas:
  # Broader knowledge areas (for reference-tier awareness)
  architecture: reference
  research: reference
```

### 4.2 Thread File Spec

Every thread gets its own file with YAML frontmatter for machine-parseable metadata.

Minimum viable thread file:

```markdown
---
id: "thread-name"
type: thread
subtype: thought
title: "Human-Readable Title"
created: "2026-04-21T16:00:00.000000"
updated: "2026-04-21T16:00:00.000000"
tags: []
state: include  # include | reference | off (mirrors context.yaml)
summary: "One line about what this thread is about."
---

## Content
[...actual content...]
```

The `state` field in frontmatter mirrors the context.yaml entry. The YAML is the
authoritative source; frontmatter state is for standalone file inspection.

### 4.3 MEMORY.md

MEMORY.md stays hand-maintained for now. The context engine plugin injects content
via `assemble()` at runtime — it does NOT rewrite MEMORY.md.

Future phase: auto-generated derived view from context.yaml + files.

## 5. Context Engine Plugin Design

### 5.1 Plugin Structure

```
~/.openclaw-{instance}/extensions/dynamic-context/
├── openclaw.plugin.json
├── index.ts
├── engine.ts
├── engine.test.ts
├── package.json
└── node_modules/
```

### 5.2 Lifecycle

```
┌─────────────────────────────────────────────┐
│                 ingest()                     │
│  - Store message metadata                   │
│  - Track which threads/files mentioned       │
│  - Update access frequency counters         │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│                assemble()                    │
│  1. Read context.yaml                        │
│  2. Load static prefix (SOUL, IDENTITY, etc) │
│  3. For each `include` thread:               │
│     - Read thread file                       │
│     - Inject content into systemPromptAddition│
│  4. For each `reference` thread:             │
│     - Add one-line to "known threads" list   │
│  5. Return messages + systemPromptAddition   │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│              afterTurn()                     │
│  - Check if agent edited context.yaml        │
│  - If promotion flagged: queue for review    │
│  - Update access counters                    │
│  - Persist any state changes                 │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│               compact()                      │
│  - Demote least-accessed `include` threads   │
│    to `reference` when context is full       │
│  - Suggest demotions to human (not auto-do)  │
└─────────────────────────────────────────────┘
```

### 5.3 Key Behaviors

**Mid-session promotion (the killer feature):**
1. Agent reads a `reference` thread file during a ReAct loop
2. Agent determines it's relevant to current work
3. Agent edits context.yaml: `reference` → `include`
4. On the NEXT `assemble()` call (next ReAct iteration), the thread content is injected via `systemPromptAddition`
5. No new user message needed — immediate within the same session

**Human override:**
- Human edits context.yaml directly
- Agent can also promote and demote — no artificial restrictions
- If we hit promote/demote cycles, we'll address it then

**Compaction-aware demotion:**
- When approaching token limits, engine suggests demoting low-access `include` threads
- Human approves; engine frees context space without losing the thread

## 6. HITL Interface

### 6.1 Direct Editing
Human edits `context.yaml` directly. Changes take effect on next `assemble()`.

### 6.2 Natural Language Commands
Via any connected channel (Signal, Discord, etc.):
- "promote active-project to include"
- "demote archived-topic to reference"
- "what's in context right now?"
- "show me candidates for promotion" (reference threads accessed frequently)
- "show me candidates for demotion" (include threads rarely accessed)

### 6.3 Review Queue
When promotion requires confirmation, agent queues for review.
Human responds yes/no. Agent executes.

## 7. KV Cache Strategy

**Static prefix (cached):**
- OpenClaw base prompt + tool definitions (~15-20K tokens)
- Identity files (SOUL, IDENTITY, USER, TOOLS) (~3-4K tokens)
- **Total cached prefix: ~18-24K tokens** — never changes between sessions

**Dynamic tail (variable):**
- Included thread files (~8-15K tokens)
- Session messages (rest of window)

**Cache invalidation only affects the dynamic tail.** The static prefix remains cacheable as long as identity files don't change.

**Optimization:** Sort `include` threads by access frequency. Most-accessed threads are placed closest to the static prefix boundary, maximizing the cache hit ratio.

## 8. Migration Plan

### Phase 1: Context Engine Plugin (current)
1. Build plugin with `assemble()` lifecycle
2. Read context.yaml on each assemble — inject `include` files, list `reference` items
3. Implement mid-session promotion (the dynamic killer feature)
4. Install via `openclaw plugins install`
5. MEMORY.md stays hand-maintained

### Phase 2: Thread File Standardization
1. Add YAML frontmatter to all existing thread files
2. Create stub files for orphaned MEMORY.md bullets
3. `include` means full file content, no truncation

### Phase 3: Smart Compaction (future)
1. Auto-suggest demotions based on access patterns
2. Implement compaction-aware context management
3. Cross-session learning (threads promoted every session → auto-include)

## 9. Open Questions

- **Derived MEMORY.md timing:** Generate on every `assemble()` (slow) or only when YAML/files change (needs change detection)? → Start with change detection via mtime.
- **Thread naming convention:** Short keys in YAML vs full filenames? → Short keys with file lookup pattern `threads/{key}*.md`.
- **Cross-gateway sync:** Should multiple instances share a plugin? → Start single-instance, share later.
- **Git integration:** Should context.yaml changes auto-commit? → Yes, with meaningful messages.
- **`include` semantics:** Full file content, no truncation. If truncation needed later, add `include: 5000` syntax.

---

*Part of the [openclaw-dynamic-context](https://github.com/reification-labs/openclaw-dynamic-context) repo.*
