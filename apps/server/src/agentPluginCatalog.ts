import type { PluginConformance } from "@cca/protocol";

/**
 * 内置插件包:直接以文件内容形式随服务端发布,安装时写到插件目录。
 * 这样即使没有外网,GitHub 市场也能一键装出可用的 Agent Plugin。
 */
export interface BuiltinPluginPackage {
  id: string;
  files: Record<string, string>;
}

export interface CatalogPlugin {
  id: string;
  name: string;
  description: string;
  /** 传给 plugins.install 的来源:builtin:<id>、git 地址或本地路径。 */
  source: string;
  subdirectory?: string;
  version?: string;
  author?: string;
  homepage?: string;
  license?: string;
  tags: string[];
  category: string;
  conformance?: PluginConformance;
}

export interface BuiltinCatalog {
  id: string;
  name: string;
  description: string;
  plugins: CatalogPlugin[];
}

const manifest = (input: {
  name: string;
  version: string;
  description: string;
  keywords: string[];
  author?: string;
  license?: string;
}) => `${JSON.stringify({
  $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  name: input.name,
  version: input.version,
  description: input.description,
  author: { name: input.author ?? "Kloud" },
  license: input.license ?? "MIT",
  keywords: input.keywords,
}, null, 2)}\n`;

const skill = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body.trim()}\n`;

const CODE_REVIEW_SKILL = skill(
  "code-review",
  "按严重级别评审代码改动,定位缺陷、回归风险与缺失的测试,输出可直接执行的修改建议。",
  `
# 代码评审

## 何时使用
用户要求评审 commit、分支、PR 或某个改动集时。

## 流程
1. 先读改动:用 \`git diff\` / \`git log -p\` 拿到完整上下文,不要只看片段。
2. 重建意图:从提交信息、issue、相关测试推出"这次改动想做什么"。
3. 沿调用链检查:改动的函数被谁调用、错误路径、并发与边界值。
4. 只报告有证据的问题;不确定时写明"需要确认",不要臆测。

## 检查清单
- 正确性:边界值、空值、时区/编码、整数溢出、浮点比较。
- 错误处理:异常是否被吞掉、失败是否可观测、重试是否幂等。
- 并发与状态:共享可变状态、竞态、锁顺序、事务边界。
- 安全:注入、路径穿越、权限校验缺失、日志中泄露凭据。
- 兼容性:接口/协议/数据库 schema 的破坏性变更与迁移路径。
- 测试:新分支是否有覆盖;缺失的用例要具体写出来。

## 输出格式
按严重级别分组,每条包含:位置(\`path:line\`)、问题、影响、建议改法(必要时给最小 diff)。最后给出结论:可以合并 / 修改后再看 / 需要重新设计。
`,
);

const BUG_HUNT_SKILL = skill(
  "bug-hunt",
  "系统化调试:先复现再定位,用假设-证据循环收敛到最小根因,并补上回归测试。",
  `
# 系统化排障

## 原则
先复现,再定位;一次只验证一个假设。禁止在没有证据时直接改代码。

## 步骤
1. **描述现象**:期望行为 vs 实际行为、环境(版本/平台/数据)、首次出现时间。
2. **最小复现**:把问题缩到最短命令或最小输入;记录可重复的步骤。
3. **收集证据**:日志、堆栈、网络请求、相关变量的实际值(不要靠猜)。
4. **提出假设**:写下来,并设计一个能证伪它的检查。
5. **二分定位**:按时间/数据/代码路径二分,快速缩小范围。
6. **根因修复**:修因不修表;如果只能先止血,明确标注临时方案与后续任务。
7. **回归测试**:补一条能在旧代码上失败、在新代码上通过的测试。

## 输出
- 复现步骤
- 根因(带证据引用)
- 修复说明与风险
- 新增/调整的测试
`,
);

