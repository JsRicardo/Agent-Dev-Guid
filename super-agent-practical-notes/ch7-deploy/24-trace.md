# 24 · 把每一步留下来：本地 Trace 与执行复盘

> 章节：加餐

## 本讲目标

让每一次运行都可以复盘。这一讲结束时，程序把请求内容、工具调用、用量、权限判定按行写入文件，支持按时间线查看、按条件筛选、按标识回放，并且对敏感内容做过滤。

## 要写的代码

```
src/trace/
├── events.ts      事件模型
├── writer.ts      按行写入
├── reader.ts      查询与时间线
├── replay.ts      回放
└── redact.ts      敏感内容过滤
```

### 事件模型

```typescript
export type TraceEvent =
  | { type: "run_start"; runId: string; at: string; cwd: string; mode: string; prompt: string }
  | { type: "request"; at: string; model: string; messageCount: number; messages: unknown[]; tools: string[]; inputTokens: number; cachedTokens: number }
  | { type: "response"; at: string; durationMs: number; firstTokenMs: number; stopReason: string; outputTokens: number; text: string }
  | { type: "tool_call"; at: string; callId: string; name: string; args: unknown }
  | { type: "tool_result"; at: string; callId: string; durationMs: number; isError: boolean; chars: number; head: string }
  | { type: "permission"; at: string; callId: string; toolName: string; decision: string; reason: string; actor?: string }
  | { type: "compaction"; at: string; tokensBefore: number; tokensAfter: number; summaryChars: number; firstKeptEntryId: string }
  | { type: "error"; at: string; stage: string; retryable: boolean; message: string }
  | { type: "retry"; at: string; attempt: number; maxAttempts: number; delayMs: number; reason: string }
  | { type: "usage"; at: string; kind: string; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number }
  | { type: "run_end"; at: string; status: string; totalTokens: number; totalCostUsd: number; durationMs: number };
```

事件覆盖六类信息：请求内容、模型回应、工具调用与结果、权限判定、压缩与重试、用量与结论。缺任何一类都会让复盘停在某个位置无法继续。

### 按行写入

```typescript
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export class TraceWriter {
  private buffer: TraceEvent[] = [];
  private flushing = false;

  constructor(private readonly filePath: string) {}

  static forRun(input: { dir: string; runId: string; at: Date }): TraceWriter {
    const day = input.at.toISOString().slice(0, 10);
    return new TraceWriter(join(input.dir, day, `${input.runId}.jsonl`));
  }

  async write(event: TraceEvent): Promise<void> {
    this.buffer.push(event);
    if (this.flushing) return;
    this.flushing = true;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      while (this.buffer.length > 0) {
        const batch = this.buffer.splice(0, this.buffer.length);
        await appendFile(this.filePath, batch.map((item) => `${JSON.stringify(item)}\n`).join(""), "utf-8");
      }
    } finally {
      this.flushing = false;
    }
  }

  async flush(): Promise<void> {
    while (this.flushing || this.buffer.length > 0) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
  }
}
```

三处细节：一次运行一个文件，文件名带运行标识；写入批量合并，减少系统调用；退出之前调用 `flush`，避免最后一批事件丢失。

### 采集位置

```typescript
export function createTracer(writer: TraceWriter, redact: (value: unknown) => unknown) {
  const started = new Map<string, number>();

  return {
    async onRequest(input: { model: string; messages: unknown[]; tools: string[]; inputTokens: number }) {
      await writer.write({
        type: "request",
        at: new Date().toISOString(),
        model: input.model,
        messageCount: input.messages.length,
        messages: redact(input.messages) as unknown[],
        tools: input.tools,
        inputTokens: input.inputTokens,
        cachedTokens: 0,
      });
      started.set("request", Date.now());
    },

    async onToolStart(input: { callId: string; name: string; args: unknown }) {
      started.set(input.callId, Date.now());
      await writer.write({
        type: "tool_call",
        at: new Date().toISOString(),
        callId: input.callId,
        name: input.name,
        args: redact(input.args),
      });
    },

    async onToolEnd(input: { callId: string; isError: boolean; text: string }) {
      await writer.write({
        type: "tool_result",
        at: new Date().toISOString(),
        callId: input.callId,
        durationMs: Date.now() - (started.get(input.callId) ?? Date.now()),
        isError: input.isError,
        chars: input.text.length,
        head: input.text.slice(0, 300),
      });
    },

    async onPermission(input: { callId: string; toolName: string; decision: string; reason: string; actor?: string }) {
      await writer.write({ type: "permission", at: new Date().toISOString(), ...input });
    },

    async onUsage(input: { kind: string; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number }) {
      await writer.write({ type: "usage", at: new Date().toISOString(), ...input });
    },
  };
}
```

请求事件里保存完整消息内容。出问题时唯一有效的排查方式是查看模型实际收到的内容，只记录条数或者长度无法定位问题。工具结果只保留前 300 字符，全文记录会让文件迅速膨胀。

### 敏感内容过滤

