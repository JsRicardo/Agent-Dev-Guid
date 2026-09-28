# 16 · 上下文压缩

> 章节：第四章 Context Engineering

## 生产中会遇到的问题

长任务进行到中段时请求长度接近窗口上限，程序开始报错或者模型开始忽略早期内容。直接截掉最早的消息会让已完成的工作丢失，模型重新开始探索已经处理过的部分。压缩处理的是这个问题。

## 底层机制

压缩有三类手段，按介入时机排列。

**工具结果裁剪。** 最先介入，也最容易实现。早期的工具结果在完成之后价值下降，可以替换成简短说明。

**对话摘要。** 把较早的多轮对话替换成一份摘要。摘要需要保留的内容有固定分类：任务目标、已完成部分、关键文件、当前状态、未决问题、约束条件。缺少关键文件与约束条件两类内容时，模型会重新探索已经处理过的文件，或者违反之前明确的限制。

**分层保留。** 最近若干轮保留原文，中段使用摘要，最早部分只保留结论。

## 实现要点

触发阈值按窗口比例设置。阈值过高会让压缩过程本身失败，压缩请求需要携带完整历史，此时长度已经接近上限。

压缩之前的完整记录需要保存到外部存储。压缩属于有损操作，出现问题时只有原始记录可以回查。

压缩结果需要标注。压缩之后的消息里应当写明哪些内容被压缩过，让模型知道信息可能不完整。

## pi 的做法

`dist/core/compaction/compaction.js` 与 `docs/compaction.md` 把压缩定义成一套可核对的流程。

**触发条件是一个减法。**

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

保留 16384 Token 给模型的回应，保留 20000 Token 的最近内容不参与压缩。两个数值都可以通过设置覆盖。检查时机有四处：一轮工具批次结束之后、新使用者消息之前、低层运行结束之后的兜底、以及使用者手动的 `/compact`。

**Token 估算用最近一次真实用量加尾部估算。**

```typescript
export function estimateContextTokens(messages) {
  const usageInfo = getLastAssistantUsageInfo(messages);
  if (!usageInfo) { /* 逐条估算 */ }
  const usageTokens = calculateContextTokens(usageInfo.usage);
  let trailingTokens = 0;
  for (let i = usageInfo.index + 1; i < messages.length; i++) {
    trailingTokens += estimateTokens(messages[i]);
  }
  return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex: usageInfo.index };
}
```

已发生的部分用供应方返回的真实用量，之后新增的消息按字符数除以四估算。这个混合方式比全程估算准，也比全程估算便宜。

**切点选择有两个硬约束。**

- 不能切在工具结果上。工具结果必须跟随它对应的调用一起保留。
- 切点位于助手的工具调用上时，它之后的工具结果会一并保留。

```typescript
function isCutPointMessage(message) {
  switch (message.role) {
    case "user": case "assistant": case "bashExecution":
    case "custom": case "branchSummary": case "compactionSummary":
      return true;
    case "toolResult":
      return false;
  }
  return false;
}
```

选择方式是自后向前累加估算长度，达到 `keepRecentTokens` 就停，然后取该位置之后最近的合法切点。位于一条使用者消息中间时记为「分割回合」，并把该回合起始的使用者消息单独带上，避免回合被拦腰截断。

**摘要用固定结构模板。** `SUMMARIZATION_PROMPT` 规定了七个部分：目标、约束与习惯、进展（已完成、进行中、受阻）、关键决策、后续步骤、关键上下文。模板里明确要求保留精确的文件路径、函数名与错误信息。

重复压缩时走的是另一套指令 `UPDATE_SUMMARIZATION_PROMPT`：把新消息合并进已有摘要，规则是保留全部已有信息，只增不改，已完成项从「进行中」移到「已完成」。这样早期的决策不会在第二次压缩时消失。

**文件操作被单独累积。** 压缩不依赖摘要的文字描述来记住涉及过哪些文件，它从工具调用里直接抽取：

```typescript
switch (block.name) {
  case "read":  fileOps.read.add(path); break;
  case "write": fileOps.written.add(path); break;
  case "edit":  fileOps.edited.add(path); break;
}
```

被修改过的文件从只读清单里剔除，两类清单以 `<read-files>` 与 `<modified-files>` 标签追加在摘要末尾。上一轮压缩的清单会被继承，压缩多次之后文件信息仍然完整。这是摘要最容易丢失、后果又最严重的一类信息，因此单独处理。

**送入摘要请求的历史先做序列化与截断。** `serializeConversation` 把消息转成 `[User]`、`[Assistant]`、`[Assistant tool calls]`、`[Tool result]` 这样的文本行，工具结果截到 2000 字符。转成文本的目的是避免模型把摘要请求当成继续对话的任务来处理。

**摘要是生成过程也接收失败判定。** 摘要请求的停止原因是 `error` 或 `length` 时，这段摘要是残缺的，不会被写入会话：

```typescript
if (response.stopReason === "length") {
  return `${label} failed: generation hit the token cap and the summary is incomplete`;
}
```

**原始条目全部保留。** 压缩只追加一条压缩条目，前面的消息条目仍留在会话文件里，导出、计费、历史检索仍然能看到完整过程。

## 常见错误

第一个错误是只压缩对话不裁剪工具结果。工具结果往往是长度增长的主要来源。

第二个错误是摘要不含文件路径。模型重新探索文件，压缩带来的节省被抵消。

第三个错误是压缩之后丢弃原始记录。问题无法回查。

第四个错误是第二次压缩时重写摘要。早期的关键决策在第二次压缩时丢失。

第五个错误是切在工具结果上。模型看到一条没有对应调用的工具结果，供应方也可能直接拒绝请求。

第六个错误是把残缺的摘要写入会话。生成被长度限制截断时摘要内容不完整，却看起来是一份正常记录。

## 自检问题

1. 你的请求长度增长主要来自对话历史还是工具结果？
2. 压缩的触发阈值是多少？
3. 摘要模板包含文件路径与约束条件吗？文件清单是从工具调用里抽取的，还是靠摘要文字描述？
4. 压缩之前的完整对话保存在哪里？