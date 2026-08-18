---
name: cloakBrowser
description: Use when browser work needs CloakBrowser or stealth Chromium against protected sites, anti-bot systems, login walls, or automation flows likely to be fingerprinted. Trigger for CloakBrowser-specific requests, stealth browser extraction, screenshots, or structured interactions on hostile pages. Do not use for ordinary web search, normal docs lookup, or routine Browser plugin tasks.
---

# cloakBrowser

## Overview

Run structured browser tasks through a dedicated CloakBrowser runtime instead of ad hoc scripts. Use this skill when the browser itself needs stealth characteristics, not when ordinary browsing or web search is enough.

## Quick Start

1. Write temporary task and result files into the active workspace `work/` directory when available.
2. Bootstrap the dedicated runtime:
   ```powershell
   python "$env:USERPROFILE\.codex\skills\cloakBrowser\scripts\bootstrap_runtime.py"
   ```
3. Run the task:
   ```powershell
   python "$env:USERPROFILE\.codex\skills\cloakBrowser\scripts\run_cloakbrowser_task.py" --task-file "C:\path\to\work\task.json" --result-file "C:\path\to\work\result.json"
   ```
4. Read the structured result JSON and inspect any screenshot artifacts.

## Workflow

1. Decide whether the target really needs stealth.
   Use this skill for protected sites, suspicious anti-bot flows, login persistence, or explicit CloakBrowser requests.
   Do not use it for normal web search or for pages that the Browser plugin can handle directly.
2. Bootstrap the runtime once per machine or when the runtime looks broken.
   The bootstrap script owns a dedicated venv under the skill directory and predownloads the CloakBrowser binary.
3. Describe the task as JSON instead of improvising shell flags.
   Prefer small action lists with explicit `goto`, `wait_for`, `click`, `type`, `press`, `screenshot`, `extract_text`, and `extract_html`.
4. Let the runner choose the balanced default launch preset.
   Extraction and screenshot tasks run headless by default.
   Interaction tasks switch to headed plus `humanize=True`.
   When `proxy` is present and `geoip` is omitted, the runner enables `geoip=True`.
5. Reuse the default persistent profile unless the user needs an isolated profile.
   The default profile lives at `.state/default-profile` under the skill directory.

## Task Design

- Set `goal` to `extract`, `screenshot`, or `interact`.
- Set `url` at the top level unless every `goto` action supplies its own `url`.
- Set `profile_dir` only when the task needs isolation from the shared default profile.
- Set `output_dir` to keep screenshots and other artifacts inside the active workspace.
- Keep credentials, cookies, and proxy secrets in the task file at runtime only. Do not write them into the skill.

Minimal extraction example:

```json
{
  "url": "https://example.com",
  "goal": "extract",
  "output_dir": "C:\\path\\to\\work",
  "actions": [
    { "type": "goto" },
    { "type": "extract_text" }
  ]
}
```

Minimal interaction example:

```json
{
  "url": "https://example.com/login",
  "goal": "interact",
  "output_dir": "C:\\path\\to\\work",
  "actions": [
    { "type": "goto" },
    { "type": "type", "selector": "#email", "value": "user@example.com" },
    { "type": "type", "selector": "#password", "value": "secret" },
    { "type": "click", "selector": "button[type=submit]" },
    { "type": "screenshot", "path": "post-login.png" },
    { "type": "extract_html" }
  ]
}
```

## References

- Task schema and action details: `references/task-spec.md`
- Runtime failures and environment issues: `references/troubleshooting.md`

## Guardrails

- Do not treat this skill as a generic browser replacement.
- Do not use it for ordinary internet research when `web` or the Browser plugin is enough.
- Do not hand-edit the dedicated runtime unless the bootstrap script fails and the failure is understood.
- Do not store long-lived secrets inside the skill directory.
