import { defineTool, type Tool } from "@github/copilot-sdk";
import type { McpServerConfig, ResourceScope } from "@cca/protocol";
import {
  deleteScopedMcpServer,
  listScopedMcpServers,
  redactMcpServer,
  saveScopedMcpServer,
} from "./mcpServers.js";
import {
  deleteScopedSkill,
  getScopedSkill,
  listScopedSkills,
  saveScopedSkill,
} from "./skills.js";

interface SkillToolArgs {
  action: "list" | "get" | "create" | "update" | "delete";
  scope: ResourceScope;
  name?: string;
  description?: string;
  content?: string;
}

interface McpToolArgs {
  action: "list" | "get" | "create" | "update" | "delete";
  scope: ResourceScope;
  id?: string;
  server?: Partial<McpServerConfig>;
}

export interface AgentResourceToolOptions {
  workspacePath: string;
  canManagePlatform: () => boolean;
  onChanged: (scope: ResourceScope) => Promise<void> | void;
}

function requirePlatformWrite(scope: ResourceScope, canManagePlatform: () => boolean): void {
  if (scope === "platform" && !canManagePlatform()) {
    throw new Error("只有管理员 Agent 可以修改平台级资源");
  }
}

function skillResult(skill: ReturnType<typeof getScopedSkill>) {
  if (!skill) return undefined;
  const { directory: _directory, builtin: _builtin, ...visible } = skill;
  return visible;
}

const BASE_ACTION = { type: "string", enum: ["list", "get", "create", "update", "delete"] } as const;
const SCOPE = { type: "string", enum: ["platform", "workspace"] } as const;

export function createAgentResourceTools(options: AgentResourceToolOptions): [Tool<SkillToolArgs>, Tool<McpToolArgs>] {
  const skillTool = defineTool<SkillToolArgs>("manage_skills", {
    description: "查询、创建、更新或删除平台级和当前 workspace 级 Skill。平台写操作仅管理员可用。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action", "scope"],
      properties: {
        action: BASE_ACTION,
        scope: SCOPE,
        name: { type: "string", description: "技能名称" },
        description: { type: "string", description: "技能描述" },
        content: { type: "string", description: "技能 Markdown 内容" },
      },
    },
    defer: "never",
    handler: async (args) => {
      const workspace = args.scope === "workspace" ? options.workspacePath : undefined;
      if (args.action === "list") {
        return JSON.stringify(listScopedSkills(args.scope, workspace).map(skillResult), null, 2);
      }
      if (!args.name) throw new Error("该操作需要技能名称");
      if (args.action === "get") {
        const skill = getScopedSkill(args.scope, args.name, workspace);
        if (!skill) throw new Error("技能不存在");
        return JSON.stringify(skillResult(skill), null, 2);
      }
      requirePlatformWrite(args.scope, options.canManagePlatform);
      if (args.action === "delete") {
        deleteScopedSkill(args.scope, args.name, workspace);
        await options.onChanged(args.scope);
        return `已删除 ${args.scope} 技能 /${args.name}`;
      }
      if (args.content === undefined) throw new Error("创建或更新技能需要 content");
      const skill = saveScopedSkill(
        args.scope,
        args.name,
        args.description ?? "",
        args.content,
        workspace,
        args.action,
      );
      await options.onChanged(args.scope);
      return JSON.stringify(skillResult(skill), null, 2);
    },
  });

  const mcpTool = defineTool<McpToolArgs>("manage_mcp_servers", {
    description: "查询、创建、更新或删除平台级和当前 workspace 级 MCP 服务器。敏感值在查询结果中会被隐藏，平台写操作仅管理员可用。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action", "scope"],
      properties: {
        action: BASE_ACTION,
        scope: SCOPE,
        id: { type: "string", description: "MCP 服务器标识，用于 get/delete" },
        server: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            enabled: { type: "boolean" },
            type: { type: "string", enum: ["local", "http"] },
            command: { type: "string" },
            args: { type: "array", items: { type: "string" } },
            env: { type: "object", additionalProperties: { type: "string" } },
            cwd: { type: "string" },
            url: { type: "string" },
            headers: { type: "object", additionalProperties: { type: "string" } },
            tools: { type: "array", items: { type: "string" } },
            timeout: { type: "number" },
          },
        },
      },
    },
    defer: "never",
    handler: async (args) => {
      const workspace = args.scope === "workspace" ? options.workspacePath : undefined;
      const servers = listScopedMcpServers(args.scope, workspace);
      if (args.action === "list") {
        return JSON.stringify(servers.map(redactMcpServer), null, 2);
      }
      const id = args.id ?? args.server?.id;
      if (!id) throw new Error("该操作需要 MCP 服务器标识");
      if (args.action === "get") {
        const server = servers.find((candidate) => candidate.id === id);
        if (!server) throw new Error("MCP 服务器不存在");
        return JSON.stringify(redactMcpServer(server), null, 2);
      }
      requirePlatformWrite(args.scope, options.canManagePlatform);
      if (args.action === "delete") {
        deleteScopedMcpServer(args.scope, id, workspace);
        await options.onChanged(args.scope);
        return `已删除 ${args.scope} MCP 服务器 ${id}`;
      }
      if (!args.server) throw new Error("创建或更新 MCP 服务器需要 server 配置");
      const saved = saveScopedMcpServer(args.scope, { ...args.server, id }, workspace, args.action);
      await options.onChanged(args.scope);
      return JSON.stringify(redactMcpServer(saved), null, 2);
    },
  });

  return [skillTool, mcpTool];
}
