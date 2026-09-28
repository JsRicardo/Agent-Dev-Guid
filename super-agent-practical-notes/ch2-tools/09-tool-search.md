# 9 · 实现 ToolSearch

> 章节：第二章 Tool System

## 本讲目标

在工具数量增长之后保持选择准确率与请求开销可控。这一讲结束时，工具全部注册但只有一部分处于启用状态，模型可以通过一个检索工具把需要的工具启用起来，启用与停用会被记录进会话。

## 要写的代码

```
src/tools/
├── registry.ts        第 4 讲，本讲加入启用状态
├── tool-search.ts     检索与启用
└── state.ts           启用状态与变化记录
```

### 启用状态

`src/tools/state.ts`：

```typescript
import type { Message } from "../types.ts";
import { listTools } from "./registry.ts";

export type ToolStateChange = { added: string[]; removed: string[] };

let activeNames = new Set<string>();

export function setActiveTools(names: string[]): ToolStateChange {
  const known = new Set(listTools().map((tool) => tool.name));
  const next = new Set(names.filter((name) => known.has(name)));
  const added = [...next].filter((name) => !activeNames.has(name));
  const removed = [...activeNames].filter((name) => !next.has(name));
  activeNames = next;
  return { added, removed };
}

export function getActiveTools() {
  return listTools().filter((tool) => activeNames.has(tool.name));
}

/** 把启用状态的变化写成一条系统消息，随会话一起保存。 */
export function declareToolChanges(change: ToolStateChange): Message | undefined {
  if (change.added.length === 0 && change.removed.length === 0) return undefined;
  return {
    role: "system",
    text: "",
    toolsAdded: change.added,
    toolsRemoved: change.removed,
  };
}

/** 回放会话里的系统消息，得到当前的启用集合。 */
export function replayToolState(messages: Message[]): Set<string> {
  const active = new Set<string>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    for (const name of message.toolsAdded ?? []) active.add(name);
    for (const name of message.toolsRemoved ?? []) active.delete(name);
  }
  return active;
}
```

启用状态写进会话记录有一个直接好处：回放即可复现当时的工具集合，不需要额外的状态文件，也不会出现在内存里与实际请求不一致的情况。

### 检索工具

`src/tools/tool-search.ts`：

```typescript
import { registerTool, listTools, type ToolResult } from "./registry.ts";
import { getActiveTools, setActiveTools } from "./state.ts";

const CORE_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "glob"]);

export function registerToolSearchTool(): void {
  registerTool({
    name: "search_tools",
    description:
      "按关键词检索可用工具。当你需要的功能不在当前工具列表里时使用。返回匹配工具的名称与说明，并自动把它们启用。",
    snippet: "按关键词检索并启用工具",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "需要的功能描述，例如「创建 issue」「发送消息」" },
        limit: { type: "number", description: "最多返回多少个工具，默认 5" },
      },
      required: ["query"],
    },
    async execute(args: { query: string; limit?: number }): Promise<ToolResult> {
      const active = new Set(getActiveTools().map((tool) => tool.name));
      const candidates = listTools().filter((tool) => tool.name !== "search_tools");

      const scored = candidates
        .map((tool) => ({ tool, score: relevance(args.query, tool) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, args.limit ?? 5);

      if (scored.length === 0) {
        return {
          content: `没有找到与「${args.query}」相关的工具。可以换一个说法，或者用现有工具完成。`,
        };
      }

      const toActivate = scored.map((item) => item.tool.name);
      const change = setActiveTools([...active, ...toActivate]);

      return {
        content: scored
          .map((item) => `- ${item.tool.name}：${item.tool.description}`)
          .join("\n"),
        details: {
          activated: change.added,
          alreadyActive: toActivate.filter((name) => active.has(name)),
        },
      };
    },
  });
}

function relevance(query: string, tool: { name: string; description: string; snippet?: string }): number {
  const haystack = `${tool.name} ${tool.description} ${tool.snippet ?? ""}`.toLowerCase();
  const tokens = query.toLowerCase().split(/\s+/).filter((token) => token.length > 1);
  let score = 0;
  for (const token of tokens) {
    if (tool.name.toLowerCase().includes(token)) score += 3;
    if (haystack.includes(token)) score += 1;
  }
  return score;
}
```

