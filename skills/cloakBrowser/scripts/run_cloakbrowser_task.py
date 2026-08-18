#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path

from _runtime import DEFAULT_PROFILE_DIR, ensure_runtime_and_reexec


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a structured browser task with CloakBrowser.",
    )
    parser.add_argument("--task-file", required=True, help="Path to the input task JSON file.")
    parser.add_argument(
        "--result-file",
        required=True,
        help="Path to the output result JSON file.",
    )
    return parser.parse_args()


def load_task(task_file: Path) -> dict:
    with task_file.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def normalize_output_dir(task: dict, result_file: Path) -> Path:
    raw_output_dir = task.get("output_dir")
    output_dir = Path(raw_output_dir) if raw_output_dir else result_file.parent
    output_dir.mkdir(parents=True, exist_ok=True)
    return output_dir.resolve()


def has_interaction_actions(actions: list[dict]) -> bool:
    interactive = {"click", "type", "press"}
    return any(action.get("type") in interactive for action in actions)


def resolve_launch_options(task: dict, actions: list[dict]) -> dict:
    interaction_mode = task.get("goal") == "interact" or has_interaction_actions(actions)
    headless = task.get("headless")
    humanize = task.get("humanize")
    proxy = task.get("proxy")
    geoip = task.get("geoip")
    if headless is None:
        headless = not interaction_mode
    if humanize is None:
        humanize = interaction_mode
    if geoip is None:
        geoip = bool(proxy)
    profile_dir = Path(task.get("profile_dir") or DEFAULT_PROFILE_DIR).resolve()
    profile_dir.mkdir(parents=True, exist_ok=True)

    return {
        "profile_dir": profile_dir,
        "headless": headless,
        "humanize": humanize,
        "proxy": proxy,
        "geoip": geoip,
    }


def build_default_actions(task: dict) -> list[dict]:
    goal = task.get("goal", "extract")
    if goal == "screenshot":
        return [{"type": "goto"}, {"type": "screenshot", "path": "page.png"}]
    if goal == "interact":
        return [{"type": "goto"}]
    return [{"type": "goto"}, {"type": "extract_text"}]


def resolve_artifact_path(output_dir: Path, relative_path: str | None, fallback_name: str) -> Path:
    filename = relative_path or fallback_name
    candidate = Path(filename)
    if not candidate.is_absolute():
        candidate = output_dir / candidate
    candidate.parent.mkdir(parents=True, exist_ok=True)
    return candidate.resolve()


def run_task(task: dict, result_file: Path) -> dict:
    from cloakbrowser import launch_persistent_context

    actions = task.get("actions") or build_default_actions(task)
    timeout_ms = int(task.get("timeout_ms", 30000))
    output_dir = normalize_output_dir(task, result_file)
    launch_options = resolve_launch_options(task, actions)

    result = {
        "success": False,
        "final_url": "",
        "artifacts": {"screenshots": []},
        "extracted": {},
        "error": None,
    }

    context = None
    page = None
    screenshot_index = 0
    try:
        context = launch_persistent_context(
            str(launch_options["profile_dir"]),
            headless=launch_options["headless"],
            humanize=launch_options["humanize"],
            proxy=launch_options["proxy"],
            geoip=launch_options["geoip"],
        )
        page = context.pages[0] if context.pages else context.new_page()
        page.set_default_timeout(timeout_ms)
        page.set_default_navigation_timeout(timeout_ms)

        if not any(action.get("type") == "goto" for action in actions) and task.get("url"):
            page.goto(task["url"], wait_until="domcontentloaded", timeout=timeout_ms)

        for action in actions:
            action_type = action.get("type")
            if action_type == "goto":
                target_url = action.get("url") or task.get("url")
                if not target_url:
                    raise ValueError("goto action requires action.url or task.url")
                page.goto(
                    target_url,
                    wait_until=action.get("wait_until", "domcontentloaded"),
                    timeout=int(action.get("timeout_ms", timeout_ms)),
                )
            elif action_type == "wait_for":
                selector = action.get("selector")
                if selector:
                    page.wait_for_selector(
                        selector,
                        state=action.get("state", "visible"),
                        timeout=int(action.get("timeout_ms", timeout_ms)),
                    )
                else:
                    page.wait_for_load_state(
                        state=action.get("load_state", "networkidle"),
                        timeout=int(action.get("timeout_ms", timeout_ms)),
                    )
            elif action_type == "click":
                selector = action["selector"]
                page.locator(selector).click(timeout=int(action.get("timeout_ms", timeout_ms)))
            elif action_type == "type":
                selector = action["selector"]
                value = action["value"]
                delay = int(action.get("delay_ms", 50))
                locator = page.locator(selector)
                locator.click(timeout=int(action.get("timeout_ms", timeout_ms)))
                locator.type(value, delay=delay, timeout=int(action.get("timeout_ms", timeout_ms)))
            elif action_type == "press":
                key = action["key"]
                selector = action.get("selector")
                if selector:
                    page.locator(selector).press(
                        key, timeout=int(action.get("timeout_ms", timeout_ms))
                    )
                else:
                    page.keyboard.press(key)
            elif action_type == "screenshot":
                screenshot_index += 1
                screenshot_path = resolve_artifact_path(
                    output_dir,
                    action.get("path"),
                    f"screenshot-{screenshot_index}.png",
                )
                page.screenshot(
                    path=str(screenshot_path),
                    full_page=bool(action.get("full_page", True)),
                )
                result["artifacts"]["screenshots"].append(str(screenshot_path))
            elif action_type == "extract_text":
                selector = action.get("selector")
                text = page.locator(selector).inner_text() if selector else page.inner_text("body")
                result["extracted"]["text"] = text
            elif action_type == "extract_html":
                selector = action.get("selector")
                html = page.locator(selector).inner_html() if selector else page.content()
                result["extracted"]["html"] = html
            else:
                raise ValueError(f"Unsupported action type: {action_type}")

        result["success"] = True
        result["final_url"] = page.url
        return result
    except Exception as exc:
        result["final_url"] = page.url if page is not None else ""
        result["error"] = {"message": str(exc), "traceback": traceback.format_exc()}
        return result
    finally:
        if context is not None:
            context.close()


def write_result(result_file: Path, payload: dict) -> None:
    result_file.parent.mkdir(parents=True, exist_ok=True)
    with result_file.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)


def main() -> int:
    ensure_runtime_and_reexec(sys.argv)
    args = parse_args()
    task_file = Path(args.task_file).resolve()
    result_file = Path(args.result_file).resolve()
    task = load_task(task_file)
    payload = run_task(task, result_file)
    write_result(result_file, payload)
    return 0 if payload["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
