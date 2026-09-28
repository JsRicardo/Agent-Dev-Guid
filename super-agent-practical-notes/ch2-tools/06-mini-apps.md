# 6 · 把工具组装成应用

> 章节：第二章 Tool System

## 本讲目标

把工具集合与系统提示词组合成三个可以直接使用的应用：代码分析、资料研究、代码修改。这一讲结束时，同一套循环与工具层可以按应用切换能力范围。

## 要写的代码

```
src/
├── apps/
│   ├── types.ts          应用定义
│   ├── code-analysis.ts
│   ├── research.ts
│   ├── vibe-coding.ts
│   └── index.ts
├── tools/
│   └── sets.ts           工具集合预设
└── cli.ts                按应用启动
```

### 应用定义

`src/apps/types.ts`：

```typescript
import type { Tool } from "../tools/registry.ts";

export type App = {
  name: string;
  systemPrompt: string;
  tools: Tool[];
  limits: { maxSteps: number; maxTokens: number; maxRepeats: number };
  acceptance?: (result: { text: string; changedFiles: string[] }) => Promise<{ ok: boolean; reason: string }>;
};
```

四个字段各有用途：`tools` 决定能力范围，`systemPrompt` 决定行为方式，`limits` 决定成本上限，`acceptance` 决定「完成」的判定方式。第四个字段是可选的，代码修改类应用需要它。

`src/tools/sets.ts`：

```typescript
import { listTools, type Tool } from "./registry.ts";

const READ_ONLY_NAMES = new Set(["read", "grep", "glob", "list"]);
const CODING_NAMES = new Set(["read", "write", "edit", "grep", "glob", "bash"]);

export function readOnlyTools(): Tool[] {
  return listTools().filter((tool) => READ_ONLY_NAMES.has(tool.name));
}

export function codingTools(): Tool[] {
  return listTools().filter((tool) => CODING_NAMES.has(tool.name));
}

export function toolsByName(names: string[]): Tool[] {
  const wanted = new Set(names);
  return listTools().filter((tool) => wanted.has(tool.name));
}
```

### 代码分析

```typescript
import { readOnlyTools } from "../tools/sets.ts";
import type { App } from "./types.ts";

export const codeAnalysisApp: App = {
  name: "code-analysis",
  systemPrompt: [
    "你负责分析代码并给出结论。可以读取文件、按内容搜索、按文件名搜索。",
    "",
    "工作要求：",
    "- 先建立整体认识，再深入具体文件，避免一开始就读取大文件",
    "- 每个结论都要给出文件路径与行号",
    "- 无法从代码中确定的推断要标明为推断",
    "- 需要数据支撑时用搜索工具确认，不凭印象作答",
  ].join("\n"),
  tools: readOnlyTools(),
  limits: { maxSteps: 25, maxTokens: 120_000, maxRepeats: 3 },
};
```

只读工具集合有一个容易被忽略的作用：它同时限制了破坏能力。分析类应用不需要写入工具，把写入工具移除之后，模型也不会误操作。

### 资料研究

```typescript
import { toolsByName } from "../tools/sets.ts";
import type { App } from "./types.ts";

export const researchApp: App = {
  name: "research",
  systemPrompt: [
    "你负责查证事实并给出带来源的结论。",
    "",
    "工作要求：",
    "- 一次查询里给出两到四个角度不同的检索词，不要用换词重述同一个角度",
    "- 结论必须带链接来源，没有来源的内容标明为推测",
    "- 多处来源互相矛盾时同时列出并说明冲突位置",
    "- 结论写入文件时保留来源链接",
  ].join("\n"),
  tools: toolsByName(["web_search", "get_search_content", "read", "write"]),
  limits: { maxSteps: 40, maxTokens: 200_000, maxRepeats: 3 },
};
```

### 代码修改