检索一开始用关键词匹配就够用。它的优点是可解释：命中原因看得见，检索失败时容易判断是描述写得不好还是查询用词不对。

### 首次启用与数量控制

```typescript
// src/cli.ts 启动时
setActiveTools([...CORE_TOOLS]);
```

初始集合放核心工具，其余工具处于未启用状态。工具数量与选择准确率的关系是非线性的：经验阈值在二十个左右，超过之后选择错误开始明显增加，具体数值取决于工具之间的相似程度。

### 请求开销的观察

```typescript
// 打印每一轮的工具定义占用
const declarations = getActiveTools().map((tool) => ({
  name: tool.name,
  description: tool.description,
  parameters: tool.parameters,
}));
console.error(`[工具] ${declarations.length} 个，定义约 ${JSON.stringify(declarations).length} 字符`);
```

这一步在接入 MCP 之后尤其有必要：一个功能完整的服务端可能暴露十几个工具，接入三个之后工具总数就接近阈值。

## pi 的做法

**注册与启用分开。** `docs/extensions.md` 里的做法是先把所有工具注册，把可选工具保持未启用，再由一个加载工具调用 `pi.setActiveTools()` 选择要启用的集合：

```
Register every tool first, keep optional tools inactive, and use pi.setActiveTools()
from a loader tool to select the desired active tools. Names must already be registered;
unknown names are ignored.
```

讲义里的 `setActiveTools` 与它对应，并且做了同一件事：过滤掉未注册的名称。

**变化写进会话记录。** pi 在每一轮请求之前比较会话记录里已声明的工具与当前可执行的工具，把差集写成一条系统消息的 `toolsAdded` 与 `toolsRemoved` 字段：

```typescript
const changes = getToolStateChanges(
  getCurrentTools([...context.messages, ...baseline]),
  (context.tools ?? []).map(toToolDeclaration),
);
```

这样回放会话记录就能得到当前提示词与工具集合，不需要额外的状态文件。

**缓存的代价。** pi 的文档明确提示一个副作用：

```
Providers that cannot represent the transition receive a complete transcript checkpoint,
which can invalidate the cached prefix.
```

启用集合变化会改变工具定义这一段，前缀随之失效。第 13 讲会看到，工具定义位于请求的最前面，这一段变化会让整条请求重新计费。因此启用动作应当集中发生，避免每轮都调整集合。

**子智能体侧的白名单。** `pi-subagents` 的 `tools` frontmatter 是严格白名单，未列出的内置工具子智能体拿不到。白名单在启动时确定，运行中不变化，因此不存在缓存失效的问题。

## 验收

1. 启动时启用工具数量应当只有核心集合，打印出来的定义字符数明显低于全部工具。
2. 提问一个需要 MCP 工具才能完成的任务，模型应当先调用 `search_tools`，被启用的工具出现在下一次请求的工具列表里。
3. 打印会话记录里的系统消息，应当看到 `toolsAdded` 字段随启用动作出现。
4. 在启用了额外工具之后再提问一个只需要核心工具的任务，请求的工具定义字符数应当保持不变。

## 常见错误

第一个错误是把全部工具一次性启用。接入成本低，运行时成本高。

第二个错误是让检索工具返回工具定义全文。完整定义由启用动作之后统一生成，检索结果只需要名称与简短说明。

第三个错误是启用之后不记录变化。会话恢复之后启用集合与实际请求不一致，回放无法复现当时的行为。

第四个错误是每一轮都调整启用集合。工具定义段每次变化都会让前缀缓存失效，成本上升幅度明显。

第五个错误是检索按实现模块分组。模型判断依据是任务意图，按代码目录分组会让它在需要的时刻找不到工具。