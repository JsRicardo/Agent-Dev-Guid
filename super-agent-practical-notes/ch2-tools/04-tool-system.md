# 4 · Tool 注册、执行、截断与并发

> 章节：第二章 Tool System

## 本讲目标

把上一讲写在循环里的工具处理替换成一套注册与执行机制。这一讲结束时，新增工具只需要写一个文件并注册，执行管线负责参数校验、顺序与并发、结果截断、结果消息生成。

## 要写的代码

```
src/
├── tools/
│   ├── registry.ts      注册表与执行管线
│   ├── truncate.ts      结果截断
│   ├── output.ts        输出累积器
│   └── file-queue.ts    同一个文件的写入串行
└── agent/
    └── loop.ts          改为调用执行管线
```

### 工具的定义形状

`src/tools/registry.ts`：

```typescript
import type { ToolCall } from "../types.ts";

export type ToolContext = {
  cwd: string;
  signal?: AbortSignal;
  onUpdate?: (partial: { text: string; fullOutputPath?: string }) => void;
};

export type ToolResult = {
  content: string;
  details?: Record<string, unknown>;
  isError?: boolean;
  terminate?: boolean;
};

export type Tool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  snippet?: string;
  guidelines?: string[];
  executionMode?: "parallel" | "sequential";
  validate?: (args: unknown) => unknown;
  execute: (args: never, ctx: ToolContext) => Promise<ToolResult>;
};

const registry = new Map<string, Tool>();

export function registerTool(tool: Tool): void {
  registry.set(tool.name, tool);
}

export function getTool(name: string): Tool | undefined {
  return registry.get(name);
}

export function listTools(): Tool[] {
  return [...registry.values()];
}

export function toDeclarations(tools: Tool[]) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

export function toSystemPromptParts(tools: Tool[]) {
  const snippets = tools.filter((tool) => tool.snippet).map((tool) => `- ${tool.name}: ${tool.snippet}`);
  const guidelines = tools.flatMap((tool) => tool.guidelines ?? []);
  return { tools: snippets.join("\n"), guidelines: [...new Set(guidelines)] };
}
```

`executionMode` 写在工具定义里，并发策略跟着工具走。读写同一个文件的工具声明为 `sequential`，只读工具保持默认。

### 截断

`src/tools/truncate.ts`：

```typescript
export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;

export type Truncation = {
  content: string;
  truncated: boolean;
  totalLines: number;
  outputLines: number;
  totalBytes: number;
  outputBytes: number;
  truncatedBy: "lines" | "bytes" | null;
  firstLineExceedsLimit: boolean;
};

function splitLines(content: string): string[] {
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

export function truncateHead(
  content: string,
  maxLines = DEFAULT_MAX_LINES,
  maxBytes = DEFAULT_MAX_BYTES,
): Truncation {
  const lines = splitLines(content);
  const totalBytes = Buffer.byteLength(content, "utf-8");

  if (lines.length <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      totalLines: lines.length,
      outputLines: lines.length,
      totalBytes,
      outputBytes: totalBytes,
      truncatedBy: null,
      firstLineExceedsLimit: false,
    };
  }

  if (Buffer.byteLength(lines[0], "utf-8") > maxBytes) {
    return {
      content: "",
      truncated: true,
      totalLines: lines.length,
      outputLines: 0,
      totalBytes,
      outputBytes: 0,
      truncatedBy: "bytes",
      firstLineExceedsLimit: true,
    };
  }

  const kept: string[] = [];
  let bytes = 0;
  let truncatedBy: "lines" | "bytes" = "lines";
  for (const line of lines) {
    if (kept.length >= maxLines) break;
    const lineBytes = Buffer.byteLength(line, "utf-8") + (kept.length > 0 ? 1 : 0);
    if (bytes + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }
    kept.push(line);
    bytes += lineBytes;
  }

  const outputContent = kept.join("\n");
  return {
    content: outputContent,
    truncated: true,
    totalLines: lines.length,
    outputLines: kept.length,
    totalBytes,
    outputBytes: Buffer.byteLength(outputContent, "utf-8"),
    truncatedBy,
    firstLineExceedsLimit: false,
  };
}

export function truncateTail(
  content: string,
  maxLines = DEFAULT_MAX_LINES,
  maxBytes = DEFAULT_MAX_BYTES,
): Truncation {
  const reversed = [...splitLines(content)].reverse();
  const kept: string[] = [];
  let bytes = 0;
  let truncatedBy: "lines" | "bytes" = "lines";
  for (const line of reversed) {
    if (kept.length >= maxLines) break;
    const lineBytes = Buffer.byteLength(line, "utf-8") + (kept.length > 0 ? 1 : 0);
    if (bytes + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }
    kept.unshift(line);
    bytes += lineBytes;
  }
  const outputContent = kept.join("\n");
  const totalBytes = Buffer.byteLength(content, "utf-8");
  return {
    content: outputContent,
    truncated: true,
    totalLines: reversed.length,
    outputLines: kept.length,
    totalBytes,
    outputBytes: Buffer.byteLength(outputContent, "utf-8"),
    truncatedBy,
    firstLineExceedsLimit: false,
  };
}

export function truncationNotice(result: Truncation, fullOutputPath?: string): string {
  if (!result.truncated) return "";
  const reason = result.truncatedBy === "lines" ? `${result.totalLines} 行` : `${Math.ceil(result.totalBytes / 1024)}KB`;
  const suffix = fullOutputPath ? ` 完整内容：${fullOutputPath}` : "";
  return `\n\n[输出被截断：共 ${reason}，已显示 ${result.outputLines} 行。${suffix}]`;
}
```

