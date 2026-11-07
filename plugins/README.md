# Local Agent Plugins

Directories here are scanned by Cloud Coding Agent at runtime and listed in the
**本地仓库** marketplace. They are **not** installed by default.

## Layout

Each subdirectory must be a valid [Agent Plugins 1.0.0](https://agent-plugins.org/specification) package:

```
plugins/<name>/
  plugin.json          # requires $schema for strict mode
  skills/<skill>/SKILL.md
  mcp.json             # optional
```

## Install path

Marketplace entries use source `local:<dirName>`. Installing copies the package
into `$CCA_DATA_DIR/agent-plugins/<plugin-name>/` and only then exposes skills
and MCP servers to Codex sessions. Uninstall removes that copy; the source tree
under `plugins/` stays in the repo.

Override the scan root with `CCA_LOCAL_PLUGINS_DIR` if needed.
