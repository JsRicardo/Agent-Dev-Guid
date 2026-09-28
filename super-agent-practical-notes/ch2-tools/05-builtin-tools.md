# 5 · edit、grep、glob 与 bash

> 章节：第二章 Tool System

## 本讲目标

把四个日常使用频率最高的工具补齐。这一讲结束时，Agent 能读改文件、按内容搜索、按文件名搜索、执行命令，并且每个工具的结果都带有截断标记。

## 要写的代码

```
src/tools/builtin/
├── edit.ts
├── grep.ts
├── glob.ts
├── bash.ts
└── index.ts      统一导出并注册
```

### edit

替换方式采用精确文本匹配，一次调用可以带多个互不重叠的替换项。

```typescript
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { registerTool, type ToolContext, type ToolResult } from "../registry.ts";
import { withFileMutationQueue } from "../file-queue.ts";

type ReplaceEdit = { oldText: string; newText: string };
type EditArgs = { path: string; edits: ReplaceEdit[] };

function validate(args: unknown): EditArgs {
  const input = args as Partial<EditArgs>;
  if (typeof input?.path !== "string" || !Array.isArray(input.edits) || input.edits.length === 0) {
    throw new Error("path 必须是字符串，edits 必须包含至少一个替换项");
  }
  for (const edit of input.edits) {
    if (typeof edit?.oldText !== "string" || typeof edit?.newText !== "string") {
      throw new Error("每个替换项都需要 oldText 与 newText 两个字符串");
    }
  }
  return { path: input.path, edits: input.edits };
}

function applyEdits(content: string, edits: ReplaceEdit[]): string {
  const matches = edits.map((edit) => {
    const first = content.indexOf(edit.oldText);
    if (first === -1) {
      throw new Error(`找不到要替换的内容：${edit.oldText.slice(0, 60)}`);
    }
    if (content.indexOf(edit.oldText, first + 1) !== -1) {
      throw new Error(`要替换的内容在文件中出现多次，请扩大上下文：${edit.oldText.slice(0, 60)}`);
    }
    return { start: first, end: first + edit.oldText.length, edit };
  });

  const sorted = [...matches].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) {
      throw new Error("两个替换项的范围重叠，请合并成一个替换项");
    }
  }

  let output = "";
  let cursor = 0;
  for (const match of sorted) {
    output += content.slice(cursor, match.start) + match.edit.newText;
    cursor = match.end;
  }
  return output + content.slice(cursor);
}

export function registerEditTool(): void {
  registerTool({
    name: "edit",
    description:
      "用精确文本替换修改单个文件。每个 edits[].oldText 必须在原文件中只出现一次，并且互不重叠。需要连接相距较远的改动时，用一次调用带多个替换项，不要把大段未改动内容放进 oldText。",
    snippet: "用精确文本替换修改文件，一次调用可以包含多个互不重叠的替换项",
    guidelines: [
      "改动同一个文件的多个位置时，用一次 edit 调用带上多个 edits 项",
      "edits[].oldText 都相对原文件匹配，不相对前一个替换项的结果匹配",
    ],
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径" },
        edits: {
          type: "array",
          description: "一个或多个替换项",
          items: {
            type: "object",
            properties: {
              oldText: { type: "string", description: "要替换的原文，必须在文件中唯一" },
              newText: { type: "string", description: "替换后的内容" },
            },
            required: ["oldText", "newText"],
          },
        },
      },
      required: ["path", "edits"],
    },
    validate,
    async execute(args: EditArgs, ctx: ToolContext): Promise<ToolResult> {
      const absolute = resolve(ctx.cwd, args.path);
      return withFileMutationQueue(absolute, async () => {
        const raw = await readFile(absolute, "utf-8");
        const content = stripBom(raw);
        const normalized = content.replace(/\r\n/g, "\n");
        const updated = applyEdits(normalized, args.edits);
        await writeFile(absolute, updated, "utf-8");
        return {
          content: `已修改 ${args.path}，共 ${args.edits.length} 处`,
          details: { path: args.path, editCount: args.edits.length },
        };
      });
    },
  });
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
```

三处细节值得单独说明：读取时按换行统一成 `\n` 再匹配，写回时保持原样；去掉开头的 BOM，因为模型不会在 `oldText` 里带上这个不可见字符；整个读取与写入过程包在文件队列里。

### grep

