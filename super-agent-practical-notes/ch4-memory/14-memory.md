# 14 · 持久化记忆系统

> 章节：第四章 Memory + RAG

## 本讲目标

让 Agent 在进程重启之后仍然记得之前确认过的结论与使用者的习惯。这一讲结束时，记忆按内容类型分开存放，每条记忆带作用范围与状态，检索时按当前上下文过滤。

## 要写的代码

```
src/memory/
├── store.ts     读写四种内容
├── context.ts   注入请求
└── types.ts
```

### 四种内容分开存放

```typescript
export type MemoryTarget = "long_term" | "daily" | "scratchpad";

export type MemoryScope = "global" | `repo/${string}` | `domain/${string}`;

export type Maturity = "draft" | "validated" | "standardized" | "deprecated" | "archived";

export type MemoryMeta = {
  scope: MemoryScope;
  maturity: Maturity;
  refs: number;
  lastRelevant: string;
};
```

目录结构：

```
~/.super-agent/memory/
├── MEMORY.md          长期条目
├── daily/             按日期分开的过程记录
├── SCRATCHPAD.md      待处理事项
└── recovery/          删除操作的恢复记录
```

`src/memory/store.ts`：

```typescript
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export function memoryDir(): string {
  return process.env.SUPER_AGENT_MEMORY_DIR ?? join(homedir(), ".super-agent", "memory");
}

export function todayPath(): string {
  return join(memoryDir(), "daily", `${new Date().toISOString().slice(0, 10)}.md`);
}

export async function appendLongTerm(input: {
  title: string;
  body: string;
  meta: MemoryMeta;
  tags?: string[];
  links?: string[];
  timestamp?: string;
}): Promise<void> {
  const filePath = join(memoryDir(), "MEMORY.md");
  const block = renderBlock(input);
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, `\n${block}\n`, "utf-8");
}

function renderBlock(input: {
  title: string;
  body: string;
  meta: MemoryMeta;
  tags?: string[];
  links?: string[];
  timestamp?: string;
}): string {
  const stamp = input.timestamp ?? new Date().toISOString();
  const tagLine = (input.tags ?? []).map((tag) => `#${tag}`).join(" ");
  const linkLine = (input.links ?? []).map((link) => `[[${link}]]`).join(" ");
  return [
    `<!-- ${stamp} -->`,
    `## ${input.title}`,
    "",
    input.body,
    tagLine ? `\n${tagLine}` : "",
    linkLine ? `\n关联：${linkLine}` : "",
    "",
    "> scope: " + input.meta.scope,
    "> maturity: " + input.meta.maturity,
    "> refs: " + input.meta.refs,
    "> last_relevant: " + input.meta.lastRelevant,
  ]
    .filter((line) => line !== "")
    .join("\n");
}
```

条目末尾的四行元数据都参与检索判定：作用范围决定条目是否参与当前任务的检索，状态决定条目是否仍然有效，引用次数与最近生效时间支撑淘汰判断。

### 写入时机

```typescript
export type MemoryIntent = "explicit" | "task_end" | "scratch";

export async function maybeRemember(input: {
  intent: MemoryIntent;
  title: string;
  body: string;
  scope: MemoryScope;
  tags?: string[];
}): Promise<"written" | "skipped"> {
  if (input.intent === "scratch") {
    await appendScratchpad(input.body);
    return "written";
  }
  if (input.intent === "task_end") {
    const durable = /结论|决策|约定|固定做法|以后都/.test(input.body);
    if (!durable) return "skipped";
  }
  await appendLongTerm({
    title: input.title,
    body: input.body,
    scope: input.scope,
    meta: { scope: input.scope, maturity: "draft", refs: 0, lastRelevant: today() },
    tags: input.tags,
  });
  return "written";
}