两个方向对应两种用途：读取文件保留开头，执行命令保留结尾。截断标记必须写进结果，模型看不到标记会以为内容完整。

### 输出累积器

执行命令这类输出未知长度的工具需要一个累积器，它同时承担三件事：累积输出、超出上限时写入临时文件、以节流方式汇报进度。

`src/tools/output.ts`：

```typescript
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { truncateTail, truncationNotice, type Truncation } from "./truncate.ts";

export class OutputAccumulator {
  private chunks: string[] = [];
  private bytes = 0;
  private fullOutputPath?: string;
  private finished = false;

  constructor(private readonly maxBytes = 50 * 1024, private readonly maxLines = 2000) {}

  append(chunk: string): void {
    if (this.finished) return;
    this.chunks.push(chunk);
    this.bytes += Buffer.byteLength(chunk, "utf-8");
  }

  finish(): void {
    this.finished = true;
  }

  async snapshot(persistIfTruncated: boolean): Promise<{ content: string; truncation: Truncation; fullOutputPath?: string }> {
    const raw = this.chunks.join("");
    const truncation = truncateTail(raw, this.maxLines, this.maxBytes);
    if (truncation.truncated && persistIfTruncated && !this.fullOutputPath) {
      const dir = await mkdtemp(join(tmpdir(), "agent-output-"));
      this.fullOutputPath = join(dir, "full.log");
      await writeFile(this.fullOutputPath, raw, "utf-8");
    }
    return { content: truncation.content, truncation, fullOutputPath: this.fullOutputPath };
  }
}
```

### 执行管线

```typescript
const UPDATE_THROTTLE_MS = 100;

export async function executeToolCalls(
  calls: ToolCall[],
  ctx: { cwd: string; signal?: AbortSignal; onUpdate: (callId: string, partial: { text: string }) => void },
  hooks: { before?: BeforeToolHook; after?: AfterToolHook },
): Promise<Message[]> {
  const hasSequential = calls.some((call) => getTool(call.name)?.executionMode === "sequential");
  return hasSequential ? runSequential(calls, ctx, hooks) : runParallel(calls, ctx, hooks);
}

async function prepare(call: ToolCall, ctx: ToolContext, hooks: { before?: BeforeToolHook }) {
  const tool = getTool(call.name);
  if (!tool) {
    return { error: `找不到工具 ${call.name}` };
  }
  let args = call.args;
  try {
    args = tool.validate ? tool.validate(args) : args;
  } catch (error) {
    return { error: `参数不合法：${error instanceof Error ? error.message : String(error)}` };
  }
  const decision = await hooks.before?.({ call, args, cwd: ctx.cwd });
  if (decision?.block) {
    return { error: decision.reason ?? "该操作被阻止" };
  }
  return { tool, args: decision?.args ?? args };
}
```

并发版本的返回顺序必须与调用顺序一致：

