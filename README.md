# openclaw-dynamic-context

Dynamic context engine plugin for [OpenClaw](https://github.com/openclaw/openclaw). Tiers memory into three levels — **include**, **reference**, and **off** — via a `context.yaml` config file, and injects included content as system prompt additions.

## How It Works

```
context.yaml     ← what matters (state: include/reference/off)
threads/*.md     ← what it is (content)
workspace files  ← tracked via files: section in YAML
```

| Tier | System Prompt | Behavior |
|------|--------------|----------|
| **include** | Full content injected | Always aware, can reason deeply |
| **reference** | One-line summary in "Known Threads" list | Knows it exists, can `read` on demand |
| **off** | Nothing | Invisible unless searching |

**The killer feature:** mid-session promotion. If the agent reads a `reference` thread and finds it relevant, it can promote it to `include` in `context.yaml` — and on the next `assemble()` call, the full content is injected. No new user message needed.

## Install

```bash
# From the plugin directory
openclaw plugins install ./plugin
```

Or install from a local path:

```bash
openclaw plugins install /path/to/openclaw-dynamic-context/plugin
```

## Configuration

The plugin reads `context.yaml` from your workspace root (or a custom path via config).

### context.yaml

```yaml
version: 2

threads:
  active-project: include       # fully loaded
  relevant-idea: reference       # known, loadable on demand
  old-topic: off                 # cold storage

files:
  STEEP.md: include              # workspace files can be tracked too
  MODELS.md: reference
```

### Plugin Config (optional)

Override paths via plugin config:

```json
{
  "contextYamlPath": "/path/to/context.yaml",
  "threadsDir": "/path/to/threads",
  "workspaceDir": "/path/to/workspace"
}
```

## Context UI

A simple web UI for toggling thread levels without editing YAML directly.

```bash
pip install pyyaml
python3 ui/context-ui.py --port 8420
```

Open `http://localhost:8420` to see all threads with 3-position toggles (Off / Ref / On).

### LaunchAgent (macOS)

A plist is included at `ui/ai.openclaw.context-ui.plist` for auto-start.

## Development

```bash
cd plugin
npm install
npm test
```

Tests use Node.js built-in test runner + tsx. 11 tests covering tiers, frontmatter, file resolution, and edge cases.

## Architecture

See [SDD.md](./SDD.md) for the full system design document.

### Components

- **plugin/engine.ts** — Pure logic (no OpenClaw SDK deps). Reads YAML, resolves files, assembles output.
- **plugin/index.ts** — Plugin entry point. Registers the context engine with OpenClaw's plugin API.
- **plugin/engine.test.ts** — 11 tests for core assemble logic.
- **ui/context-ui.py** — Single-file HTTP server with embedded HTML UI.

## License

MIT © Reification Labs
