# 3 · 循环检测、API 容错与 Token 预算

> 章节：第一章 起步 + Agent Loop

## 本讲目标

让循环在三种异常情况下都能正常收场：模型反复调用同一个工具、模型 API 出现波动、额度接近用完。这一讲结束时，程序不会无限运行，也不会在 API 波动时直接失败。

## 要写的代码

```
src/agent/
├── loop.ts       第 2 讲，本讲接入三道防线
├── fuses.ts      新增：循环检测与预算
└── retry.ts      新增：可重试性判定与退避
```

`src/agent/fuses.ts`：

```typescript
import type { ToolCall } from "../types.ts";

export type FuseState = {
  step: number;
  fingerprints: string[];
  inputTokens: number;
  outputTokens: number;
};

export type Limits = {
  maxSteps: number;
  maxTokens: number;
  maxRepeats: number;
};

export type FuseAction =
  | { type: "continue" }
  | { type: "nudge"; message: string }
  | { type: "finalize"; reason: string };

export function fingerprint(call: ToolCall, cwd: string): string {
  return `${call.name}:${stableStringify(normalizeArgs(call.args, cwd))}`;
}

function normalizeArgs(args: unknown, cwd: string): unknown {
  if (typeof args !== "object" || args === null) return args;
  const entries = Object.entries(args as Record<string, unknown>)
    .map(([key, value]) => {
      if (key === "path" && typeof value === "string") {
        const absolute = value.startsWith("/") ? value : `${cwd}/${value}`;
        return [key, absolute.replace(/\/+/g, "/")];
      }
      if (typeof value === "string") return [key, value.trim()];
      return [key, value];
    })
    .sort(([a], [b]) => (a as string).localeCompare(b as string));
  return Object.fromEntries(entries);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function checkFuses(state: FuseState, limits: Limits): FuseAction {
  if (state.step >= limits.maxSteps) {
    return { type: "finalize", reason: `达到轮数上限 ${limits.maxSteps}` };
  }
  if (state.inputTokens + state.outputTokens >= limits.maxTokens) {
    return {
      type: "finalize",
      reason: `达到 Token 预算 ${limits.maxTokens}`,
    };
  }

  const tail = state.fingerprints.slice(-2);
  if (tail.length === 2 && tail[0] === tail[1]) {
    return {
      type: "nudge",
      message: "上一次同样的调用没有解决问题，请改变做法或给出当前结论。",
    };
  }
  const longerTail = state.fingerprints.slice(-limits.maxRepeats);
  if (
    longerTail.length === limits.maxRepeats &&
    longerTail.every((item) => item === longerTail[0])
  ) {
    return { type: "finalize", reason: "同一个调用连续重复多次" };
  }

  return { type: "continue" };
}
```

指纹计算里有两处必须做规范化：路径要转成绝对路径并去掉重复分隔符，字符串参数要去掉首尾空白。否则同一个调用写成不同形式时指纹不同，检测失效。

`src/agent/retry.ts`：

```typescript
const RETRYABLE = [
  /overloaded/i,
  /rate.?limit/i,
  /too many requests/i,
  /\b(429|500|502|503|504)\b/,
  /service.?unavailable/i,
  /server.?error/i,
  /network.?error/i,
  /connection.?(refused|lost|error)/i,
  /socket hang up/i,
  /fetch failed/i,
  /timed? out/i,
  /terminated/i,
  /stream ended before/i,
  /ended without/i,
];

const NOT_RETRYABLE = [
  /insufficient_quota/i,
  /quota exceeded/i,
  /out of budget/i,
  /billing/i,
  /invalid.?api.?key/i,
  /unauthorized/i,
];

export function isRetryable(message: string): boolean {
  if (NOT_RETRYABLE.some((pattern) => pattern.test(message))) return false;
  return RETRYABLE.some((pattern) => pattern.test(message));
}

export function retryDelayMs(attempt: number, baseMs = 2000, maxMs = 60_000): number {
  const delay = baseMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(Number.isSafeInteger(delay) ? delay : maxMs, maxMs);
}

export async function withRetry<T>(
  run: () => Promise<T>,
  classify: (value: T) => string | undefined,
  options: { maxRetries: number; signal?: AbortSignal },
): Promise<T> {
  let attempt = 0;
  for (;;) {
    const value = await run();
    const errorText = classify(value);
    if (errorText === undefined || attempt >= options.maxRetries) return value;
    if (!isRetryable(errorText)) return value;

    attempt++;
    const delay = retryDelayMs(attempt);
    console.error(`[重试 ${attempt}/${options.maxRetries}] ${errorText}，${delay} 毫秒后重试`);
    await sleep(delay, options.signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("已中止"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("已中止"));
      },
      { once: true },
    );
  });
}
```

`src/agent/loop.ts` 接入方式：

