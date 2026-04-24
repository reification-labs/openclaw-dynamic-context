#!/usr/bin/env python3
"""
Context Level UI — LAN-accessible interface for toggling thread context levels.
Serves a single-page HTML app + JSON API for reading/writing context.yaml.

Usage:  python3 context-ui.py [--port 8420] [--yaml /path/to/context.yaml] [--threads /path/to/threads/]
"""

import argparse
import json
import os
import sys
import re
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse

import yaml

# ── Config ──────────────────────────────────────────────────────────────

DEFAULT_YAML = Path(os.path.expanduser("~/workspace/context.yaml"))
DEFAULT_THREADS = Path(os.path.expanduser("~/workspace/threads"))
DEFAULT_PORT = 8420
LEVELS = ["off", "reference", "include"]
LEVEL_DISPLAY = {"off": ("Off", "#6b7280"), "reference": ("Ref", "#f59e0b"), "include": ("On", "#10b981")}
LEVEL_ORDER = {"off": 0, "reference": 1, "include": 2}

# ── YAML I/O ────────────────────────────────────────────────────────────

def load_yaml(path: Path) -> dict:
    with open(path) as f:
        data = yaml.safe_load(f)
    # YAML parses "off" as False — fix thread values
    for name, level in data.get("threads", {}).items():
        if level is False:
            data["threads"][name] = "off"
    return data

def save_yaml(path: Path, data: dict):
    # Preserve comments by doing a targeted line edit
    threads = data.get("threads", {})
    lines = path.read_text().splitlines(keepends=True)
    updated = set()
    new_lines = []

    for line in lines:
        stripped = line.strip()
        # Match "thread-name: level" lines (including YAML-false as "off")
        m = re.match(r"^(\S+):\s*(off|reference|include|False|false|True|true)\s*$", stripped)
        if m:
            name = m.group(1)
            if name in threads:
                new_level = threads[name]
                # Preserve leading whitespace
                leading = line[:len(line) - len(line.lstrip())]
                new_lines.append(f"{leading}{name}: {new_level}\n")
                updated.add(name)
                continue
        new_lines.append(line)

    # If any threads weren't found in file, append them
    for name, level in threads.items():
        if name not in updated:
            new_lines.append(f"{name}: {level}\n")

    path.write_text("".join(new_lines))

def get_thread_preview(threads_dir: Path, name: str) -> str:
    """Extract first meaningful line from a thread file for preview."""
    # Try common file patterns
    candidates = [
        threads_dir / f"{name}.md",
        threads_dir / f"{name}.thought.md",
    ]
    # Also try with spaces replaced by hyphens, underscores
    variants = [name.replace(" ", "-"), name.replace(" ", "_"), name.lower().replace(" ", "-")]
    for v in variants:
        candidates.append(threads_dir / f"{v}.md")
        candidates.append(threads_dir / f"{v}.thought.md")

    for candidate in candidates:
        if candidate.exists():
            text = candidate.read_text()
            for line in text.splitlines():
                line = line.strip()
                if line and not line.startswith("#") and not line.startswith("---") and len(line) > 5:
                    return line[:120] + ("…" if len(line) > 120 else "")
    return ""

# ── HTML ────────────────────────────────────────────────────────────────

HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Clawd Context Controls</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  background: #0f0f0f; color: #e0e0e0;
  min-height: 100vh;
}
.header {
  padding: 1.5rem 2rem;
  border-bottom: 1px solid #2a2a2a;
  display: flex; align-items: center; gap: 1rem;
}
.header h1 { font-size: 1.25rem; font-weight: 600; }
.header .crab { font-size: 1.5rem; }
.header .sub { font-size: 0.8rem; color: #666; margin-left: auto; }
.container { max-width: 720px; margin: 0 auto; padding: 1.5rem; }
.thread {
  background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px;
  padding: 1rem 1.25rem; margin-bottom: 0.75rem;
  transition: border-color 0.2s;
}
.thread:hover { border-color: #3a3a3a; }
.thread-head { display: flex; align-items: center; gap: 0.75rem; }
.thread-name {
  font-size: 0.95rem; font-weight: 500; flex: 1;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.thread-name.off { color: #555; }
.thread-name.reference { color: #999; }
.thread-name.include { color: #e0e0e0; }
.preview { font-size: 0.78rem; color: #555; margin-top: 0.4rem; line-height: 1.4; }

/* 3-position toggle switch */
.toggle {
  display: flex; gap: 2px; background: #111; border-radius: 6px;
  padding: 2px; flex-shrink: 0;
}
.toggle button {
  border: none; background: transparent; color: #555;
  font-size: 0.72rem; font-weight: 600; padding: 0.3rem 0.55rem;
  border-radius: 4px; cursor: pointer; transition: all 0.15s;
  text-transform: uppercase; letter-spacing: 0.5px;
  font-family: inherit;
}
.toggle button:hover { color: #999; }
.toggle button.active-off { background: #2a2a2a; color: #888; }
.toggle button.active-reference { background: #3d2e00; color: #f59e0b; }
.toggle button.active-include { background: #003322; color: #10b981; }

.legend {
  display: flex; gap: 1.5rem; padding: 1rem 1.25rem;
  font-size: 0.75rem; color: #555; margin-bottom: 1rem;
}
.legend span { display: flex; align-items: center; gap: 0.4rem; }
.legend .dot { width: 8px; height: 8px; border-radius: 50%; }

.status {
  padding: 0.5rem 1rem; font-size: 0.75rem; text-align: center;
  color: #f59e0b; min-height: 2rem;
}

/* Flash animation for level changes */
@keyframes flash {
  0% { background: rgba(255,255,255,0.05); }
  100% { background: transparent; }
}
.flash { animation: flash 0.4s ease-out; }
</style>
</head>
<body>

<div class="header">
  <span class="crab">🦞</span>
  <h1>Context Controls</h1>
  <span class="sub">DIRT · context.yaml</span>
</div>

<div class="legend">
  <span><span class="dot" style="background:#10b981"></span> Include</span>
  <span><span class="dot" style="background:#f59e0b"></span> Reference</span>
  <span><span class="dot" style="background:#6b7280"></span> Off</span>
</div>

<div id="status" class="status"></div>
<div id="threads" class="container"></div>

<script>
const LEVELS = ['off', 'reference', 'include'];
const API = '';

async function load() {
  try {
    const res = await fetch(API + '/api/threads');
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    // API returns array of threads, or {threads: [...]} for compat
    const threads = Array.isArray(data) ? {threads: data} : data;
    render(threads);
    setStatus('');
  } catch (e) {
    setStatus('⚠ ' + e.message);
  }
}

async function setLevel(name, level) {
  // Optimistic update
  const btn = document.querySelector(`[data-thread="${name}"][data-level="${level}"]`);
  const row = btn.closest('.thread');
  const prevActive = row.querySelector('.toggle button[class*="active-"]');

  // Update UI optimistically
  if (prevActive) prevActive.className = '';
  btn.classList.add('active-' + level);
  row.querySelector('.thread-name').className = 'thread-name ' + level;

  try {
    const res = await fetch(API + '/api/threads', {
      method: 'PATCH',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({thread: name, level: level})
    });
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();

    // Confirm from source — rollback if mismatch
    if (data.level !== level) {
      // Revert: reload the actual state
      row.querySelector('.toggle button[class*="active-"]')?.classList.remove('active-' + data.level);
      row.querySelector(`[data-thread="${name}"][data-level="${data.level}"]`)?.classList.add('active-' + data.level);
      row.querySelector('.thread-name').className = 'thread-name ' + data.level;
      setStatus('⚠ Write failed — reverted to: ' + data.level);
    } else {
      row.classList.add('flash');
      setTimeout(() => row.classList.remove('flash'), 400);
      setStatus('');
    }
  } catch (e) {
    // Rollback
    if (prevActive) prevActive.className = prevActive.className; // keep original
    load(); // full reload as safety net
    setStatus('⚠ ' + e.message);
  }
}

function render(data) {
  const container = document.getElementById('threads');
  // Sort: include first, then reference, then off
  const sorted = data.threads.sort((a, b) => {
    const order = {'include': 0, 'reference': 1, 'off': 2};
    return (order[a.level] ?? 3) - (order[b.level] ?? 3);
  });

  container.innerHTML = sorted.map(t => `
    <div class="thread" id="t-${t.name}">
      <div class="thread-head">
        <span class="thread-name ${t.level}" title="${t.name}">${t.name}</span>
        <div class="toggle">
          ${LEVELS.map(l => `
            <button
              data-thread="${t.name}"
              data-level="${l}"
              class="${t.level === l ? 'active-' + l : ''}"
              onclick="setLevel('${t.name}', '${l}')"
            >${l === 'off' ? 'Off' : l === 'reference' ? 'Ref' : 'On'}</button>
          `).join('')}
        </div>
      </div>
      ${t.preview ? `<div class="preview">${escHtml(t.preview)}</div>` : ''}
    </div>
  `).join('');
}

function setStatus(msg) {
  document.getElementById('status').textContent = msg;
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

load();
</script>
</body>
</html>
"""

# ── HTTP Handler ─────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    yaml_path: Path = DEFAULT_YAML
    threads_dir: Path = DEFAULT_THREADS

    def log_message(self, fmt, *args):
        # Quiet logging — only errors
        if "200" not in str(args[1]):
            super().log_message(fmt, *args)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/" or parsed.path == "/index.html":
            self._html(HTML)
        elif parsed.path == "/api/threads":
            self._json_threads()
        else:
            self._404()

    def do_PATCH(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/threads":
            self._set_level()
        else:
            self._404()

    def _html(self, html):
        data = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _json_threads(self):
        data = load_yaml(self.yaml_path)
        threads = data.get("threads", {})
        result = []
        for name, level in threads.items():
            preview = get_thread_preview(self.threads_dir, name)
            result.append({"name": name, "level": level, "preview": preview})
        self._json(result)

    def _set_level(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            name = body["thread"]
            new_level = body["level"]
        except (json.JSONDecodeError, KeyError):
            self._json({"error": "need {thread, level}"}, 400)
            return

        if new_level not in LEVELS:
            self._json({"error": f"level must be one of {LEVELS}"}, 400)
            return

        data = load_yaml(self.yaml_path)
        threads = data.get("threads", {})
        if name not in threads:
            self._json({"error": f"thread '{name}' not found"}, 404)
            return

        threads[name] = new_level
        try:
            save_yaml(self.yaml_path, data)
        except Exception as e:
            self._json({"error": str(e)}, 500)
            return

        # Read back to confirm
        confirmed = load_yaml(self.yaml_path).get("threads", {}).get(name)
        self._json({"name": name, "level": confirmed})

    def _json(self, obj, code=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def _404(self):
        self._json({"error": "not found"}, 404)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, PATCH, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

# ── Main ────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Clawd Context Level UI")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"Port (default: {DEFAULT_PORT})")
    parser.add_argument("--yaml", type=Path, default=DEFAULT_YAML, help="Path to context.yaml")
    parser.add_argument("--threads", type=Path, default=DEFAULT_THREADS, help="Path to threads directory")
    args = parser.parse_args()

    if not args.yaml.exists():
        print(f"Error: {args.yaml} not found")
        sys.exit(1)

    Handler.yaml_path = args.yaml
    Handler.threads_dir = args.threads

    server = HTTPServer(("0.0.0.0", args.port), Handler)
    print(f"🦞 Context UI → http://localhost:{args.port}")
    print(f"   YAML: {args.yaml}")
    print(f"   Threads: {args.threads}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        server.server_close()

if __name__ == "__main__":
    main()
