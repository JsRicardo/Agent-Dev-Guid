# 12 · 三层即时防线

> 章节：第三章 Context Engineering

## 本讲目标

在压缩之前先把长度问题解决掉。这一讲结束时，每一轮请求之前程序会按「先淘汰、再截断、最后压缩」的顺序处理上下文，绝大多数情况下不需要动用摘要。

## 要写的代码

```
src/context/
├── defense.ts     三层防线
└── budget.ts      各部分配额
```

### 配额

`src/context/budget.ts`：

```typescript
export type Budget = {
  tools: number;
  prompt: number;
  conversation: number;
  toolResults: number;
  retrieval: number;
  reserve: number;
};

export function budgetFor(contextWindow: number): Budget {
  return {
    tools: 0,
    prompt: 0,
    conversation: Math.floor(contextWindow * 0.45),
    toolResults: Math.floor(contextWindow * 0.2),
    retrieval: Math.floor(contextWindow * 0.08),
    reserve: 16_384,
  };
}
```

固定比例分配在长任务中会失效，因此这里只是一个起点：工具与提示词的实际占用从请求里量出来之后填进去，剩余额度再分给可变部分。

### 第一层：按年龄淘汰

```typescript
import type { Message } from "../types.ts";
import { estimateTokens } from "./tokens.ts";

/** 工具结果的存活时间，超出之后即使内容为错误也可以替换。 */
const TOOL_RESULT_TTL_MS = 10 * 60 * 1000;
const RETRIEVAL_TTL_MS = 30 * 60 * 1000;

export function evictExpired(messages: Message[], now = Date.now()): { messages: Message[]; released: number } {
  let released = 0;
  const next = messages.map((message) => {
    if (message.role === "toolResult" && !message.text.startsWith("[已省略]")) {
      const age = now - (message.timestamp ?? now);
      if (age > TOOL_RESULT_TTL_MS) {
        released += estimateTokens(message);
        return { ...message, text: `[已过期] ${message.name} 的结果（${message.text.length} 字符）` };
      }
    }
    if (message.role === "toolResult" && message.name === "get_search_content" && !message.text.startsWith("[已过期]")) {
      const age = now - (message.timestamp ?? now);
      if (age > RETRIEVAL_TTL_MS) {
        released += estimateTokens(message);
        return { ...message, text: `[已过期] 检索正文，需要时可重新取回` };
      }
    }
    return message;
  });
  return { messages: next, released };
}
```

检索正文的存活时间比普通工具结果长，淘汰之后仍然可以通过标识重新取回，因此这一层的损失是可以恢复的。

### 第二层：按配额截断

```typescript
export function trimToBudget(messages: Message[], limits: { conversation: number; toolResults: number }) {
  let conversationTokens = 0;
  let toolResultTokens = 0;
  const kept: Message[] = [];
  let released = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const size = estimateTokens(message);

    if (message.role === "toolResult") {
      if (toolResultTokens + size > limits.toolResults) {
        released += size;
        kept.unshift({ ...message, text: `[已省略] ${message.name} 的结果（${message.text.length} 字符）` });
        continue;
      }
      toolResultTokens += size;
      kept.unshift(message);
      continue;
    }

    if (message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0) {
      conversationTokens += size;
      kept.unshift(message);
      continue;
    }

    if (conversationTokens + size > limits.conversation) {
      released += size;
      if (message.role === "user") {
        kept.unshift({ ...message, text: `${message.text.slice(0, 500)}\n[... 内容已截断]` });
      }
      continue;
    }
    conversationTokens += size;
    kept.unshift(message);
  }

  return { messages: kept, released };
}
```

自后向前遍历，保证最近的内容优先保留。助手消息只要带工具调用就必须保留，丢掉它会让紧随其后的工具结果失去对应关系。

### 第三层：超出配额时压缩

