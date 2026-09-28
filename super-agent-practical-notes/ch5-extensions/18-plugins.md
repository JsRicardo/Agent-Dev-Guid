# 18 · Plugin 架构

> 章节：第五章 Skills + Plugins + Channel

## 本讲目标

让别人能给这套 Agent 写功能，而不需要改动主程序。这一讲结束时，插件可以注册工具、命令、事件处理与模型供应方，主程序负责加载、隔离错误与回收资源。

## 要写的代码

```
src/plugins/
├── api.ts        插件可用的接口
├── host.ts       加载与生命周期
├── events.ts     事件总线
└── types.ts
```

### 插件接口

`src/plugins/api.ts`：

```typescript
import { registerTool, type Tool } from "../tools/registry.ts";
import type { SessionStore } from "../context/session.ts";

export type PluginContext = {
  cwd: string;
  mode: "tui" | "rpc" | "print";
  hasUI: boolean;
  session: SessionStore;
  ui: {
    notify: (text: string, level?: "info" | "warning" | "error") => void;
    confirm: (title: string, message: string) => Promise<boolean>;
    select: (title: string, options: string[]) => Promise<string | undefined>;
  };
  signal?: AbortSignal;
};

export type PluginAPI = {
  /** 注册一个模型可以调用的工具 */
  registerTool: (tool: Tool) => void;
  /** 注册一个以斜杠开头的命令 */
  registerCommand: (name: string, handler: CommandHandler) => void;
  /** 注册一个命令行参数 */
  registerFlag: (name: string, options: { description: string; type: "boolean" | "string" }) => void;
  /** 注册一个事件处理，返回取消订阅的函数 */
  on: (type: PluginEventType, handler: PluginEventHandler) => () => void;
  /** 写入不进入模型上下文的数据 */
  appendEntry: (entry: { type: string; data: unknown }) => Promise<void>;
  /** 向会话发送一条消息，内容会进入模型上下文 */
  sendMessage: (message: { role: "user"; text: string }) => Promise<void>;
  /** 改变当前启用的工具集合 */
  setActiveTools: (names: string[]) => void;
  /** 输出通知 */
  notify: (text: string, level?: "info" | "warning" | "error") => void;
};

export type CommandHandler = (args: string, ctx: PluginContext) => Promise<void>;

export type PluginEventType =
  | "session_start"
  | "session_shutdown"
  | "before_agent_start"
  | "message_end"
  | "tool_call"
  | "tool_result"
  | "turn_end"
  | "agent_settled";

export type PluginEventHandler = (event: PluginEvent, ctx: PluginContext) => Promise<PluginEventResult | undefined>;

export type PluginEvent = {
  type: PluginEventType;
  toolName?: string;
  input?: Record<string, unknown>;
  result?: { content: string; isError?: boolean };
  message?: { role: string; text: string };
};

export type PluginEventResult =
  | { block: true; reason: string }
  | { args: Record<string, unknown> }
  | { content: string }
  | { continue: true };

export type Plugin = {
  name: string;
  setup: (api: PluginAPI) => void | Promise<void>;
};
```

事件分两类：通知类只读事件，处理函数的返回值被忽略；变换类事件，返回值会改变流程。`tool_call` 属于变换类，返回 `block` 可以阻止执行；`tool_result` 也属于变换类，返回 `content` 可以改写结果。

### 事件总线

`src/plugins/events.ts`：

