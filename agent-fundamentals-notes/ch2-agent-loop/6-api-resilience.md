# 6 · 模型 API 故障时的生产级容错

> 章节：第二章 Agent Loop

## 生产中会遇到的问题

单个请求加一层 `try-catch` 只能让程序不崩溃，使用者看到的是「出错了」。生产环境里的故障形态是多样的：限流返回 429、服务端波动返回 502、连接在中途断开、某家供应方整体不可用、上下文超出窗口。不同形态需要不同的处理方式，把全部错误归成一个分支会导致本该成功的请求被放弃，或者本该放弃的请求被反复重试。

## 底层机制

错误按可重试性分类：

| 状态或现象 | 可重试 | 处理方式 |
|------------|--------|----------|
| 429 限流 | 是 | 按响应头给出的等待时间重试 |
| 500、502、503、504 | 是 | 指数退避重试 |
| 连接中断、读取超时 | 是 | 指数退避重试 |
| 额度与账单耗尽 | 否 | 直接失败并告警 |
| 400 参数错误 | 否 | 直接失败并记录请求内容 |
| 上下文超长 | 否 | 触发压缩之后重新请求 |

退避策略需要加入随机抖动，否则大量请求会在同一时刻集中重试。等待时间应当分段增长，并设置总时长上限。

流式请求的重试与普通请求不同。已经输出给使用者的内容无法撤销，重试会导致内容重复。

## 实现要点

超时应当分为三级，避免单一超时值造成误判：连接超时、首字超时、整体超时。首字超时单独设置的原因是推理模型的排队时间与思考时间较长。

供应商降级需要提前准备。降级模型的输出格式与工具调用能力可能与主模型不同，降级路径必须经过完整测试。

熔断器按供应方与模型分别计数。连续失败达到阈值后暂时停止发送请求，经过冷却时间再放少量请求探测。

重试过程需要记录。每一次重试的原因、耗时、最终结果都要进入日志。

## pi 的做法

容错在 pi 里分成三层，各层职责明确。

**第一层：可重试性判定。** `pi-ai/dist/utils/retry.js` 用两张正则表做判定，判定依据是错误文本。

- 可重试表的模式包括 `overloaded`、`rate.?limit`、`429`、`500` 到 `504`、`520`、`524`、`network.?error`、`connection.?refused`、`socket hang up`、`timed? out`、`ended without`、`stream ended before message_stop`、`http2 request did not get a response`、`websocket.?closed` 等。
- 不可重试表的模式优先判断，包括 `insufficient_quota`、`out of budget`、`quota exceeded`、`billing`、`GoUsageLimitError`、`FreeUsageLimitError`。额度耗尽与限流在文本上容易混淆，因此不可重试表单独存在。
- 流式过程中断被当作可重试，例如 `terminated` 与 `stream ended before message_stop`。这类故障在非流式模式下不会出现。

**第二层：退避与预算。** `retryAssistantCall` 在一轮请求上做有限次重试。

```typescript
export function retryDelayMs(policy, attempt) {
  const delay = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const safeDelay = Number.isSafeInteger(delay) ? delay : Number.MAX_SAFE_INTEGER;
  return Math.min(safeDelay, policy.maxAgentDelayMs ?? DEFAULT_MAX_AGENT_RETRY_DELAY_MS);
}
```

默认取值为：`maxRetries` 为 3，`baseDelayMs` 为 2000 毫秒，单次等待上限 60000 毫秒。三次等待分别是 2 秒、4 秒、8 秒。可选回调 `onRetryScheduled`、`onRetryAttemptStart`、`onRetryFinished` 让界面报告重试进度。

中止的处理方式值得注意：重试等待期间收到中止信号时，返回的消息结构与供应方中止形态一致（`stopReason: "aborted"`），调用方不需要关心取消发生在哪一步。

**第三层：上下文溢出的专用恢复。** 溢出不属于可重试错误，它有独立的恢复流程，与压缩联动。

```
持久化最后的助手回应
→ 对外发出 turn_end 与 agent_end
→ 为选定的尝试追加 context_edit 省略项
→ 执行 session_before_compact 钩子并在成功时追加压缩条目
→ 作为一次全新的运行重新开始
```

供应方识别同样做了适配。`pi-ai/dist/utils/overflow.js` 维护了一张按供应方整理的错误文本表，并排除「看起来像溢出其实是限流」的误判，例如 Bedrock 的 `ThrottlingException: Too many tokens, please wait before trying again.` 会被限流规则拦下。此外还处理两种不报错的情况：请求被接受但用量显示输入超过窗口，以及返回 `length` 且输出为零。

## 常见错误

第一个错误是对全部错误统一重试。参数错误重试一百次也不会成功。

第二个错误是不加随机抖动。同步重试在故障恢复瞬间产生流量尖峰。

第三个错误是忽略额度类错误与限流的区别。把配额耗尽当作限流重试，会持续消耗时间并反复失败。

第四个错误是对上下文溢出做普通重试。溢出需要的是压缩，重试只会再次失败。

第五个错误是没有全局请求预算。单次请求重试多次，加上循环多轮，总耗时可能达到几十分钟。

## 自检问题

1. 你的程序能区分 429 与 500 吗，各自的等待时间是多少？
2. 你的可重试判定依据是状态码还是错误文本？两种溢出的情况都覆盖了吗？
3. 流式请求中途断开之后，使用者看到的内容会重复吗？
4. 上下文溢出走的是重试路径还是压缩路径？