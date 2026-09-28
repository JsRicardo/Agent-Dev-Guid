# 11 · Microcompact 与 LLM 摘要压缩

> 章节：第三章 Context Engineering

## 本讲目标

让长任务能够持续进行。这一讲结束时，程序在请求接近窗口上限之前先把旧工具结果替换成简短记录，必要时再生成一份结构化摘要，并且摘要里一定带着关键文件清单。

## 要写的代码

```
src/context/
├── compact.ts     两级压缩
└── tokens.ts      Token 估算
```

### Token 估算

`src/context/tokens.ts`：

```typescript
import type { Message } from "../types.ts";

const IMAGE_CHARS = 4800;

/** 按字符数除以四估算，这个方法会高估，属于有意的保守估计。 */
export function estimateTokens(message: Message): number {
  let chars = 0;
  if (message.role === "system") {
    chars += message.text.length;
    for (const part of Object.values(message.sections ?? {})) {
      if (part) chars += part.length;
    }
    chars += JSON.stringify(message.toolsAdded ?? []).length;
    chars += JSON.stringify(message.toolsRemoved ?? []).length;
    return Math.ceil(chars / 4);
  }
  chars += message.text.length;
  if (message.role === "assistant") {
    chars += JSON.stringify(message.toolCalls ?? []).length;
  }
  return Math.ceil(chars / 4);
}

/** 已发生的部分用供应方返回的真实用量，之后新增的消息按估算补齐。 */
export function estimateContextTokens(messages: Message[]) {
  let usageIndex = -1;
  let usageTokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = messages[i].usage;
    if (messages[i].role === "assistant" && usage && messages[i].stopReason !== "error") {
      usageTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
      usageIndex = i;
      break;
    }
  }

  let trailing = 0;
  for (let i = (usageIndex === -1 ? 0 : usageIndex + 1); i < messages.length; i++) {
    trailing += estimateTokens(messages[i]);
  }
  return { tokens: usageTokens + trailing, usageTokens, trailingTokens: trailing, usageIndex };
}
```

混合估算比全程估算准，也比全程估算便宜：已经发生的部分由供应方给出真实数字，只有新增消息需要折算。

### 第一级：Microcompact

```typescript
/** 保留最近这么多次工具结果，更早的替换成简短记录。 */
const KEEP_RECENT_TOOL_RESULTS = 8;

export function microcompact(messages: Message[]): { messages: Message[]; released: number } {
  const toolIndexes = messages
    .map((message, index) => (message.role === "toolResult" ? index : -1))
    .filter((index) => index >= 0);

  const toStrip = new Set(toolIndexes.slice(0, Math.max(0, toolIndexes.length - KEEP_RECENT_TOOL_RESULTS)));
  if (toStrip.size === 0) return { messages, released: 0 };

  let released = 0;
  const next = messages.map((message, index) => {
    if (!toStrip.has(index) || message.role !== "toolResult") return message;
    if (message.text.startsWith("[已省略]")) return message;
    const wasError = message.isError ? "，当时返回错误" : "";
    released += estimateTokens(message);
    return {
      ...message,
      text: `[已省略] 此前调用 ${message.name} 的结果，共 ${message.text.length} 字符${wasError}`,
    };
  });
  return { messages: next, released };
}
```

替换成「调用了什么工具、结果有多大、当时是否出错」这三项信息，模型的损失很小，长度收益很大。工具结果往往是长度增长的主要来源。

### 第二级：摘要压缩

```typescript
export const COMPACTION_SETTINGS = {
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
};

export function shouldCompact(contextTokens: number, contextWindow: number): boolean {
  return contextTokens > contextWindow - COMPACTION_SETTINGS.reserveTokens;
}

/** 找切点：从最新往前累加，达到保留额度就停。切点不能位于工具结果上。 */
export function findCutIndex(
  messages: Message[],
  keepRecentTokens = COMPACTION_SETTINGS.keepRecentTokens,
): { cutIndex: number; isSplitTurn: boolean } {
  const cuttable = messages
    .map((message, index) => (message.role === "toolResult" ? -1 : index))
    .filter((index) => index >= 0);

  let accumulated = 0;
  let cutIndex = cuttable[0] ?? 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const size = estimateTokens(messages[i]);
    if (size === 0) continue;
    accumulated += size;
    if (accumulated >= keepRecentTokens) {
      cutIndex = cuttable.find((candidate) => candidate >= i) ?? cuttable[cuttable.length - 1] ?? i;
      break;
    }
  }

  const startsTurn = messages[cutIndex]?.role !== "assistant";
  let turnStart = cutIndex;
  if (!startsTurn) {
    for (let i = cutIndex; i >= 0; i--) {
      if (messages[i].role === "user") {
        turnStart = i;
        break;
      }
    }
  }
  return { cutIndex, isSplitTurn: !startsTurn && turnStart !== cutIndex };
}
```

