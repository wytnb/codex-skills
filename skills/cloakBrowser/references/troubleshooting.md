# Troubleshooting

## Runtime bootstrap fails

- Run:
  ```powershell
  python "$env:USERPROFILE\.codex\skills\cloakBrowser\scripts\bootstrap_runtime.py" --info
  ```
- Confirm the dedicated runtime lives under `.state/venv`.
- Re-run bootstrap without `--skip-binary` if the CloakBrowser binary is missing.

## Windows + Python 3.9 install issues

- This skill pins `greenlet==3.1.1` on `Windows + Python 3.9` before installing `patchright`.
- That avoids the common build failure where newer `greenlet` releases need local MSVC build tools.
- If bootstrap still fails, inspect the pip output before changing the pin.

## Runner starts with the wrong Python

- This is expected on the first call.
- `run_cloakbrowser_task.py` bootstraps the dedicated runtime, then re-executes itself inside that venv.
- If it keeps looping, delete `.state/venv` and bootstrap again.

## Protected site still blocks

- Supply a residential `proxy`.
- Let `geoip` default to `true` when the proxy is set, or force it explicitly.
- Prefer the interaction preset for login, click, and form flows so the runner uses headed mode and `humanize=True`.

## Artifact paths are hard to find

- Set `output_dir` to the active workspace `work/` directory.
- Keep `task.json`, `result.json`, and screenshots in the same scratch area for one task run.