```typescript
const fuseState: FuseState = {
  step: 0,
  fingerprints: [],
  inputTokens: 0,
  outputTokens: 0,
};

for (;;) {
  fuseState.step++;

  const action = checkFuses(fuseState, limits);
  if (action.type === "finalize") {
    messages.push({ role: "user", text: `已达上限，请基于现有信息给出结论：${action.reason}` });
    const closing = await callModel(messages, [], signal);
    messages.push(closing);
    return { messages, stopReason: action.reason };
  }
  if (action.type === "nudge") {
    messages.push({ role: "user", text: action.message });
  }

  const response = await withRetry(
    () => callModel(messages, registry, signal),
    (value) => (value.stopReason === "error" ? value.errorMessage : undefined),
    { maxRetries: 3, signal },
  );

  fuseState.inputTokens += response.usage?.input ?? 0;
  fuseState.outputTokens += response.usage?.output ?? 0;
  // ...写入消息、执行工具、记录指纹
  for (const call of response.toolCalls) {
    fuseState.fingerprints.push(fingerprint(call, cwd));
  }
}
```

收尾分支里传入空的工具集合，这一处是刻意的：收尾过程不再执行工具，否则收尾本身会继续消耗预算。

## pi 的做法

**循环检测。** pi 的主循环里没有指纹检测。它依赖另外四种机制收束：上下文窗口本身构成上限（每一轮的工具结果都会留在请求里，增长到阈值时压缩介入，摘要里带着自己已经做过的事情）、工具结果的双重长度上限、使用者中止与 steering 消息、以及 `stopReason` 的分类处理。子智能体侧才有显式预算：`toolBudget` 有软上限与硬上限，达到硬上限之后按白名单屏蔽读取类工具迫使收尾；`usageBudget` 限制 Token 与金额；`timeoutMs` 限制单次运行时长。

**可重试性判定。** 讲义里的两张正则表来自 `pi-ai/dist/utils/retry.js`，pi 的实现规模更大，覆盖各家供应方的错误措辞：

```typescript
const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
  "overloaded", "currently experiencing high demand", "rate.?limit", "too many requests",
  "429", "500", "502", "503", "504", "520", "524", "service.?unavailable",
  "provider.?returned.?error", "network.?error", "connection.?refused",
  "socket hang up", "timed? out", "terminated", "websocket.?closed",
  "ended without", "stream ended before message_stop", "http2 request did not get a response",
  "you can retry your request", "ResourceExhausted",
]);
```

不可重试表优先判断，包含 `insufficient_quota`、`out of budget`、`quota exceeded`、`billing` 等。额度耗尽与限流在文本上接近，因此单独一张表。

**退避。** `retryDelayMs(policy, attempt)` 使用同样的指数公式，默认取值是 `maxRetries` 三次、`baseDelayMs` 2000 毫秒、单次等待上限 60000 毫秒，因此三次等待分别是 2 秒、4 秒、8 秒。重试过程提供 `onRetryScheduled`、`onRetryAttemptStart`、`onRetryFinished` 三个回调，界面据此显示重试进度。

**中止的处理。** 等待期间收到中止信号时，pi 返回的消息结构与供应方中止形态一致：

```typescript
if (error instanceof RetrySleepAbortError) {
  const { errorMessage: _errorMessage, ...rest } = response;
  return { ...rest, stopReason: "aborted" };
}
```

这样一来调用方不需要区分「取消发生在请求中」与「取消发生在等待中」。

**上下文溢出单独走一条路。** 溢出不属于可重试错误，pi 的处理顺序是：持久化最后的助手回应、发出 `turn_end` 与 `agent_end`、追加 `context_edit` 省略项、执行压缩、作为一次全新的运行重新开始。讲义里第 11 讲引入压缩时会接入这条路径。

## 验收

1. 让模型执行一个必然失败的任务，例如「反复读取 /tmp/不存在」，程序应当在连续两次相同调用之后插入提示，并在达到上限时给出结论，停止继续循环。
2. 在 `.env` 里把 API 地址改成不可达的地址，程序应当打印三次重试记录之后退出。
3. 把 `maxTokens` 设成 2000 跑一个多步任务，程序应当在预算耗尽时进入收尾分支并输出一段结论。

## 常见错误

第一个错误是指纹不做规范化。相对路径与绝对路径、参数顺序不同都会导致指纹不同，检测完全失去作用。

第二个错误是只按状态码判断可重试性。多数供应方的限流与配额错误都带 429 状态码，按状态码判断会把配额耗尽当作限流反复重试。

第三个错误是退避不加总时长上限。指数增长会算出很大的等待时间，一次任务可能卡在等待中几十分钟。

第四个错误是收尾分支继续挂载工具。收尾时再次发起工具调用会重新进入正常循环。

第五个错误是取消信号只传给请求不传给等待。中止之后程序仍然要等满退避时间才退出。