```typescript
export function defend(input: {
  messages: Message[];
  contextWindow: number;
  now?: number;
}) {
  const budget = budgetFor(input.contextWindow);
  const steps: string[] = [];

  const evicted = evictExpired(input.messages, input.now);
  if (evicted.released > 0) steps.push(`淘汰 ${evicted.released} Token`);

  const trimmed = trimToBudget(evicted.messages, {
    conversation: budget.conversation,
    toolResults: budget.toolResults,
  });
  if (trimmed.released > 0) steps.push(`截断 ${trimmed.released} Token`);

  return {
    messages: trimmed.messages,
    steps,
    needsCompaction: estimateContextTokens(trimmed.messages).tokens > input.contextWindow - budget.reserve,
  };
}
```

执行的顺序固定：先淘汰过期内容（无损）、再按配额截断（有损但可恢复）、最后才交给摘要压缩（有损且不可恢复）。顺序颠倒会先付出不可恢复的代价。

### 与循环的接入位置

```typescript
// 每一轮请求之前
const defended = defend({ messages, contextWindow: model.contextWindow });
if (defended.steps.length > 0) {
  console.error(`[上下文] ${defended.steps.join("，")}`);
}
if (defended.needsCompaction) {
  const result = await compactOnce({ messages: defended.messages, previousSummary, callModel });
  if (result) {
    await session.appendCompaction(result.summary, result.firstKeptEntryId, result.tokensBefore);
  }
}
const response = await callModel(defended.messages, getActiveTools(), signal);
```

## pi 的做法

**混合估算。** `estimateProjectedContextTokens` 在已有真实用量时直接使用用量值，之后新增的消息按字符数除以四估算，并在压缩或上下文编辑条目之后放弃旧的用量值重新估算：

```typescript
export function estimateProjectedContextTokens(projection, branchEntries) {
  const estimate = estimateContextTokens(projection.messages);
  if (estimate.lastUsageIndex !== null) {
    // 用量所在条目是否晚于最近一次压缩或上下文编辑
    ...
    if (usageEntryIndex > latestInvalidatingEntryIndex) return estimate;
  }
  // 否则重新逐条估算
}
```

这一处细节很重要：压缩之后请求内容已经变化，压缩之前记录的用量不再代表当前长度。

**工具结果的双重上限。** `dist/core/tools/truncate.js` 在工具层解决长度问题，2000 行与 50KB 谁先命中按谁处理，`grep` 的每一行再截到 500 字符。上限写在工具层的好处是任何路径都绕不过去。

**缓存的存活时间管理。** `pi-memory` 里对外部检索工具的状态缓存做了区分：正向结果缓存 5 分钟，负向结果只缓存 5 秒，理由是刚安装检索工具的使用者不应等待整个存活周期才能重试：

```typescript
const QMD_STATUS_CACHE_TTL_MS = 5 * 60 * 1000;
const QMD_STATUS_NEGATIVE_CACHE_TTL_MS = 5 * 1000;
```

正向与负向采用不同的存活时间，这是一个可以直接借用的模式：确定性结论可以缓存较久，失败与缺失状态应当快速失效。

**上下文编辑条目。** pi 提供一种比压缩更细的手段：把选定的一批消息从模型上下文中省略，同时保留在会话文件里。这条机制用在溢出恢复路径上，也用在需要临时排除某些内容而又不愿意触发摘要的场景。

## 验收

1. 跑一个工具结果很多的长任务，先出现的是淘汰记录，其次是截断记录，摘要只在两者都不够时出现。
2. 打印每一层释放的 Token 数量，三者之和加上剩余长度应当接近估算出的总长度。
3. 把一个检索正文的存活时间改成一分钟，一分钟后该条结果应当变成过期标记，并且可以用标识重新取回。
4. 手动删除所有淘汰与截断逻辑，跑同一个任务，请求应当在更早的轮次触发摘要。

## 常见错误

第一个错误是直接上压缩。压缩有信息损失，先做无损淘汰可以省下大量摘要调用。

第二个错误是按固定比例分配配额之后不再调整。工具与提示词的实际占用需要量出来。

第三个错误是自前向后遍历决定保留内容。这样保留的是最早的内容，最近的工具结果反而被丢掉。

第四个错误是把带工具调用的助手消息截断。它之后的工具结果会失去对应关系。

第五个错误是淘汰与截断不记录。使用者看不到长度问题出现在哪一层，调整没有依据。