两条硬约束：切点不能位于工具结果上，因为工具结果必须跟随它对应的调用；切点位于助手消息上时，它之后的工具结果会一并保留，这一回合的起始使用者消息需要单独带上，避免回合被截断。

### 摘要模板与文件清单

```typescript
const SUMMARY_PROMPT = `上面是需要压缩的对话。请生成一份结构化的上下文检查点，供另一个模型继续这项工作。

严格使用以下格式：

## 任务目标
[使用者在做什么，如果涉及多个任务就分别列出]

## 约束与习惯
- [使用者提到的限制、习惯或要求]

## 进展
### 已完成
- [x] [已完成的任务或改动]

### 进行中
- [ ] [当前正在做的事]

### 受阻
- [存在的问题，没有则写「无」]

## 关键决策
- **[决策]**：[简要理由]

## 后续步骤
1. [按顺序列出接下来该做什么]

## 关键上下文
- [继续工作所需的数据、示例或引用]

每一节保持简短。必须保留精确的文件路径、函数名与错误信息。不要继续对话，不要回答对话里的任何问题。`;
```

文件清单单独累积，不依赖摘要的文字描述：

```typescript
export type FileOps = { read: Set<string>; written: Set<string>; edited: Set<string> };

export function collectFileOps(messages: Message[], previous?: { readFiles: string[]; modifiedFiles: string[] }): FileOps {
  const ops: FileOps = { read: new Set(previous?.readFiles ?? []), written: new Set(previous?.modifiedFiles ?? []), edited: new Set() };
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      const args = call.args as { path?: string };
      if (!args.path) continue;
      if (call.name === "read") ops.read.add(args.path);
      if (call.name === "write") ops.written.add(args.path);
      if (call.name === "edit") ops.edited.add(args.path);
    }
  }
  return ops;
}

export function renderFileLists(ops: FileOps): string {
  const modified = new Set([...ops.written, ...ops.edited]);
  const readOnly = [...ops.read].filter((path) => !modified.has(path)).sort();
  const sections: string[] = [];
  if (readOnly.length > 0) sections.push(`<read-files>\n${readOnly.join("\n")}\n</read-files>`);
  if (modified.size > 0) sections.push(`<modified-files>\n${[...modified].sort().join("\n")}\n</modified-files>`);
  return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}
```

重复压缩时摘要采用增量合并：

```typescript
const UPDATE_PROMPT = `下面是一条新的对话片段，需要合并进 <previous-summary> 里已有的摘要。

规则：
- 保留已有摘要里的全部信息
- 补充新的进展、决策与上下文
- 把「进行中」里已经完成的条目移到「已完成」
- 根据实际完成情况更新「后续步骤」
- 保留精确的文件路径、函数名与错误信息

仍然使用与上一份摘要完全相同的七个部分。`;
```

### 压缩的执行与失败判定

```typescript
export async function compactOnce(input: {
  messages: Message[];
  previousSummary?: string;
  callModel: (messages: Message[], tools: never[]) => Promise<Message>;
}) {
  const { cutIndex } = findCutIndex(input.messages);
  if (cutIndex === 0) return undefined;

  const toSummarize = input.messages.slice(0, cutIndex);
  const kept = input.messages.slice(cutIndex);
  const ops = collectFileOps(toSummarize);
  const serialized = serialize(toSummarize);

  const summaryRequest: Message[] = [
    { role: "user", text: input.previousSummary ? `<previous-summary>\n${input.previousSummary}\n</previous-summary>\n\n${serialized}` : serialized },
    { role: "user", text: input.previousSummary ? UPDATE_PROMPT : SUMMARY_PROMPT },
  ];

  const response = await input.callModel(summaryRequest, [] as never[]);
  if (response.stopReason === "length") {
    console.error("摘要生成被输出上限截断，本次压缩作废");
    return undefined;
  }
  if (response.stopReason === "error") {
    console.error(`摘要生成失败：${response.errorMessage}`);
    return undefined;
  }

  return {
    summary: response.text + renderFileLists(ops),
    firstKeptEntryId: kept[0]?.id,
    tokensBefore: estimateContextTokens(input.messages).tokens,
  };
}

/** 把对话转成文本，避免模型把它当成需要继续的对话。 */
function serialize(messages: Message[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "user") parts.push(`[使用者]: ${message.text}`);
    if (message.role === "assistant") {
      if (message.text) parts.push(`[助手]: ${message.text}`);
      const calls = (message.toolCalls ?? []).map((call) => `${call.name}(${JSON.stringify(call.args)})`);
      if (calls.length > 0) parts.push(`[助手工具调用]: ${calls.join("; ")}`);
    }
    if (message.role === "toolResult") {
      const text = message.text.length > 2000 ? `${message.text.slice(0, 2000)}\n\n[... 其余内容省略]` : message.text;
      parts.push(`[工具结果]: ${text}`);
    }
  }
  return parts.join("\n\n");
}
```