```typescript
const PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "openai_key", pattern: /sk-[A-Za-z0-9]{20,}/g },
  { name: "bearer", pattern: /Bearer\s+[A-Za-z0-9._-]{20,}/g },
  { name: "feishu_token", pattern: /(t|u)-[A-Za-z0-9]{20,}/g },
  { name: "private_key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "env_secret", pattern: /(api[_-]?key|secret|token|password)["']?\s*[:=]\s*["'][^"']{8,}["']/gi },
];

export function redact(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redact(item)]));
  }
  return value;
}

function redactText(text: string): string {
  let output = text;
  for (const { name, pattern } of PATTERNS) {
    output = output.replace(pattern, `[已过滤:${name}]`);
  }
  return output;
}
```

过滤在写入之前执行。记录里出现密钥的后果比漏记一段内容严重得多。

### 查询与时间线

`src/trace/reader.ts`：

```typescript
export function renderTimeline(events: TraceEvent[], options: { from?: string; to?: string } = {}): string {
  const lines: string[] = [];
  for (const event of events) {
    if (options.from && event.at < options.from) continue;
    if (options.to && event.at > options.to) continue;
    const time = event.at.slice(11, 23);

    switch (event.type) {
      case "run_start":
        lines.push(`${time} 开始运行，目录 ${event.cwd}，模式 ${event.mode}`);
        break;
      case "request":
        lines.push(`${time} 请求 ${event.model}，消息 ${event.messageCount} 条，工具 ${event.tools.length} 个，输入 ${event.inputTokens} Token`);
        break;
      case "response":
        lines.push(`${time} 回应 ${event.stopReason}，首字 ${event.firstTokenMs} 毫秒，总耗时 ${event.durationMs} 毫秒，输出 ${event.outputTokens} Token`);
        break;
      case "tool_call":
        lines.push(`${time} 调用 ${event.name}，参数 ${JSON.stringify(event.args).slice(0, 120)}`);
        break;
      case "tool_result":
        lines.push(`${time} 结果 ${event.isError ? "失败" : "成功"}，耗时 ${event.durationMs} 毫秒，${event.chars} 字符`);
        break;
      case "permission":
        lines.push(`${time} 权限判定 ${event.toolName}：${event.decision}（${event.reason}）`);
        break;
      case "retry":
        lines.push(`${time} 第 ${event.attempt}/${event.maxAttempts} 次重试，等待 ${event.delayMs} 毫秒，原因 ${event.reason}`);
        break;
      case "compaction":
        lines.push(`${time} 压缩：${event.tokensBefore} → ${event.tokensAfter} Token，摘要 ${event.summaryChars} 字符`);
        break;
      case "usage":
        lines.push(`${time} 用量 ${event.kind}：输入 ${event.input}，缓存读 ${event.cacheRead}，缓存写 ${event.cacheWrite}，输出 ${event.output}，${event.costUsd.toFixed(4)} 美元`);
        break;
      case "error":
        lines.push(`${time} 错误（${event.stage}）：${event.message}${event.retryable ? "，可重试" : "，不可重试"}`);
        break;
      case "run_end":
        lines.push(`${time} 运行结束 ${event.status}，合计 ${event.totalTokens} Token，${event.totalCostUsd.toFixed(4)} 美元，耗时 ${event.durationMs} 毫秒`);
        break;
    }
  }
  return lines.join("\n");
}

export function summarize(events: TraceEvent[]) {
  const requests = events.filter((event) => event.type === "request").length;
  const toolCalls = events.filter((event) => event.type === "tool_call");
  const perTool = new Map<string, number>();
  for (const event of toolCalls) perTool.set(event.name, (perTool.get(event.name) ?? 0) + 1);

  const byDuration = toolCalls
    .map((event) => ({ name: event.name, at: event.at }))
    .map((item) => ({
      ...item,
      durationMs: findByResult(events, item.at)?.durationMs ?? 0,
    }))
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 5);

  const usage = events.filter((event) => event.type === "usage");
  const totalCost = usage.reduce((sum, event) => sum + (event.type === "usage" ? event.costUsd : 0), 0);
  const retries = events.filter((event) => event.type === "retry").length;
  const denied = events.filter((event) => event.type === "permission" && event.decision === "deny").length;

  return [
    `请求次数：${requests}`,
    `工具调用：${toolCalls.length}（${[...perTool].map(([name, count]) => `${name} ${count}`).join("，")}）`,
    `最慢的调用：${byDuration.map((item) => `${item.name} ${item.durationMs} 毫秒`).join("，")}`,
    `重试次数：${retries}`,
    `被拒绝的操作：${denied}`,
    `合计金额：${totalCost.toFixed(4)} 美元`,
  ].join("\n");
}

function findByResult(events: TraceEvent[], callAt: string) {
  const index = events.findIndex((event) => event.at === callAt);
  const next = events.slice(index + 1).find((event) => event.type === "tool_result");
  return next?.type === "tool_result" ? next : undefined;
}
```

`summarize` 输出的六项是复盘时最先看的内容：请求次数反映轮数是否失控，工具调用分布反映模型选了哪些工具，最慢的调用反映时间花在哪里，重试与被拒绝的操作反映环境与权限问题，金额反映成本。