```typescript
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { registerTool, type ToolContext, type ToolResult } from "../registry.ts";
import { truncateHead, truncationNotice } from "../truncate.ts";

const MAX_LINE_CHARS = 500;
const DEFAULT_LIMIT = 100;

export function registerGrepTool(): void {
  registerTool({
    name: "grep",
    description:
      "按内容搜索文件，返回匹配行与所在文件、行号。遵循 .gitignore。结果上限为 100 条匹配或 50KB，谁先命中按谁处理；每一行截到 500 字符。",
    snippet: "按内容搜索文件（遵循 .gitignore）",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "搜索模式，可以是正则表达式或普通文本" },
        path: { type: "string", description: "搜索目录或文件，默认为当前目录" },
        glob: { type: "string", description: "按通配符过滤文件，例如 '*.ts' 或 '**/*.spec.ts'" },
        ignoreCase: { type: "boolean", description: "忽略大小写，默认关闭" },
        literal: { type: "boolean", description: "把模式当作普通文本处理，关闭正则解释" },
        context: { type: "number", description: "每条匹配前后显示的行数，默认 0" },
        limit: { type: "number", description: "最多返回多少条匹配，默认 100" },
      },
      required: ["pattern"],
    },
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      const lines = await runRipgrep(args, ctx.signal);
      const truncation = truncateHead(lines.join("\n"));
      return {
        content: truncation.content + truncationNotice(truncation),
        details: { matches: lines.length, truncated: truncation.truncated },
      };
    },
  });
}

function runRipgrep(
  args: { pattern: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number },
  signal?: AbortSignal,
): Promise<string[]> {
  const argv = ["--line-number", "--no-heading", "--color", "never"];
  if (args.ignoreCase) argv.push("--ignore-case");
  if (args.literal) argv.push("--fixed-strings");
  if (args.glob) argv.push("--glob", args.glob);
  if (args.context) argv.push("--context", String(args.context));
  argv.push("--max-count", String(args.limit ?? DEFAULT_LIMIT));
  argv.push(args.pattern, args.path ?? ".");

  return new Promise((resolvePromise, reject) => {
    const child = spawn("rg", argv, { stdio: ["ignore", "pipe", "pipe"] });
    const reader = createInterface({ input: child.stdout });
    const collected: string[] = [];
    reader.on("line", (line) => {
      collected.push(line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}... [已截断]` : line);
    });
    signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || code === 1) resolvePromise(collected);
      else reject(new Error(`rg 退出码 ${code}`));
    });
  });
}
```

把搜索交给 `rg`，原因是忽略规则、二进制文件识别、编码处理这些细节自己实现容易出现偏差。退出码 1 表示没有匹配，属于正常情况。

### glob

```typescript
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { relative, resolve, sep } from "node:path";
import { registerTool, type ToolContext, type ToolResult } from "../registry.ts";

export function registerGlobTool(): void {
  registerTool({
    name: "glob",
    description: "按通配符查找文件，返回相对搜索根目录的路径。遵循 .gitignore。",
    snippet: "按通配符查找文件（遵循 .gitignore）",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "通配符模式，例如 '*.ts'、'**/*.json'、'src/**/*.spec.ts'" },
        path: { type: "string", description: "搜索目录，默认为当前目录" },
        limit: { type: "number", description: "最多返回多少条结果，默认 1000" },
      },
      required: ["pattern"],
    },
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      const root = resolve(ctx.cwd, args.path ?? ".");
      const absolute = await runFd(args.pattern, root, args.limit ?? 1000, ctx.signal);
      const lines = absolute.map((item) => relative(root, item).split(sep).join("/"));
      return {
        content: lines.join("\n") || "(没有匹配的文件)",
        details: { count: lines.length },
      };
    },
  });
}
```

结果相对搜索根目录，路径分隔符统一成斜杠。这两件事一起做，模型拿到的路径可以直接用于后续的读取与编辑调用。

### bash

```typescript
import { spawn } from "node:child_process";
import { registerTool, type ToolContext, type ToolResult } from "../registry.ts";
import { OutputAccumulator } from "../output.ts";
import { truncationNotice } from "../truncate.ts";

const MAX_TIMEOUT_SECONDS = 600;
const UPDATE_THROTTLE_MS = 100;

