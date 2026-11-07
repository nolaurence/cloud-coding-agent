# jev-browser

Agent Plugins 1.0.0 packaging of [wanghai673/jev-browser-skill](https://github.com/wanghai673/jev-browser-skill), which adapts [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) for Codex-style agent skills.

Shipped under Cloud Coding Agent's `plugins/` directory. It appears in the **本地仓库** marketplace and stays **uninstalled** until you install it from the Plugins page. After install, the `jev-browser` skill is available to Codex sessions.

## Requirements

- Python 3.12+ and `uv`
- Chrome with remote debugging (Browser Harness)
- TypeSafe Jev API key in `~/.config/jev-browser/.env` (see `.env.example`)

## Skill entry

```sh
python3 <skill-dir>/scripts/jev.py doctor
python3 <skill-dir>/scripts/jev.py run --url '…' --goal '…' --inputs '[…]'
```

See `skills/jev-browser/SKILL.md` for the full workflow. Upstream notices are in `NOTICE` and `LICENSE`.