```typescript
async function runParallel(calls, ctx, hooks) {
  const prepared = [];
  for (const call of calls) {
    prepared.push(await prepare(call, ctx, hooks));
  }

  const settled = await Promise.all(
    prepared.map(async (item, index) => {
      const call = calls[index];
      if ("error" in item) {
        return { call, text: item.error!, isError: true };
      }
      return runOne(call, item.tool!, item.args, ctx, hooks);
    }),
  );

  return settled.map((item, index) => ({
    role: "toolResult" as const,
    callId: calls[index].id,
    name: calls[index].name,
    text: item.text,
    isError: item.isError,
  }));
}
```

`src/tools/file-queue.ts` 负责同一个路径上的写入串行：

```typescript
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

const queues = new Map<string, Promise<void>>();

export function withFileMutationQueue<T>(filePath: string, run: () => Promise<T>): Promise<T> {
  const key = resolve(filePath);
  const previous = queues.get(key) ?? Promise.resolve();

  const current = previous.then(async () => {
    let real = key;
    try {
      real = await realpath(key);
    } catch {
      // 文件还不存在时用解析后的路径作为队列键
    }
    try {
      return await run();
    } finally {
      if (queues.get(key) === current) queues.delete(key);
    }
  });

  queues.set(key, current.then(() => undefined, () => undefined));
  return current;
}
```

写入类工具的执行体整体包在这个函数里，读取与写入位于同一文件时不会互相干扰。

## pi 的做法

**工具定义位置。** 每个内置工具一个文件，导出定义与执行体：`dist/core/tools/read.js`、`edit.js`、`grep.js`、`find.js`、`bash.js`、`ls.js`、`write.js`。定义里带 `promptSnippet` 与 `promptGuidelines`，由 `dist/core/system-prompt.js` 的 `buildRules` 收集成系统提示词的段落。讲义里的 `toSystemPromptParts` 对应这一处。

**并发策略。** pi 在 `agent-loop.js` 里按 `executionMode` 决定整批的执行方式，与讲义里的 `executeToolCalls` 相同。区别在于 pi 的顺序版本会在每一项之间检查中止信号，中止时立即停止后续调用。

**截断。** `dist/core/tools/truncate.js` 的实现与讲义一致：两个上限谁先命中按谁处理，都不返回不完整的行，`truncateHead` 在首行就超出字节上限时返回空内容并置 `firstLineExceedsLimit`，读取工具据此提示模型改用命令行方式查看。`grep` 另外把每一行截到 500 字符。

**超大输出的处理位置。** 命令类工具的完整输出由 `OutputAccumulator` 写入临时文件，结果里附上路径。`bash.js` 的描述直接写明这一点：

```
Output is truncated to last 2000 lines or 50KB (whichever is hit first).
If truncated, full output is saved to a temp file.
```

**进度汇报的节流。** `bash.js` 里按固定间隔合并输出更新：

```typescript
const scheduleOutputUpdate = () => {
  if (!onUpdate) return;
  updateDirty = true;
  const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
  if (delay <= 0) {
    clearUpdateTimer();
    emitOutputUpdate();
    return;
  }
  updateTimer ??= setTimeout(() => {
    updateTimer = undefined;
    emitOutputUpdate();
  }, delay);
};
```

**同一个文件的写入串行。** `dist/core/tools/file-mutation-queue.js` 的 `withFileMutationQueue` 用 `realpath` 作为队列键，符号链接指向同一文件时会进入同一个队列。讲义里的实现做的是同一件事。

**中止与队列的关系。** `edit.js` 里有一段注释值得记录：中止事件的处理不能直接抛出错误，否则会在文件系统操作仍在进行时释放写入队列。pi 的做法是在每个 `await` 之后检查 `signal.aborted`。

## 验收

1. 一次提问里同时出现三次读取，三次调用应当并发执行，总耗时接近其中最长的一次。
2. 让模型连续写入同一个文件两次，两次写入应当按顺序完成，文件内容是第二次的结果。
3. 执行一个输出超过 50KB 的命令，返回内容应当带有截断标记与临时文件路径，路径下的文件包含完整输出。

## 常见错误

第一个错误是把并发策略放在循环里按工具名称判断。策略应当由工具自己声明，新增工具时不需要改动循环。

第二个错误是并发结果按完成时间写回。结果与调用的对应关系错位之后，模型会基于错误的对应关系继续推理。

第三个错误是截断不返回标记。模型看到一段完整的内容时会据此得出错误结论。

第四个错误是参数校验失败仍然执行。校验失败应当直接生成错误结果，不产生任何副作用。

第五个错误是把完整输出留在结果里。上下文的占用按结果长度计算，一次长输出就会挤掉之前的指令。