### 回放

```typescript
export async function replayRequest(input: {
  events: TraceEvent[];
  requestIndex: number;
  overrides?: { model?: string; dropMessagesFrom?: number };
  callModel: (messages: unknown[], model: string) => Promise<{ text: string }>;
}) {
  const requests = input.events.filter((event) => event.type === "request");
  const target = requests[input.requestIndex];
  if (!target || target.type !== "request") {
    throw new Error(`没有第 ${input.requestIndex} 次请求`);
  }

  const messages = input.overrides?.dropMessagesFrom !== undefined
    ? (target.messages as unknown[]).slice(0, input.overrides.dropMessagesFrom)
    : target.messages;

  const result = await input.callModel(messages, input.overrides?.model ?? target.model);
  return { before: target, after: result };
}
```

回放的价值在于验证判断：怀疑是某条工具结果把上下文带偏时，把那一批消息去掉重新执行一次，观察结果是否变化。有了完整请求内容，这类验证不需要重新跑整个任务。

### 运行索引

```typescript
export async function appendRunIndex(input: {
  dir: string;
  runId: string;
  at: string;
  status: string;
  totalTokens: number;
  totalCostUsd: number;
  prompt: string;
}): Promise<void> {
  await appendFile(
    join(input.dir, "runs.jsonl"),
    `${JSON.stringify({ ...input, prompt: input.prompt.slice(0, 200) })}\n`,
    "utf-8",
  );
}
```

单次运行的记录放在按日期分开的目录里，另有一份汇总文件记录每次运行的结论与成本。查找历史时先读汇总文件，再进入具体运行查看细节。

### 保留与清理

```typescript
export async function cleanupTraces(dir: string, keepDays: number): Promise<number> {
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const timestamp = Date.parse(`${entry.name}T00:00:00.000Z`);
    if (Number.isNaN(timestamp) || timestamp >= cutoff) continue;
    await rm(join(dir, entry.name), { recursive: true, force: true });
    removed++;
  }
  return removed;
}
```

保留周期按天数设置，清理按目录进行。记录文件不做轮转会导致磁盘占用持续增长。

## pi 的做法

**会话文件就是 Trace。** pi 没有单独的记录系统，会话文件承担了这一职责：条目类型包括消息、模型切换、思考等级切换、用量、压缩、分支摘要、上下文编辑，每一行是完整 JSON。运行过程中出现的所有内容都在里面，导出、计费与历史检索读的是同一份数据。

**完整的请求内容从 Hook 取。** `harness/hooks.js` 的 `before_payload` 扩展点拿到的是即将发出的完整请求体，记录这一处就得到了请求现场，也是回放的基础。讲义里的 `onRequest` 对应这个位置。

**用量条目。** 会话记录里有一种独立的 `usage` 条目，`kind` 字段标记用途，例如缓存续期记为 `cache_warm`，它参与总量与费用统计但不进入对话树。这一处设计让助手消息之外的操作产生的费用也能被统计。

**缓存失效提示。** `cache-stats.js` 把每一轮的误失量与金额算出来之后，可以按条显示在对应的助手消息上。把成本问题变成可见信息，使用者才会去检查是什么让前缀发生了变化。

**两个查看视图。** 后台运行的记录分成两类视图：当前状态与历史过程。查看用 `status` 与 `debug.run`，分别面向「现在什么状态」与「这一路怎么走到这里」。讲义里的 `renderTimeline` 与 `summarize` 对应后者。

**导出。** pi 提供把会话导出成可阅读页面的能力，`dist/core/export-html` 下是模板与资源。导出的意义在于把一次运行交给他人查看，避免口头复述过程。

**记录里的隐私。** 会话文件可能包含提示词、工具参数、命令输出、文件内容与对话中出现的凭据。文档在分享与导出之前明确要求先查看记录内容。讲义里的 `redact` 放在写入之前，属于更早的一道防线。

## 验收

1. 完成一次包含工具调用、一次重试与一次压缩的运行，时间线里六类事件都出现，顺序与实际过程一致。
2. 时间线里每一次工具调用后面都可以找到对应的结果记录，耗时不为零。
3. 在提示词里放一个形如 `sk-` 开头的字符串，记录文件里该位置应当显示为过滤标记。
4. 用回放功能去掉最后一条工具结果重新执行，观察结果变化，两次输出可以直接对比。
5. 把保留周期改成一天并运行清理，超过一天的目录被移除，汇总文件保留。

## 常见错误

第一个错误是只记录结论。复盘时看不到请求内容与工具结果，判断只能靠推测。

第二个错误是工具结果全文记录。文件迅速膨胀，实际很少查看。

第三个错误是不过滤敏感内容。记录里出现密钥，分享与导出时需要额外处理。

第四个错误是不记录耗时。无法判断时间花在模型上还是工具上。

第五个错误是不做清理。磁盘占用持续增长，最终影响运行。

第六个错误是没有汇总文件。查找历史需要遍历全部运行记录，使用成本高到不会有人去查。