export function registerBashTool(): void {
  registerTool({
    name: "bash",
    description:
      "在当前目录执行一条 shell 命令，返回标准输出与标准错误。输出截断到末尾 2000 行或 50KB，谁先命中按谁处理；被截断时完整输出写入临时文件。可以传 timeout（秒）。",
    snippet: "执行 shell 命令",
    guidelines: ["列目录、搜索、找文件这类操作优先使用专用工具"],
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的命令" },
        timeout: { type: "number", description: "超时秒数，可选" },
      },
      required: ["command"],
    },
    async execute(args: { command: string; timeout?: number }, ctx: ToolContext): Promise<ToolResult> {
      if (args.timeout !== undefined && args.timeout > MAX_TIMEOUT_SECONDS) {
        throw new Error(`超时上限是 ${MAX_TIMEOUT_SECONDS} 秒`);
      }
      const output = new OutputAccumulator();
      let lastUpdate = 0;
      let dirty = false;

      const emit = () => {
        if (!ctx.onUpdate || !dirty) return;
        dirty = false;
        lastUpdate = Date.now();
        void output.snapshot(true).then((snapshot) => {
          ctx.onUpdate?.({ text: snapshot.content, fullOutputPath: snapshot.fullOutputPath });
        });
      };

      const child = spawn("bash", ["-lc", args.command], {
        cwd: ctx.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const onData = (chunk: Buffer) => {
        output.append(chunk.toString("utf-8"));
        dirty = true;
        const delay = UPDATE_THROTTLE_MS - (Date.now() - lastUpdate);
        if (delay <= 0) emit();
        else setTimeout(emit, delay);
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);

      const timer = args.timeout
        ? setTimeout(() => child.kill("SIGKILL"), args.timeout * 1000)
        : undefined;
      ctx.signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });

      const code: number = await new Promise((resolvePromise, reject) => {
        child.on("error", reject);
        child.on("close", (value) => resolvePromise(value ?? 0));
      });
      if (timer) clearTimeout(timer);
      output.finish();

      const snapshot = await output.snapshot(true);
      const text = (snapshot.content || "(没有输出)") + truncationNotice(snapshot.truncation, snapshot.fullOutputPath);
      return {
        content: text,
        isError: code !== 0,
        details: { exitCode: code, truncated: snapshot.truncation.truncated },
      };
    },
  });
}
```

命令类工具声明 `executionMode: "sequential"`。原因是并行执行两条命令时输出会交错，模型无法判断哪一段输出属于哪条命令。

## pi 的做法

**外部工具的获取方式。** `grep.js` 与 `find.js` 都先调用 `ensureTool`，由它负责检查外部程序是否存在、版本是否满足、必要时获取。讲义里直接 `spawn("rg", ...)`，遇到环境里没有 `rg` 的情况会失败。

**edit 的参数修复。** `dist/core/tools/edit.js` 里有一个 `prepareArguments`，处理模型不按格式传参的情况：

```typescript
// Some models (Opus 4.6, GLM-5.1) send edits as a JSON string instead of an array.
// Others send a single edit object instead of a one-element edits array.
if (typeof args.edits === "string") {
  try {
    const parsed = JSON.parse(args.edits);
    if (Array.isArray(parsed)) args.edits = parsed;
    else if (isSingleEditInput(parsed)) args.edits = [parsed];
  } catch { }
}
```

这一层修复在真实使用中价值很高：参数结构不合规时，与其返回错误让模型重试一次，不如就地转换成正确形状。

**edit 的文本处理。** `dist/core/tools/edit-diff.js` 提供 `normalizeToLF`、`restoreLineEndings`、`splitBom`、`applyEditsToNormalizedContent`、`generateDiffString`、`generateUnifiedPatch`。讲义里的实现对应前三个，差异字符串供界面展示，第 24 讲的 Trace 也会用到。

**中止与文件队列的关系。** `edit.js` 有一段注释记录了一个容易出错的位置：中止监听器里不能直接抛出错误，否则会在文件系统操作尚未结束时释放写入队列。pi 的做法是在每个 `await` 之后检查 `signal.aborted`，讲义里的实现同样需要注意这一点。

**bash 的超时与上限。** `bash.js` 的 `resolveTimeoutMs` 对超时做校验，超过上限直接报错。超时与中止走两条路径：超时用 `SIGKILL`，中止用更温和的信号。

**命令的前缀与运行环境。** pi 允许在命令前加一段前缀（`commandPrefix`），并可以注入会话相关的环境变量。这两个能力在多项目会话里很实用，讲义里留到第 23 讲讨论配置时再补。

## 验收

1. 让 Agent 修改一个文件的三个不相邻位置，应当只发起一次 edit 调用，且修改后文件里没有残留多余空行。
2. 对一个包含两百个文件的目录执行按内容搜索，结果应当集中在相关文件上，`.gitignore` 里排除的目录不出现。
3. 执行 `yes hello | head -n 200000`，结果应当被截断，并且临时文件里存在完整输出。
4. 同时对同一个文件发起两次 write，两次都能成功，最终内容是后一次的结果。

## 常见错误

第一个错误是 edit 用正则匹配替换文本。模型给出的文本里包含正则元字符时匹配会出错，精确文本匹配更稳定。

第二个错误是允许 `oldText` 在文件中出现多次。替换位置不确定时应当报错并要求扩大上下文。

第三个错误是把大段未改动内容放进 `oldText`。这样会让替换项变长，也让匹配更容易受到无关改动的影响。

第四个错误是搜索工具自己遍历目录。忽略规则与二进制文件的处理很容易出现偏差。

第五个错误是命令类工具并发执行。输出交错之后模型无法建立命令与结果的对应关系。