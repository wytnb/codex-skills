#!/usr/bin/env python3
"""Render a normalized interview transcript JSON file as Markdown.

Input schema:
{
  "title": "Video title",
  "source_url": "https://www.bilibili.com/video/BV...",
  "bvid": "BV...",
  "duration": 4930,
  "speakers": ["主持人", "嘉宾"],
  "note": "整理说明",
  "chapters": [{"start": 0, "title": "访谈背景"}],
  "paragraphs": [{"start": 0, "speaker": "主持人", "text": "..."}]
}
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


def format_time(seconds: float) -> str:
    total = max(0, int(seconds))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def anchor(title: str) -> str:
    value = title.strip().lower()
    value = re.sub(r"[^\w\u4e00-\u9fff]+", "-", value, flags=re.UNICODE)
    return value.strip("-") or "chapter"


def require_list(data: dict[str, Any], key: str) -> list[Any]:
    value = data.get(key)
    if not isinstance(value, list) or not value:
        raise ValueError(f"{key} must be a non-empty list")
    return value


def validate(data: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if not str(data.get("title", "")).strip():
        raise ValueError("title is required")

    chapters = require_list(data, "chapters")
    paragraphs = require_list(data, "paragraphs")

    for collection, name in ((chapters, "chapters"), (paragraphs, "paragraphs")):
        previous = -1.0
        for index, item in enumerate(collection):
            if not isinstance(item, dict):
                raise ValueError(f"{name}[{index}] must be an object")
            start = float(item.get("start", -1))
            if start < previous:
                raise ValueError(f"{name} timestamps must be monotonic")
            previous = start

    for index, chapter in enumerate(chapters):
        if not str(chapter.get("title", "")).strip():
            raise ValueError(f"chapters[{index}].title is required")

    for index, paragraph in enumerate(paragraphs):
        if not str(paragraph.get("speaker", "")).strip():
            raise ValueError(f"paragraphs[{index}].speaker is required")
        if not str(paragraph.get("text", "")).strip():
            raise ValueError(f"paragraphs[{index}].text is required")

    return chapters, paragraphs


def render(data: dict[str, Any]) -> str:
    chapters, paragraphs = validate(data)
    title = str(data["title"]).strip()
    speakers = data.get("speakers") or sorted({str(p["speaker"]).strip() for p in paragraphs})
    source = str(data.get("source_url") or data.get("bvid") or "Bilibili 视频").strip()
    duration = data.get("duration")
    note = str(data.get("note") or "结合视频时间轴与语义校订，并整理为书面表达。").strip()

    lines = [f"# {title}｜访谈文字稿", "", f"> 来源：{source}。", ">"]
    if duration is not None:
        lines.extend([f"> 视频时长：{format_time(float(duration))}。", ">"])
    lines.extend([f"> 说话人：{'、'.join(map(str, speakers))}。", ">", f"> 整理说明：{note}", "", "## 目录", ""])

    used_anchors: dict[str, int] = {}
    chapter_anchors: list[str] = []
    for chapter in chapters:
        base = anchor(str(chapter["title"]))
        used_anchors[base] = used_anchors.get(base, 0) + 1
        suffix = "" if used_anchors[base] == 1 else f"-{used_anchors[base]}"
        chapter_anchors.append(base + suffix)
        label = f"{format_time(float(chapter['start']))} {str(chapter['title']).strip()}"
        lines.append(f"- [{label}](#{base + suffix})")

    for index, chapter in enumerate(chapters):
        start = float(chapter["start"])
        end = float(chapters[index + 1]["start"]) if index + 1 < len(chapters) else float("inf")
        lines.extend(["", f'<a id="{chapter_anchors[index]}"></a>', f"## {format_time(start)} {str(chapter['title']).strip()}", ""])
        selected = [p for p in paragraphs if start <= float(p["start"]) < end]
        for paragraph in selected:
            timestamp = format_time(float(paragraph["start"]))
            speaker = str(paragraph["speaker"]).strip()
            text = re.sub(r"\s+", " ", str(paragraph["text"]).strip())
            lines.extend([f"[{timestamp}] **{speaker}：** {text}", ""])

    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path, help="Normalized transcript JSON")
    parser.add_argument("--output", required=True, type=Path, help="Destination Markdown file")
    args = parser.parse_args()

    with args.input.open("r", encoding="utf-8-sig") as handle:
        data = json.load(handle)
    markdown = render(data)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(markdown, encoding="utf-8")
    print(f"Wrote {args.output} ({len(markdown)} characters)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
