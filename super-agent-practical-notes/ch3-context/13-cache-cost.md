# 13 · Prompt Cache 与成本追踪

> 章节：第三章 Context Engineering

## 本讲目标

让重复的部分不再重复计费，并且让成本问题可见。这一讲结束时，程序能算出每一次请求的四项用量与金额、能检测出缓存失效造成的额外支出、能在会话空闲时决定是否续期。

## 要写的代码

```
src/context/
├── cache.ts      前缀组织与续期决策
└── cost.ts       用量与金额统计
```

### 请求内容的组织

```typescript
export function organizeRequest(input: {
  sections: Record<string, string>;
  tools: Array<{ name: string; description: string; parameters: unknown }>;
  conversation: Message[];
  volatile: { now: string; sessionId: string; task?: string };
}) {
  // 稳定前缀：系统提示词与工具定义，按名称排序保证序列化顺序固定
  const stableSections = Object.entries(input.sections)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, content]) => `<${name}>\n${content}\n</${name}>`)
    .join("\n\n");

  const stableTools = [...input.tools].sort((a, b) => a.name.localeCompare(b.name));

  // 动态内容全部放在最后，不进入前缀
  const tail = `当前时间：${input.volatile.now}\n会话标识：${input.volatile.sessionId}${
    input.volatile.task ? `\n本次任务：${input.volatile.task}` : ""
  }`;

  return {
    system: stableSections,
    tools: stableTools,
    messages: [...input.conversation, { role: "user" as const, text: tail }],
  };
}
```

三条规则决定缓存命中率：稳定内容放最前面；工具定义按名称排序之后序列化；时间、会话标识、本次任务这类每次都变的字段放在最后一轮消息里。把时间戳放进系统提示词会让整条请求重新计费。

### 用量与金额

`src/context/cost.ts`：

```typescript
export type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
};

export type Price = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

const PER_MILLION = 1_000_000;

export function costOf(usage: Usage, price: Price): number {
  return (
    (usage.input * price.input +
      usage.output * price.output +
      usage.cacheRead * price.cacheRead +
      usage.cacheWrite * price.cacheWrite) /
    PER_MILLION
  );
}

export class CostTracker {
  private total: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  private totalCost = 0;
  private turns = 0;

  constructor(private readonly price: Price) {}

  add(usage: Usage, label = "model"): { cost: number; cumulative: number } {
    this.total.input += usage.input;
    this.total.output += usage.output;
    this.total.cacheRead += usage.cacheRead;
    this.total.cacheWrite += usage.cacheWrite;
    const cost = costOf(usage, this.price);
    this.totalCost += cost;
    this.turns++;
    console.error(
      `[用量:${label}] 输入 ${usage.input} 缓存读 ${usage.cacheRead} 缓存写 ${usage.cacheWrite} 输出 ${usage.output}，`,
      `本轮 ${cost.toFixed(4)} 美元，累计 ${this.totalCost.toFixed(4)} 美元`,
    );
    return { cost, cumulative: this.totalCost };
  }

  summary() {
    const cacheable = this.total.cacheRead + this.total.cacheWrite;
    const hitRate = cacheable === 0 ? 0 : this.total.cacheRead / cacheable;
    return { ...this.total, cost: this.totalCost, turns: this.turns, cacheHitRate: hitRate };
  }
}
```

缓存读取与缓存写入必须分开统计。只看输入与输出两个数字无法判断缓存是否生效，也无法发现前缀变化。

### 缓存失效检测

```typescript
const NOISE_FLOOR_TOKENS = 1024;
const CACHE_TTL_MS = 5 * 60 * 1000;

export type MissInfo = {
  missedTokens: number;
  missedCost: number;
  idleMs: number;
  modelChanged: boolean;
};

export function detectMiss(
  previous: { promptTokens: number; modelKey: string; timestamp: number; reportedCache: boolean } | undefined,
  message: { usage: Usage; timestamp: number; modelKey: string },
  price: Price,
): MissInfo | undefined {
  const usage = message.usage;
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  if (!previous || promptTokens <= 0) return undefined;
  if (usage.cacheRead + usage.cacheWrite === 0 && !previous.reportedCache) return undefined;

  const missedTokens = Math.min(previous.promptTokens, promptTokens) - usage.cacheRead;
  if (missedTokens <= NOISE_FLOOR_TOKENS) return undefined;

  const paidTokens = usage.input + usage.cacheWrite;
  const paidPerToken = paidTokens > 0 ? (usage.input * price.input + usage.cacheWrite * price.cacheWrite) / paidTokens : 0;
  const readPerToken = price.cacheRead;

  return {
    missedTokens,
    missedCost: (missedTokens * Math.max(0, paidPerToken - readPerToken)) / PER_MILLION,
    idleMs: Math.max(0, message.timestamp - previous.timestamp),
    modelChanged: message.modelKey !== previous.modelKey,
  };
}
```