const API_DESIGN_SKILL = skill(
  "api-design",
  "设计或评审 HTTP/RPC 接口:资源建模、错误语义、分页与幂等、版本与兼容性。",
  `
# 接口设计评审

## 建模
- 资源用名词复数,动作用 HTTP 方法;避免把动词塞进路径。
- 一个接口只做一件事;批量操作显式建模,不要靠隐式数组语义。
- 列表接口必须有分页(cursor 优先)与稳定的排序。

## 语义
- 状态码与业务错误分离:HTTP 表达传输层,响应体 \`code\` 表达业务原因。
- 错误体固定结构(\`code\`/\`message\`/\`details\`),不要把堆栈或 SQL 暴露给调用方。
- 创建类接口考虑幂等键;重试必须安全。
- 时间统一 UTC ISO-8601;金额用最小货币单位的整数。

## 兼容性
- 新增字段可兼容,改名/改类型是破坏性变更:需要版本或过渡期。
- 枚举增加取值前确认客户端是否做穷举。
- 明确空值语义(null vs 缺省 vs 空数组)。

## 交付
给出:接口清单(方法/路径/入参/出参/错误码)、OpenAPI 片段、迁移与灰度方案。
`,
);

const DATA_ANALYSIS_SKILL = skill(
  "data-analysis",
  "数据分析流程:先确认口径,再做可复现的清洗与统计,最后给出结论与不确定性。",
  `
# 数据分析

## 口径先行
开始计算前,用一句话写清:分析对象、时间范围、过滤条件、指标定义。口径不清就先问。

## 可复现
- 所有清洗步骤写成脚本(python + pandas),不要手工改表。
- 数据源只读;中间产物落盘并注明来源与生成时间。
- 记录每一步的行数变化,用来发现意外的过滤/重复。

## 检查清单
- 缺失值:比例、是否随机缺失、填充策略。
- 重复行:主键是否唯一。
- 异常值:是录入错误还是真实长尾,分开处理。
- 分母:比率类指标先核对分母,避免"百分比加起来不等于 100"。
- 时间:时区、夏令时、跨月边界的聚合。

## 输出
结论先行,再给图表与口径说明;标注样本量与置信度,明确哪些结论受限于数据质量。
`,
);

const DOC_WRITER_SKILL = skill(
  "doc-writer",
  "技术文档写作:README、ADR、变更说明与故障复盘,结构清晰、可执行、面向读者。",
  `
# 技术文档写作

## 先确定读者与用途
是给新用户上手(README)、给团队做决策(ADR),还是给运维排障(复盘)?读者决定详略。

## 通用结构
1. 一句话说明这是什么、解决什么问题。
2. 快速开始:最短的可运行示例(命令可直接复制)。
3. 关键概念与配置项表格。
4. 常见问题与限制。
5. 变更记录或相关链接。

## 写作要求
- 用主动语态与具体名词,避免"可能/大概/应该"这类含糊表述。
- 命令、路径、字段名用行内代码;多行命令用代码块并标注语言。
- 每个链接写清指向什么,不要裸贴 URL。
- 删除形容词,保留事实与约束。

## ADR 模板
背景 → 决策 → 备选方案与取舍 → 影响(含回滚方式)。
`,
);

const MEMORY_SKILL = skill(
  "memory-notes",
  "用记忆图谱跨会话保存用户偏好、项目约定与长期事实,并在需要时检索。",
  `
# 长期记忆

本插件提供一个 MCP 记忆服务器(知识图谱),工具通常以 \`mcp__memory__*\` 形式出现。

## 何时写入
- 用户明确说"记住…"。
- 稳定的偏好或约定(技术栈、命名习惯、发布流程)。
- 项目的长期事实(仓库职责、关键路径、负责人)。

不要写入:一次性任务细节、可从代码/文档直接查到的事实。

## 何时读取
开始一个不熟悉的任务前,先检索是否已有相关实体与观察值;回答"上次我们怎么做的"类问题时必须先查。

## 约定
- 实体名用稳定标识(如 \`project:cloud-coding-agent\`、\`user:alice\`)。
- 观察值写成"事实 + 时间",避免把推测写成事实。
- 结论过时了就更新,不要堆叠相互矛盾的观察值。
`,
);

const memoryMcpConfig = `${JSON.stringify({
  $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  mcpServers: {
    memory: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory"],
      // 服务器默认把 memory.json 写在 cwd 下,而 cwd 已指向插件私有数据目录
      cwd: "${PLUGIN_DATA}",
    },
  },
}, null, 2)}\n`;

/**
 * 随服务端发布的一方法插件包。全部遵循 Agent Plugins 1.0.0:
 * plugin.json 声明规范版本,技能放在 skills/<name>/SKILL.md。
 */
