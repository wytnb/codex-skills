# Task Spec

Use `scripts/run_cloakbrowser_task.py --task-file <json> --result-file <json>`.

## Top-Level Fields

- `url`: Default page URL for `goto`.
- `goal`: `extract`, `screenshot`, or `interact`.
- `profile_dir`: Optional absolute path. Defaults to `.state/default-profile`.
- `output_dir`: Optional artifact directory. Defaults to the result file's parent directory.
- `proxy`: Optional string or proxy object accepted by CloakBrowser.
- `geoip`: Optional boolean. Defaults to `true` when `proxy` is present, otherwise `false`.
- `timeout_ms`: Optional integer. Defaults to `30000`.
- `headless`: Optional boolean override.
- `humanize`: Optional boolean override.
- `actions`: Ordered action list. If omitted, the runner creates a minimal list from `goal`.

## Supported Actions

### `goto`

```json
{ "type": "goto", "url": "https://example.com", "wait_until": "domcontentloaded" }
```

- Uses `action.url` first, then top-level `url`.
- `wait_until` defaults to `domcontentloaded`.

### `wait_for`

```json
{ "type": "wait_for", "selector": "#ready", "state": "visible" }
```

or

```json
{ "type": "wait_for", "load_state": "networkidle" }
```

### `click`

```json
{ "type": "click", "selector": "button[type=submit]" }
```

### `type`

```json
{ "type": "type", "selector": "#email", "value": "user@example.com", "delay_ms": 50 }
```

### `press`

```json
{ "type": "press", "selector": "#search", "key": "Enter" }
```

Omit `selector` to press the key on the page keyboard directly.

### `screenshot`

```json
{ "type": "screenshot", "path": "page.png", "full_page": true }
```

- Relative paths resolve under `output_dir`.
- If `path` is omitted, the runner creates `screenshot-N.png`.

### `extract_text`

```json
{ "type": "extract_text", "selector": "body" }
```

- Defaults to `body` when `selector` is omitted.
- Writes the extracted string to `result.extracted.text`.

### `extract_html`

```json
{ "type": "extract_html" }
```

- Uses `page.content()` when `selector` is omitted.
- Writes the extracted HTML to `result.extracted.html`.

## Result Shape

```json
{
  "success": true,
  "final_url": "https://example.com",
  "artifacts": {
    "screenshots": ["C:\\path\\to\\work\\page.png"]
  },
  "extracted": {
    "text": "Example Domain",
    "html": "<html>...</html>"
  },
  "error": null
}
```
