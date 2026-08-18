# Codex Skills

[中文](#中文) | [English](#english)

## 中文

这是一个持续扩充的 Codex Skill 集合，用于收纳不同领域、不同工作流的可复用技能。每个 skill 都保存在 `skills/` 下的独立目录中。

### Skill 目录

| Skill | 简要描述 |
| --- | --- |
| [`bilibili-interview-to-markdown`](skills/bilibili-interview-to-markdown/) | 将 Bilibili 访谈整理为带章节、时间戳和说话人标注的 Markdown 中文文字稿。 |
| [`cloakBrowser`](skills/cloakBrowser/) | 通过 CloakBrowser 为受保护站点、反机器人页面和登录墙提供结构化浏览器自动化。 |

### 安装

克隆仓库后，将需要的 skill 目录复制到本机 Codex skills 目录：

```powershell
git clone https://github.com/wytnb/codex-skills.git
Copy-Item -Recurse .\codex-skills\skills\{skill-name} "$env:USERPROFILE\.codex\skills\"
```

### 添加新的 Skill

1. 在 `skills/{skill-name}/` 下创建独立目录，并包含 `SKILL.md`。
2. 将脚本、参考资料和代理配置保存在该 skill 自己的目录中。
3. 在本 README 的 Skill 目录表中添加名称、简要描述和链接。
4. 不要提交凭据、Cookie、浏览器配置、虚拟环境或其他运行态数据。

### 安全与许可证

- `cloakBrowser` 会在本地生成 `.state/`，其中可能包含持久浏览器配置、历史记录、登录数据库、缓存、二进制文件和虚拟环境；这些内容已被忽略，不应提交。
- 本仓库当前未提供许可证。公开可见不代表授予复制、修改或再分发权利。

## English

This is a growing collection of reusable Codex skills for diverse domains and workflows. Each skill lives in its own directory under `skills/`.

### Skills Catalog

| Skill | Description |
| --- | --- |
| [`bilibili-interview-to-markdown`](skills/bilibili-interview-to-markdown/) | Converts Bilibili interviews into polished Chinese Markdown transcripts with chapters, timestamps, and speaker labels. |
| [`cloakBrowser`](skills/cloakBrowser/) | Provides structured CloakBrowser automation for protected sites, anti-bot pages, and login walls. |

### Installation

Clone the repository, then copy the required skill directory into your local Codex skills directory:

```powershell
git clone https://github.com/wytnb/codex-skills.git
Copy-Item -Recurse .\codex-skills\skills\{skill-name} "$env:USERPROFILE\.codex\skills\"
```

### Adding a Skill

1. Create an isolated directory at `skills/{skill-name}/` containing `SKILL.md`.
2. Keep scripts, references, and agent configuration inside that skill directory.
3. Add the skill name, short description, and link to the catalog in this README.
4. Never commit credentials, cookies, browser profiles, virtual environments, or other runtime state.

### Security and License

- `cloakBrowser` creates a local `.state/` directory that may contain persistent browser data, history, login databases, caches, binaries, and a virtual environment. It is ignored and must not be committed.
- No license is currently provided. Public visibility does not grant permission to copy, modify, or redistribute the contents.
