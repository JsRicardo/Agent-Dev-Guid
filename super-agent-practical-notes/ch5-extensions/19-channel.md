# 19 · Channel 抽象：让 Agent 活在飞书群里

> 章节：第五章 Skills + Plugins + Channel

## 本讲目标

把 Agent 接到消息平台。这一讲结束时，程序以常驻进程运行，收到群消息后启动一次运行，把执行过程以卡片形式持续更新，并且同一条消息不会重复处理。

## 要写的代码

```
src/channels/
├── types.ts              Channel 接口
├── feishu/
│   ├── transport.ts      长连接与事件接收
│   ├── cards.ts          卡片构建与更新
│   ├── stream.ts         流式渲染与节流
│   ├── dedupe.ts         事件去重
│   ├── routing.ts        话题到会话的路由
│   ├── trigger.ts        群聊触发策略
│   └── index.ts          组装
```

### Channel 接口

`src/channels/types.ts`：

```typescript
export type IncomingMessage = {
  channelId: string;
  conversationKey: string;
  messageId: string;
  senderId: string;
  senderName: string;
  text: string;
  threadKey?: string;
  attachments: Array<{ type: "image" | "file"; url: string; name?: string }>;
  receivedAt: number;
};

export type OutgoingHandle = {
  handleId: string;
  update: (payload: { text?: string; status?: string; done?: boolean }) => Promise<void>;
};

export type Channel = {
  name: string;
  start: (handlers: { onMessage: (message: IncomingMessage) => Promise<void> }) => Promise<void>;
  stop: () => Promise<void>;
  send: (input: { conversationKey: string; text: string; mentionUserIds?: string[] }) => Promise<OutgoingHandle>;
  reply: (input: { replyToMessageId: string; text: string }) => Promise<OutgoingHandle>;
  typing?: (conversationKey: string) => Promise<void>;
};
```

接口只有五件事：接收、发送、回复、更新、停止。平台差异留在实现里，主流程只依赖这五件事。

### 接入方式与单实例

```typescript
import WebSocket from "ws";
import lockfile from "proper-lockfile";
import { join } from "node:path";

/** 长连接方式：程序作为客户端连出去，不需要公网地址。 */
export async function openTransport(config: {
  appId: string;
  appSecret: string;
  onEvent: (event: unknown) => void;
}) {
  const release = await lockfile.lock(join(process.cwd(), ".super-agent"), {
    lockfilePath: join(process.cwd(), ".super-agent", "gateway.lock"),
    retries: 0,
  });

  const token = await fetchTenantToken(config.appId, config.appSecret);
  const socket = new WebSocket("wss://open.feishu.cn/open-apis/ws/v2", {
    headers: { authorization: `Bearer ${token}` },
  });

  socket.on("message", (raw) => {
    const payload = JSON.parse(raw.toString());
    if (payload.type === "event") config.onEvent(payload);
  });
  socket.on("close", () => {
    release().catch(() => undefined);
  });

  return {
    stop: async () => {
      socket.close();
      await release();
    },
  };
}

async function fetchTenantToken(appId: string, appSecret: string): Promise<string> {
  const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const payload = (await response.json()) as { tenant_access_token?: string; code?: number; msg?: string };
  if (!payload.tenant_access_token) {
    throw new Error(`获取令牌失败：${payload.code} ${payload.msg}`);
  }
  return payload.tenant_access_token;
}
```

两处必须做：启动时取锁，确保同一时间只有一个实例在监听，否则同一条消息会被处理两次；监听套接字关闭时释放锁，避免下次启动拿不到锁。

### 事件去重

```typescript
const TTL_MS = 10 * 60 * 1000;

export class DedupeStore {
  private seen = new Map<string, number>();

  /** 返回 true 表示这条事件之前处理过。 */
  check(eventId: string, now = Date.now()): boolean {
    this.sweep(now);
    if (this.seen.has(eventId)) return true;
    this.seen.set(eventId, now);
    return false;
  }

  private sweep(now: number): void {
    for (const [eventId, timestamp] of this.seen) {
      if (now - timestamp > TTL_MS) this.seen.delete(eventId);
    }
  }
}
```

平台可能重复投递同一事件，去重按事件标识进行，保留十分钟。没有去重时表现为同一个问题被回答两次。

### 话题到会话的路由

```typescript
export type Route = {
  conversationKey: string;
  threadKey?: string;
  sessionId?: string;
};

export function route(message: IncomingMessage): Route {
  // 话题群里一个话题一条线，各自独立成一个会话
  if (message.threadKey) {
    return { conversationKey: message.threadKey, threadKey: message.threadKey };
  }
  return { conversationKey: `dm:${message.senderId}` };
}

export class RouteTable {
  private table = new Map<string, string>();

  sessionFor(route: Route): string | undefined {
    return this.table.get(route.conversationKey);
  }

  bind(route: Route, sessionId: string): void {
    this.table.set(route.conversationKey, sessionId);
    this.persist();
  }

  private persist(): void {
    // 写入 JSON 文件，进程重启之后可以恢复映射
  }
}
```

路由键的选择决定了上下文隔离的粒度。话题群里用话题标识，一对一用聊天对象标识。路由表需要写入文件，否则进程重启之后所有映射丢失。

### 触发策略

```typescript
export type TriggerPolicy = {
  keywords: string[];
  requireMention: boolean;
  ignoreBotSenders: boolean;
};

export function shouldHandle(
  message: IncomingMessage & { isGroup: boolean; mentionedMe: boolean; senderIsBot: boolean },
  policy: TriggerPolicy,
  isThreadReply: boolean,
): boolean {
  if (policy.ignoreBotSenders && message.senderIsBot) return false;
  if (!message.isGroup) return true;
  if (isThreadReply) return true;
  if (policy.requireMention) return message.mentionedMe;
  return policy.keywords.some((keyword) => message.text.includes(keyword));
}
```