export const BUILTIN_PLUGIN_PACKAGES: BuiltinPluginPackage[] = [
  {
    id: "code-review",
    files: {
      "plugin.json": manifest({
        name: "code-review",
        version: "1.0.0",
        description: "结构化代码评审:按严重级别给出缺陷、回归风险与修改建议。",
        keywords: ["review", "quality", "pull-request"],
      }),
      "skills/code-review/SKILL.md": CODE_REVIEW_SKILL,
    },
  },
  {
    id: "bug-hunt",
    files: {
      "plugin.json": manifest({
        name: "bug-hunt",
        version: "1.0.0",
        description: "系统化调试:复现、证据、假设-验证循环,收敛到最小根因。",
        keywords: ["debug", "troubleshooting", "root-cause"],
      }),
      "skills/bug-hunt/SKILL.md": BUG_HUNT_SKILL,
    },
  },
  {
    id: "api-design",
    files: {
      "plugin.json": manifest({
        name: "api-design",
        version: "1.0.0",
        description: "接口设计与评审:资源建模、错误语义、分页、幂等与兼容性。",
        keywords: ["api", "rest", "openapi", "design"],
      }),
      "skills/api-design/SKILL.md": API_DESIGN_SKILL,
    },
  },
  {
    id: "data-analysis",
    files: {
      "plugin.json": manifest({
        name: "data-analysis",
        version: "1.0.0",
        description: "数据分析:口径先行、可复现的清洗与统计、结论与不确定性。",
        keywords: ["data", "pandas", "analysis", "csv"],
      }),
      "skills/data-analysis/SKILL.md": DATA_ANALYSIS_SKILL,
    },
  },
  {
    id: "doc-writer",
    files: {
      "plugin.json": manifest({
        name: "doc-writer",
        version: "1.0.0",
        description: "技术文档写作:README、ADR、变更说明与故障复盘的结构与要求。",
        keywords: ["docs", "readme", "adr", "writing"],
      }),
      "skills/doc-writer/SKILL.md": DOC_WRITER_SKILL,
    },
  },
  {
    id: "mcp-memory",
    files: {
      "plugin.json": manifest({
        name: "mcp-memory",
        version: "1.0.0",
        description: "跨会话长期记忆:附带一个 MCP 知识图谱服务器与使用约定。",
        keywords: ["memory", "mcp", "knowledge-graph"],
      }),
      "skills/memory-notes/SKILL.md": MEMORY_SKILL,
      "mcp.json": memoryMcpConfig,
    },
  },
];

/**
 * 内置市场:一方法插件 + 已按 Agent Plugins 结构整理的上游官方插件仓库。
 * 上游条目在兼容模式下解析(它们的 plugin.json 还没有 $schema 字段),
 * 安装后仍会经过同一套校验与组件发现。
 */