```typescript
type Registration = { plugin: string; handler: PluginEventHandler };

export class PluginEvents {
  private listeners = new Map<PluginEventType, Registration[]>();
  private closed = false;

  on(type: PluginEventType, handler: PluginEventHandler, plugin: string): () => void {
    if (this.closed) throw new Error("插件运行时已关闭");
    const list = this.listeners.get(type) ?? [];
    const registration = { plugin, handler };
    list.push(registration);
    this.listeners.set(type, list);
    return () => {
      const index = list.indexOf(registration);
      if (index >= 0) list.splice(index, 1);
    };
  }

  /** 依次调用，任一处理抛出异常时记录并继续，异常不会中断流程。 */
  async emit(type: PluginEventType, event: PluginEvent, ctx: PluginContext): Promise<PluginEventResult | undefined> {
    let merged: PluginEventResult | undefined;
    for (const registration of [...(this.listeners.get(type) ?? [])]) {
      try {
        const result = await registration.handler({ ...event, type }, ctx);
        if (!result) continue;
        if ("block" in result && result.block) return result;
        if ("args" in result || "content" in result) merged = { ...(merged ?? {}), ...result };
        if ("continue" in result) merged = { ...(merged ?? {}), ...result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`插件 ${registration.plugin} 在 ${type} 上出错：${message}`, "warning");
      }
    }
    return merged;
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
  }
}
```

失败隔离是这一层的核心：单个插件出错不影响其余插件，也不中断主流程。异常通过通知上报，不做静默处理。

### 加载

`src/plugins/host.ts`：