```typescript
import { codingTools } from "../tools/sets.ts";
import type { App } from "./types.ts";

export const vibeCodingApp: App = {
  name: "vibe-coding",
  systemPrompt: [
    "你负责修改代码并验证修改结果。",
    "",
    "工作要求：",
    "- 改动之前先读取目标文件的完整内容",
    "- 一次只解决一个问题，改动范围保持最小",
    "- 修改之后必须运行类型检查或测试，把命令与输出写进结论",
    "- 无法验证时明确说明哪一步没有验证",
  ].join("\n"),
  tools: codingTools(),
  limits: { maxSteps: 60, maxTokens: 400_000, maxRepeats: 3 },
  async acceptance({ text, changedFiles }) {
    if (changedFiles.length === 0) {
      return { ok: false, reason: "没有检测到文件改动" };
    }
    const verified = /npm run (type-check|test|lint)|pnpm (type-check|test|lint)/.test(text);
    if (!verified) {
      return { ok: false, reason: "结论里没有出现验证命令的执行记录" };
    }
    return { ok: true, reason: `改动 ${changedFiles.length} 个文件并给出了验证记录` };
  },
};
```

`acceptance` 的判定方式很朴素：检查结论里是否出现了验证命令的执行记录，以及是否真的有文件被改动。这类检查的价值在于把「子程序说自己做完了」与「确实做完了」区分开。更严格的做法是执行一条命令并把退出码作为判定依据，这一点在第 22 讲讨论子智能体时会用到。

### 统计改动文件

`agent/loop.ts` 在执行工具时收集改动过的路径：

```typescript
const changedFiles = new Set<string>();
// 执行工具之后
if (["write", "edit"].includes(call.name)) {
  const args = call.args as { path?: string };
  if (args.path) changedFiles.add(args.path);
}
```

## pi 的做法

**工具集合预设。** `dist/core/tools/index.js` 导出了几组现成集合：

| 函数 | 内容 |
|------|------|
| `createCodingTools(cwd)` | `read`、`bash`、`edit`、`write` |
| `createReadOnlyTools(cwd)` | `read`、`grep`、`find`、`ls` |
| `createAllTools(cwd)` | 全部八个 |

只读集合与完整集合在代码里是两个显式的函数，调用处按场景选择。

**按角色收窄工具。** `pi-subagents` 的 agent 定义用 frontmatter 声明工具白名单，讲义里的 `toolsByName` 对应这一处：

```yaml
---
name: scout
description: Fast codebase recon
tools: read, grep, find, ls
---
```

内置角色里，`scout` 用只读集合做代码侦察，`worker` 用完整集合做实现，`reviewer` 检查实现并做小范围修正。三个角色的系统提示词与工具集合一一对应。

**验收位置。** `pi-subagents` 的工具参数里有 `acceptance` 与 `gate`：`acceptance` 决定证据策略，`gate` 在子智能体结束之后执行一条命令，把命令的退出码与结构化输出作为判定依据。讲义里的 `acceptance` 函数对应第一种。

**模型分组。** 不同应用适合不同模型。pi 允许在子智能体定义里指定模型，也可以在主会话里切换。讲义里可以把模型写进 `App` 定义，分析类应用使用成本较低的模型，代码修改类应用使用工具调用准确率较高的模型。

## 验收

1. 用分析应用提问「这个项目怎么做错误处理的」，回答应当给出文件路径与行号，且没有出现任何写入操作。
2. 用研究应用提问一个需要近期信息的问题，回答应当带链接来源；把 `web_search` 从应用定义里移除后再提问，模型应当明确说明缺少检索能力。
3. 用代码修改应用完成一个小改动，`acceptance` 检查应当返回通过；把验证命令那一步去掉再跑一次，检查应当返回不通过。

## 常见错误

第一个错误是三个应用共用一份系统提示词。分析类工作的要求是给出依据，修改类工作的要求是完成验证，两者的行为方式差别很大。

第二个错误是给分析类应用挂载写入工具。能力范围应当与任务范围一致。

第三个错误是把上限设得过高。上限的作用是防止失控，设成不可能达到的数值等于没有上限。

第四个错误是验收只检查文字。模型很容易写出「已完成」这类表述，验收需要检查具体证据，例如文件是否真的改动、命令是否真的执行。

第五个错误是同一个应用里混用两个模型。同一会话中途切换模型会让提示词缓存失效，成本上升。