摘要请求的工具集合传空数组。摘要本身也是模型调用，如果允许它继续调用工具，压缩过程会变成一次新的任务。

## pi 的做法

**触发公式与默认取值。** `dist/core/compaction/compaction.js`：

```typescript
export const DEFAULT_COMPACTION_SETTINGS = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
};

export function shouldCompact(contextTokens, contextWindow, settings) {
  if (!settings.enabled) return false;
  return contextTokens > contextWindow - settings.reserveTokens;
}
```

保留 16384 Token 给模型的回应，保留 20000 Token 的最近内容不参与压缩。检查时机有四处：一轮工具批次结束之后、新使用者消息之前、低层运行结束之后的兜底、以及手动触发。

**切点判定。** pi 的 `isCutPointMessage` 明确把 `toolResult` 排除在外，`isTurnStartEntry` 用于判断回合起始。切点位于一条超出额度的使用者消息内部时记为「分割回合」，并把该回合起始的使用者消息单独带上。

**摘要模板。** pi 的 `SUMMARIZATION_PROMPT` 与讲义里的七个部分一致，模板里同样要求保留精确的文件路径、函数名与错误信息，并要求模型不要继续对话。重复压缩使用 `UPDATE_SUMMARIZATION_PROMPT`，规则是保留全部已有信息、只增不改。

**文件清单的累积方式。** 这一处值得单独记录：pi 不依赖摘要的文字描述记住涉及过哪些文件，它从工具调用里直接抽取：

```typescript
switch (block.name) {
  case "read":  fileOps.read.add(path); break;
  case "write": fileOps.written.add(path); break;
  case "edit":  fileOps.edited.add(path); break;
}
```

被修改过的文件从只读清单里剔除，两类清单以 `<read-files>` 与 `<modified-files>` 标签追加在摘要末尾，上一轮压缩的清单会被继承。

**残次摘要不入库。** 摘要请求的停止原因是 `error` 或 `length` 时，这段摘要不完整，pi 直接放弃本次压缩：

```typescript
if (response.stopReason === "length") {
  return `${label} failed: generation hit the token cap and the summary is incomplete`;
}
```

**摘要请求不写缓存。** 一次性请求不太可能被复用，写入缓存反而增加成本，因此摘要求使用独立的参数。

**原始条目保留。** 压缩只追加一条压缩条目，前面的消息条目仍留在会话文件里，导出、计费与历史检索仍然能看到完整过程。

## 验收

1. 跑一个需要几十轮的任务，在请求长度到达窗口七成左右时，日志里应当出现一次 microcompact，工具结果被替换成省略说明。
2. 继续跑到八成长度，摘要出现，摘要末尾带有 `<modified-files>` 清单，清单里的路径与之前实际改动过的文件一致。
3. 压缩之后继续提一个与之前改动文件相关的问题，模型应当直接说出文件路径，不需要重新搜索。
4. 第二次压缩发生时，摘要里仍然保留第一次压缩时记录的早期决策。

## 常见错误

第一个错误是只压缩对话不裁剪工具结果。工具结果是长度增长的主要来源。

第二个错误是摘要不含文件路径。模型重新探索文件，压缩带来的节省被抵消。

第三个错误是压缩之后丢弃原始记录。问题无法回查。

第四个错误是切在工具结果上。模型看到一条没有对应调用的工具结果，供应方也可能直接拒绝请求。

第五个错误是第二次压缩时重写摘要。早期的关键决策在第二次压缩时丢失。

第六个错误是把残次摘要写入会话。生成被输出上限截断时摘要内容不完整，却看起来是一份正常记录。