```typescript
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PluginEvents } from "./events.ts";
import type { Plugin, PluginAPI, PluginContext } from "./api.ts";

export type LoadedPlugin = {
  name: string;
  dispose: Array<() => void>;
};

export async function loadPlugins(input: {
  dirs: string[];
  context: PluginContext;
  events: PluginEvents;
}): Promise<LoadedPlugin[]> {
  const loaded: LoadedPlugin[] = [];

  for (const dir of input.dirs) {
    const entry = join(dir, "index.ts");
    if (!existsSync(entry)) continue;

    const module = (await import(pathToFileURL(entry).href)) as { default?: Plugin; setup?: Plugin["setup"] };
    const plugin: Plugin = module.default ?? {
      name: dir.split("/").pop() ?? "unknown",
      setup: module.setup!,
    };
    if (!plugin?.setup) continue;

    const dispose: Array<() => void> = [];
    const api: PluginAPI = {
      registerTool: (tool) => input.context.session.constructor,
      registerCommand: () => undefined,
      registerFlag: () => undefined,
      on: (type, handler) => {
        const unsubscribe = input.events.on(type, handler, plugin.name);
        dispose.push(unsubscribe);
        return unsubscribe;
      },
      appendEntry: async () => undefined,
      sendMessage: async () => undefined,
      setActiveTools: () => undefined,
      notify: input.context.ui.notify,
    };

    try {
      await plugin.setup(api);
      loaded.push({ name: plugin.name, dispose });
    } catch (error) {
      input.context.ui.notify(
        `插件 ${plugin.name} 加载失败：${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  }

  return loaded;
}
```

上面这段代码里 `registerTool` 与其余几项留成了占位，写自己的实现时把它们接上即可。重点是加载的结构：每个插件一个 `dispose` 列表，卸载时统一释放。

### 生命周期约束

```typescript
// 插件工厂里不要启动长期资源
export default function headlessPlugin(api: PluginAPI) {
  let timer: ReturnType<typeof setInterval> | undefined;

  api.on("session_start", async (_event, ctx) => {
    // 长驻资源在会话开始时创建
    timer = setInterval(() => {
      ctx.ui.notify("每分钟检查一次", "info");
    }, 60_000);
  });

  api.on("session_shutdown", async () => {
    // 释放动作必须可以重复执行
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  });
}
```

两条规则：工厂里不要启动进程、套接字、监听器或定时器，因为部分调用方式会加载插件而不启动会话；会话级资源在 `session_shutdown` 里释放，并且释放动作要写成可以重复执行，取消、重载、会话替换、进程退出都可能走到同一条路径。

### 状态存储的三种选择

| 状态类型 | 存放位置 |
|----------|----------|
| 跟随活动分支的工具状态 | 工具结果里的 `details` |
| 不进入模型上下文的持久数据 | `appendEntry` |
| 需要进入模型上下文的自定义内容 | `sendMessage` |
| 跨会话的数据 | 外部存储 |

跟随分支的状态需要从会话记录重建。从每个文件条目重建会把被放弃的分支也算进来，那是另一条历史路径。

## pi 的做法

**接口清单。** `docs/extensions.md` 给出了完整的接入点对照：

| 能力 | 接口 |
|------|------|
| 观察或改变生命周期行为 | `pi.on()` |
| 增加一个模型可调用的操作 | `pi.registerTool()` |
| 增加一个斜杠命令 | `pi.registerCommand()` |
| 增加快捷键或命令行参数 | `pi.registerShortcut()` 或 `pi.registerFlag()` |
| 发送使用者消息或自定义消息 | `pi.sendUserMessage()` 或 `pi.sendMessage()` |
| 保存不进入上下文的数据 | `pi.appendEntry()` |
| 改变启用工具、模型、思考等级 | `pi` 上的会话控制方法 |
| 增加模型供应方 | `pi.registerProvider()` |
| 与另一个扩展通信 | `pi.events` |

**加载方式。** 扩展是 TypeScript 模块，导出默认工厂函数，接收 `ExtensionAPI`。pi 使用 `jiti`，本地 TypeScript 扩展不需要单独编译。加载位置支持单个文件与目录形式，目录形式要求有 `index.ts` 或 `index.js` 入口。

**生命周期。** 文档明确两条：工厂里不要启动长期资源；会话级资源在 `session_shutdown` 里释放并保持释放动作可以重复执行。此外给出了运行边界的语义区分：

```
agent_before_settle is the final actionable boundary: it can append entries and request
one continuation. agent_settled is final and notification-only.
```

这一区分对群聊场景很关键：需要在结束前补一次请求时用前者，只做通知时用后者。

**错误处理。** 处理函数出错时 pi 记录并尽量继续；`tool_call` 的处理失败会阻止该工具执行，属于失败即安全；工具执行失败变成给模型的错误结果。三处策略不同，需要按事件的语义分别设计。

**工具约定。** 自定义工具需要名字、面向模型的说明、TypeBox 参数结构与 `execute()`；结果需要面向模型的 `content` 与用于渲染或状态重建的 `details`；工具内部发起嵌套模型调用时，要把用量合并进结果，否则会话总量会漏算；需要顺序执行的工具用于共享内存状态的场景；写入文件的工具要用文件写入队列包住整个读取与写入过程。

**动态启用。** 先把工具全部注册，把可选工具保持未启用，再由一个加载工具调用 `pi.setActiveTools()` 选择启用集合。名称必须已经注册，未知名称被忽略。

**模式差异。** 扩展在交互、RPC、JSON、打印四种模式下都会加载。交互模式提供完整终端界面；RPC 可以转发支持的对话框与通知，不能转发自定义终端组件；JSON 与打印模式没有界面。因此终端专有行为需要用 `ctx.mode === "tui"` 判断，需要界面但非终端专有的交互用 `ctx.hasUI` 判断。

## 验收

1. 写一个只注册一个工具的插件，启动之后该工具出现在可用工具列表里。
2. 写一个 `tool_call` 处理，在对某个工具返回 `block` 之后该工具不再执行，模型收到阻止理由。
3. 让一个插件在事件处理里抛出异常，其余插件与主流程应当继续运行，界面上出现一条警告。
4. 结束会话时，插件里创建的定时器被清理，进程可以正常退出。

## 常见错误

第一个错误是在插件工厂里启动长期资源。部分调用方式只加载插件而不启动会话，资源会被创建却永远不会释放。

第二个错误是事件处理出错时中断整个流程。单个插件的问题影响到全部工作。

第三个错误是把状态存在插件模块的顶层变量里。重载插件之后旧状态与新运行时不匹配。

第四个错误是把跟随分支的状态从全部文件条目重建。被放弃的分支代表另一条历史路径。

第五个错误是忽略模式差异。终端专有的交互在无界面模式下会直接失败。