策略按三个条件判断：私聊直接处理；话题内的追问继续处理；群聊的首次消息按 @提及或关键词判断。忽略机器人发送的消息是必须的，否则两个机器人会互相触发。

### 流式渲染与节流

```typescript
const PUSH_INTERVAL_MS = 700;

export class StreamingCard {
  private buffer = "";
  private lastPush = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly handle: OutgoingHandle) {}

  push(delta: string): void {
    this.buffer += delta;
    const wait = PUSH_INTERVAL_MS - (Date.now() - this.lastPush);
    if (wait <= 0) {
      void this.flush();
      return;
    }
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, wait);
  }

  async finish(status: string): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.handle.update({ text: this.buffer, status, done: true });
  }

  private async flush(): Promise<void> {
    this.lastPush = Date.now();
    await this.handle.update({ text: this.buffer });
  }
}
```

节流是必需的。每个文本片段都推送一次会让平台接口频繁调用，触发限频，也会让界面出现抖动。间隔取在几百毫秒级别，使用者感受不到延迟，接口调用次数下降两个数量级。

### 卡片构建

```typescript
export function buildCard(input: { title: string; body: string; status?: string; actions?: Array<{ text: string; value: string }> }) {
  return {
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: input.title } },
    elements: [
      { tag: "markdown", content: input.body || "_正在处理…_" },
      ...(input.status ? [{ tag: "markdown", content: `**状态：** ${input.status}` }] : []),
      ...(input.actions?.length
        ? [
            {
              tag: "action",
              actions: input.actions.map((action) => ({
                tag: "button",
                text: { tag: "plain_text", content: action.text },
                value: action.value,
              })),
            },
          ]
        : []),
    ],
  };
}
```

`update_multi: true` 是让卡片可以重复更新的开关。发出去就不能改的消息撑不起执行过程展示。

### 运行时配置热更新

```typescript
export function watchConfig(path: string, onReload: (config: TriggerPolicy) => void): () => void {
  let last = "";
  const timer = setInterval(() => {
    const raw = readFileSync(path, "utf-8");
    if (raw === last) return;
    last = raw;
    onReload(JSON.parse(raw) as TriggerPolicy);
  }, 2_000);
  return () => clearInterval(timer);
}
```

触发关键词这类配置改完立即生效，不需要重启进程。热更新的实现成本很低，收益是调整策略时不需要中断正在运行的任务。

## pi 的做法

**目录结构。** `pi-feishu-lark/.pi/extensions/feishu/` 下的文件划分与讲义基本对应：`transport.ts` 负责接入与事件接收，`message-handler.ts` 处理消息，`conversation-manager.ts` 管理会话映射，`cardkit-stream.ts` 与 `reply-card.ts` 负责卡片与流式更新，`dedupe-store.ts` 去重，`gateway-lock.ts` 单实例，`group-trigger.ts` 触发策略，`runtime-config.ts` 运行时配置，`attachments.ts` 附件，`rich-text.ts` 富文本解析。

**触发与流式更新的顺序。** `index.ts` 里注册的处理顺序值得对照：先 `message_end` 事件处理消息内容与回复，再 `session_start` 与 `session_shutdown` 管理长连接生命周期，最后注册若干工具。长连接在会话开始时建立、会话结束时关闭，符合插件生命周期的约束。

**去掉重复触发。** 本机记忆里记录过一个实际踩到的问题：subagent 子进程会加载全部常驻扩展，导致同一个飞书扩展在子进程里又初始化了一次，出现网关锁与端口冲突。处理方式是在扩展入口检测子进程环境变量，子进程直接返回不初始化。这类问题在「常驻服务 + 子进程」的架构里会反复出现，入口处需要做进程身份判断。

**流式渲染的参数。** 本机的运行时配置里有几个可热更新的参数：是否流式回复、打印频率、打印步长、推送间隔、回复时使用的表情。这些参数与讲义里的 `PUSH_INTERVAL_MS` 是同一类东西：它们决定使用者的体感与接口调用量之间的平衡。

**富媒体与提及。** `rich-text.ts` 负责把消息里的提及占位符还原成可读形式，`attachments.ts` 负责下载图片与文件。做完这两件事，Agent 才真正能处理群里发来的完整内容，而不只是纯文本。

**运行形态。** 飞书 Channel 是这套系统里「常驻服务」这一形态的实现：进程长期运行，由外部消息驱动，每次消息启动一次会话运行。它同时也是第 29 讲部署与第 24 讲 Trace 的观察对象。

## 验收

1. 在群里 @机器人提一个问题，机器人回复一张卡片，内容随生成过程逐步更新。
2. 在同一个话题里追问，问题应当延续之前的上下文；换一个话题提问，应当是一个新的会话。
3. 手动制造一次重复事件投递，程序应当只处理一次。
4. 同时启动两个进程，第二个进程应当因为拿不到锁而退出并给出明确说明。
5. 修改关键词配置，不重启进程，新关键词立即生效。

## 常见错误

第一个错误是不去重。平台重复投递时同一个问题被回答两次。

第二个错误是不加单实例锁。两个进程同时监听，消息被处理两次。

第三个错误是每个文本片段都推送一次。接口调用量暴涨，触发限频。

第四个错误是路由表只放内存。进程重启之后所有话题映射丢失，追问变成新会话。

第五个错误是不忽略机器人发送的消息。两个机器人互相触发，形成消息循环。

第六个错误是把长连接建在模块顶层。部分加载路径不启动会话，连接建立之后无人关闭。