export const BUILTIN_CATALOG: BuiltinCatalog = {
  id: "builtin",
  name: "官方精选",
  description: "随应用发布的一方法插件,以及已验证结构的官方 Agent Plugins 仓库。",
  plugins: [
    {
      id: "builtin/code-review",
      name: "code-review",
      description: "结构化代码评审:按严重级别给出缺陷、回归风险与修改建议。",
      source: "builtin:code-review",
      version: "1.0.0",
      author: "Kloud",
      license: "MIT",
      tags: ["review", "quality"],
      category: "编码",
      conformance: "agent-plugins-1.0.0",
    },
    {
      id: "builtin/bug-hunt",
      name: "bug-hunt",
      description: "系统化调试:复现、证据、假设-验证循环,收敛到最小根因。",
      source: "builtin:bug-hunt",
      version: "1.0.0",
      author: "Kloud",
      license: "MIT",
      tags: ["debug", "root-cause"],
      category: "调试",
      conformance: "agent-plugins-1.0.0",
    },
    {
      id: "builtin/api-design",
      name: "api-design",
      description: "接口设计与评审:资源建模、错误语义、分页、幂等与兼容性。",
      source: "builtin:api-design",
      version: "1.0.0",
      author: "Kloud",
      license: "MIT",
      tags: ["api", "openapi"],
      category: "设计",
      conformance: "agent-plugins-1.0.0",
    },
    {
      id: "builtin/data-analysis",
      name: "data-analysis",
      description: "数据分析:口径先行、可复现的清洗与统计、结论与不确定性。",
      source: "builtin:data-analysis",
      version: "1.0.0",
      author: "Kloud",
      license: "MIT",
      tags: ["data", "pandas"],
      category: "数据",
      conformance: "agent-plugins-1.0.0",
    },
    {
      id: "builtin/doc-writer",
      name: "doc-writer",
      description: "技术文档写作:README、ADR、变更说明与故障复盘的结构与要求。",
      source: "builtin:doc-writer",
      version: "1.0.0",
      author: "Kloud",
      license: "MIT",
      tags: ["docs", "adr"],
      category: "文档",
      conformance: "agent-plugins-1.0.0",
    },
    {
      id: "builtin/mcp-memory",
      name: "mcp-memory",
      description: "跨会话长期记忆:附带一个 MCP 知识图谱服务器与使用约定。",
      source: "builtin:mcp-memory",
      version: "1.0.0",
      author: "Kloud",
      license: "MIT",
      tags: ["memory", "mcp"],
      category: "MCP",
      conformance: "agent-plugins-1.0.0",
    },
    {
      id: "github/microsoft/azure-skills",
      name: "azure",
      description: "微软官方 Azure 插件:Azure MCP 与云端资源管理、部署、诊断技能。",
      source: "https://github.com/microsoft/azure-skills",
      version: "1.2.99",
      author: "Microsoft",
      homepage: "https://github.com/microsoft/azure-skills",
      license: "MIT",
      tags: ["azure", "cloud", "mcp"],
      category: "云服务",
    },
    {
      id: "github/shopify/ai-toolkit",
      name: "shopify-plugin",
      description: "Shopify 官方开发工具:文档检索、GraphQL/Liquid 生成与校验。",
      source: "https://github.com/Shopify/Shopify-AI-Toolkit",
      version: "2.2.0",
      author: "Shopify",
      homepage: "https://github.com/Shopify/Shopify-AI-Toolkit",
      license: "MIT",
      tags: ["shopify", "graphql", "liquid"],
      category: "电商",
    },
    {
      id: "github/aws/serverless",
      name: "aws-serverless",
      description: "AWS 官方无服务器插件:设计、部署与调试 Lambda / SAM / Step Functions。",
      source: "https://github.com/awslabs/agent-plugins",
      subdirectory: "plugins/aws-serverless",
      version: "1.3.0",
      author: "Amazon Web Services",
      homepage: "https://github.com/awslabs/agent-plugins",
      license: "Apache-2.0",
      tags: ["aws", "lambda", "sam"],
      category: "云服务",
    },
    {
      id: "github/aws/deploy",
      name: "deploy-on-aws",
      description: "AWS 官方部署插件:把应用部署到 AWS 的检查清单与自动化步骤。",
      source: "https://github.com/awslabs/agent-plugins",
      subdirectory: "plugins/deploy-on-aws",
      author: "Amazon Web Services",
      homepage: "https://github.com/awslabs/agent-plugins",
      license: "Apache-2.0",
      tags: ["aws", "deploy", "cdk"],
      category: "云服务",
    },
    {
      id: "github/aws/databases",
      name: "databases-on-aws",
      description: "AWS 官方数据库插件:Aurora / DynamoDB 选型、建模与运维建议。",
      source: "https://github.com/awslabs/agent-plugins",
      subdirectory: "plugins/databases-on-aws",
      author: "Amazon Web Services",
      homepage: "https://github.com/awslabs/agent-plugins",
      license: "Apache-2.0",
      tags: ["aws", "database", "dynamodb"],
      category: "数据",
    },
    {
      id: "github/microsoft/windbg",
      name: "windbg",
      description: "微软官方 WinDbg 插件:用调试器分析崩溃转储、调用栈与内存问题。",
      source: "https://github.com/microsoft/win-dev-skills",
      subdirectory: "plugins/windbg",
      author: "Microsoft",
      homepage: "https://github.com/microsoft/win-dev-skills",
      license: "MIT",
      tags: ["windows", "debugging", "windbg"],
      category: "调试",
    },
  ],
};