export async function appendScratchpad(text: string): Promise<void> {
  const filePath = join(memoryDir(), "SCRATCHPAD.md");
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, `\n- [ ] ${text}\n`, "utf-8");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
```

三种意图的可靠性不同：使用者明确要求记录时立即写入；任务结束时只写入看起来是结论的内容，判断依据是出现了「结论」「决策」「约定」这类词；待处理事项写入待办清单。不加判断地写入是记忆质量下降的主要原因。

### 注入请求

`src/memory/context.ts`：

```typescript
export function selectRelevant(input: {
  entries: MemoryEntry[];
  scope: MemoryScope;
  task: string;
  limit?: number;
}): MemoryEntry[] {
  return input.entries
    .filter((entry) => entry.meta.maturity !== "deprecated" && entry.meta.maturity !== "archived")
    .filter((entry) => entry.meta.scope === "global" || entry.meta.scope === input.scope)
    .map((entry) => ({ entry, score: score(entry, input.task) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit ?? 5)
    .map((item) => item.entry);
}

export function renderForPrompt(entries: MemoryEntry[]): string {
  if (entries.length === 0) return "";
  return [
    "<memory>",
    ...entries.map((entry) =>
      [`- ${entry.title}（${entry.meta.maturity}，来自 ${entry.meta.scope}）`, `  ${entry.body.replace(/\n/g, " ")}`].join("\n"),
    ),
    "</memory>",
  ].join("\n");
}
```

两条过滤规则先执行：状态为已废弃或已归档的条目不参与；作用范围与当前目标不符的条目不参与。第二条是防止跨项目误用的关键。

注入位置放在会话历史之后、本次任务说明之前，这样记忆不会破坏前缀的稳定性。

## pi 的做法

**目录结构一致。** `~/.pi/agent/memory/` 下的组织与讲义相同：`MEMORY.md` 放长期条目，`daily/` 按日期分开，`SCRATCHPAD.md` 放待办，`recovery/` 放删除恢复记录。`pi-memory/index.ts` 里有 `resolveMemoryDir`、`todayStr`、`dailyPath` 等函数负责这些位置。

**条目格式。** 长期条目块以 HTML 注释标记时间与标识，正文之后是关联链接，末尾是四条元数据。检索时可以只读取标题与元数据做初步筛选，命中之后才读正文。

**三种内容分属不同文件。** 长期结论、当日过程、待处理事项写在三处，写入时机各不相同。日常过程不会自动进入长期条目，这条分流规则是抑制噪音最有效的措施。

**注入方式。** `pi-memory` 在 `before_agent_start` 事件里把记忆内容附加到请求上，并在 `session_start` 与 `session_shutdown` 时处理当日记录与退出摘要。注入的内容包在标签里，模型能看出这一段来自记忆。

**工具形式。** 记忆操作以工具形式暴露：`memory_write`、`memory_read`、`memory_forget`、`memory_restore`、`memory_search`、`memory_status`、`scratchpad`。工具名称本身就是一类说明：写、读、删、恢复、检索、体检六种操作各自有明确的入口，模型不需要通过一个万能工具猜测该传什么参数。

**检索模式分层。** `memory_search` 提供关键词、语义、深度三种模式，默认走关键词，精确匹配找不到时才升级到语义。这个顺序本身就是一条优化策略：先走便宜的精确匹配，只在必要时付更贵的语义开销。

## 验收

1. 让 Agent 记住一条约定，进程重启之后提问相关内容，回答里应当出现这条约定，并带上成熟度与作用范围。
2. 把这条记忆的作用范围改成另一个仓库，再用当前仓库提问，这条记忆不应当出现在请求里。
3. 让 Agent 记录一个正在进行的临时事项，它应当进入待办清单，而长期条目文件不变。
4. 打印注入的记忆条目数量与字符数，占用应当保持在请求总长度的很小比例。

## 常见错误

第一个错误是把会话过程全部写入长期记忆。检索被噪音污染，真正有价值的结论被淹没。

第二个错误是记忆不带作用范围。在一个项目里得到的做法被应用到另一个项目，出错时很难发现。

第三个错误是没有状态字段。事实变化之后旧记忆仍然参与检索。

第四个错误是注入位置放在系统提示词里。记忆每次变化都会让提示词前缀失效，成本上升。

第五个错误是用一个万能工具承担全部记忆操作。参数分支过多，模型经常传错模式。