四处判定各有用途：首次请求与上下文发生实质变化之后的请求不计入，因为那时确实是一批新内容；1024 Token 以下不计入，因为缓存断点的粒度本身会造成小幅度波动；模型切换要计入，切换模型会重新计费整个提示词，属于真实支出；空闲时间超过五分钟的失效可以提示为可能原因。

### 续期决策

```typescript
const MIN_EXPECTED_SAVINGS_USD = 0.05;
const IDLE_CONTINUATION_PROBABILITY = 0.15;

export function shouldWarm(input: {
  ttlMs: number;
  promptTokens: number;
  price: Price;
  idle: boolean;
}): { warm: boolean; delayMs?: number; expectedSavings: number } {
  if (input.ttlMs <= 10_000) return { warm: false, expectedSavings: 0 };

  const delayMs = Math.max(1, Math.floor(Math.min(input.ttlMs * 0.9, input.ttlMs - 10_000)));
  const fullReadTokens = input.promptTokens;
  const savingsPerRequest =
    (fullReadTokens * (input.price.input - input.price.cacheRead)) / PER_MILLION;
  const probability = input.idle ? IDLE_CONTINUATION_PROBABILITY : 1;
  const expectedSavings = savingsPerRequest * probability;

  return { warm: expectedSavings >= MIN_EXPECTED_SAVINGS_USD, delayMs, expectedSavings };
}
```

续期请求本身有成本，因此要做一笔估算：预期节省低于阈值就不发。空闲状态下的预期还要乘一个「使用者会回来」的概率，因为空闲时段的预估更不可靠。存活时间的九成处发出续期请求，留出一点余量。

### 续期的实现约束

```typescript
async function warmCache(input: { messages: Message[]; tools: Tool[]; signal?: AbortSignal }) {
  try {
    await callModel(input.messages, input.tools, {
      maxOutputTokens: 1,
      signal: input.signal,
      retries: 0,
    });
  } catch {
    // 续期失败无需重试，下一次真实请求自然会写入新的缓存条目
  }
}
```

续期请求把输出上限设为一，只写缓存不生成内容；它自己不重试，因为失败无关紧要。

## pi 的做法

**四项用量贯穿全局。** pi 的用量结构固定为 `input`、`output`、`cacheRead`、`cacheWrite`，另有 `reasoning` 与分类成本。会话记录里还有一种独立的 `usage` 条目，`kind` 字段标记用途，缓存续期记为 `cache_warm`，它参与总量统计但不进入对话树。

**失效检测的细节。** `dist/core/cache-stats.js` 与讲义里的实现一致，另外处理了两处情况：压缩条目与分支摘要条目之后重置对比基准，因为那里上下文确实发生了变化；误失成本按本轮实际付的单价与缓存读取单价之差计算，因此统计出的是金额。这份统计可以按会话累计，也可以挂在对应的助手消息上显示。

**续期的参数。** `dist/core/cache-warmer.js`：

```typescript
const MAX_WARMING_AGE_MS = 60 * 60_000;
const MAX_IDLE_WARMING_AGE_MS = 30 * 60_000;
const CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS = 0.05;
const IDLE_CONTINUATION_PROBABILITY = 0.15;

export function getCacheWarmingDelayMs(ttlMs) {
  if (ttlMs <= 10_000) return undefined;
  return Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000)));
}
```

**可重放性判断。** 并非所有请求都能安全重放。`isReplayable` 检查推理参数与接口类型：以 Anthropic 的消息接口为例，开启思考且未使用自适应思考时，思考预算由输出上限推导，而缓存键与这个预算相关，重放会得到不同的预算，因此这种情况判定为不可重放。讲义里可以把这一类判断做成一个显式函数，遇到不适用的模型时直接关闭续期。

**段落补丁与缓存的关系。** `diffSystemPromptSections` 只把变化的段落写进系统消息，前缀保持一致。第 10 讲的段落机制与这里配合，技能清单变化时只有 `skills` 一段被重写。

## 验收

1. 连续提问两次同一个话题，第二次的日志里应当出现非零的缓存读取量，金额低于第一次。
2. 在系统提示词里临时加入一行当前时间，第二次请求的缓存读取量应当降为零，并且出现一条误失提示与额外金额。
3. 会话空闲超过存活时间，程序应当按计划发出一次续期请求，日志里出现一条 `cache_warm` 用量记录。
4. 打印缓存命中率，长时间会话下应当保持在较高水平。

## 常见错误

第一个错误是把时间这类每次都变的字段放进系统提示词。缓存命中率降为零，成本成倍上升。

第二个错误是只统计输入与输出。看不到缓存写入与读取，判断不了前缀是否稳定。

第三个错误是不设噪声下限。缓存断点粒度造成的几百 Token 波动被反复报成问题，真正的浪费被淹没。

第四个错误是续期请求参与重试。续期失败无关紧要，重试只会增加成本。

第五个错误是把模型切换当作正常情况。切换模型会重新计费整个提示词，属于需要统计的支出。