# 8 · MCP 接入实战：给 Agent 接上 GitHub

> 章节：第二章 Tool System

## 本讲目标

写一个 MCP 客户端，把远程服务暴露的工具接进本地工具注册表。这一讲结束时，Agent 能通过 MCP 服务端调用 GitHub 相关的操作，并且这些调用同样经过本地的权限判定与结果截断。

## 要写的代码

```
src/tools/
├── mcp/
│   ├── client.ts       JSON-RPC 客户端与进程管理
│   ├── adapter.ts      把远端工具映射成本地工具
│   └── config.ts       服务端配置
```

### 客户端

```typescript
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

type JsonRpcResponse = { jsonrpc: "2.0"; id: number; result?: unknown; error?: { code: number; message: string } };
type JsonRpcNotification = { jsonrpc: "2.0"; method: string; params?: unknown };

export type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export class McpClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private restarts = 0;

  constructor(
    private readonly config: { name: string; command: string; args: string[]; env?: Record<string, string> },
    private readonly onToolsChanged: (tools: McpToolDefinition[]) => void,
    private readonly maxRestarts = 3,
  ) {}

  async start(): Promise<void> {
    this.child = spawn(this.config.command, this.config.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.config.env },
    }) as ChildProcessWithoutNullStreams;

    const reader = createInterface({ input: this.child.stdout });
    reader.on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (chunk) => {
      console.error(`[mcp:${this.config.name}] ${chunk.toString().trim()}`);
    });
    this.child.on("exit", (code) => {
      for (const [, entry] of this.pending) {
        entry.reject(new Error(`MCP 服务端 ${this.config.name} 已退出，退出码 ${code}`));
      }
      this.pending.clear();
      void this.restart();
    });

    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      clientInfo: { name: "super-agent", version: "0.1.0" },
    });
    this.notify("notifications/initialized", {});

    const listed = (await this.request("tools/list", {})) as { tools?: McpToolDefinition[] };
    this.onToolsChanged(listed.tools ?? []);
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<{ text: string; isError: boolean }> {
    try {
      const result = (await this.request("tools/call", { name, arguments: args }, signal)) as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      const text = (result.content ?? [])
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text!)
        .join("\n");
      return { text: text || "(空结果)", isError: result.isError === true };
    } catch (error) {
      return {
        text: `MCP 调用失败：${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  }

  async stop(): Promise<void> {
    this.child?.kill("SIGTERM");
    this.child = undefined;
  }

  private async restart(): Promise<void> {
    if (this.restarts >= this.maxRestarts) {
      console.error(`[mcp:${this.config.name}] 重启次数已达上限，停止重试`);
      return;
    }
    this.restarts++;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000 * this.restarts));
    await this.start();
  }

  private handleLine(line: string): void {
    let message: JsonRpcResponse | JsonRpcNotification;
    try {
      message = JSON.parse(line);
    } catch {
      console.error(`[mcp:${this.config.name}] 收到无法解析的内容：${line.slice(0, 200)}`);
      return;
    }
    if (!("id" in message)) return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    if (message.error) {
      entry.reject(new Error(`${message.error.code}: ${message.error.message}`));
    } else {
      entry.resolve(message.result);
    }
  }

  private request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      if (!this.child) {
        reject(new Error(`MCP 服务端 ${this.config.name} 未启动`));
        return;
      }
      this.pending.set(id, { resolve: resolvePromise, reject });
      signal?.addEventListener(
        "abort",
        () => {
          this.pending.delete(id);
          reject(new Error("已中止"));
        },
        { once: true },
      );
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }
}
```

协议的要点：每条消息一行 JSON，请求带 `id` 用于关联响应，通知不带 `id`；连接建立后必须发送 `notifications/initialized`，否则部分服务端不会响应后续请求。

### 映射成本地工具

`src/tools/mcp/adapter.ts`：

```typescript
import { registerTool, type Tool, type ToolResult } from "../registry.ts";
import type { McpClient, McpToolDefinition } from "./client.ts";

/** MCP 工具的输入结构不一定带 required，这里补一个转换，保证本地校验可用。 */
function toParameters(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {} };
  }
  return schema;
}

export function registerMcpTools(serverName: string, client: McpClient, definitions: McpToolDefinition[]): Tool[] {
  const registered: Tool[] = [];
  for (const definition of definitions) {
    const localName = `${serverName}__${definition.name}`;
    const tool: Tool = {
      name: localName,
      description: definition.description ?? `来自 ${serverName} 的工具`,
      snippet: `调用 ${serverName} 的 ${definition.name}`,
      parameters: toParameters(definition.inputSchema),
      async execute(args): Promise<ToolResult> {
        const result = await client.callTool(definition.name, args);
        return {
          content: result.text,
          isError: result.isError,
          details: { server: serverName, remoteTool: definition.name },
        };
      },
    };
    registerTool(tool);
    registered.push(tool);
  }
  return registered;
}
```

本地名称加服务端前缀，原因是不同服务端可能暴露同名工具。前缀同时让权限规则可以按服务端匹配。

### 启动与回收

```typescript
import { McpClient } from "./client.ts";
import { registerMcpTools } from "./adapter.ts";
import { getTool } from "../registry.ts";
import { withTimeout } from "../../agent/retry.ts";

export async function startMcpServers(
  configs: Array<{ name: string; command: string; args: string[]; env?: Record<string, string>; allowTools?: string[] }>,
): Promise<McpClient[]> {
  const clients: McpClient[] = [];
  for (const config of configs) {
    const client = new McpClient(config, (definitions) => {
      const allowed = config.allowTools
        ? definitions.filter((item) => config.allowTools!.includes(item.name))
        : definitions;
      registerMcpTools(config.name, client, allowed);
    });
    await withTimeout(client.start(), 30_000, `MCP 服务端 ${config.name} 启动超时`);
    clients.push(client);
  }
  return clients;
}

export async function stopMcpServers(clients: McpClient[]): Promise<void> {
  await Promise.all(clients.map((client) => client.stop().catch(() => undefined)));
}
```

启动超时是必须的：首次启动往往需要下载依赖，等待时间可能达到数十秒；没有超时的时候，一个配置错误的服务端会让整个程序卡在启动阶段。

### 结果处理与权限

MCP 工具的执行结果同样经过本地截断：

```typescript
const truncation = truncateTail(result.text);
return {
  content: truncation.content + truncationNotice(truncation),
  isError: result.isError,
};
```

权限判定放在本地执行管线里，按工具名称的前缀匹配：

```typescript
// src/policy/permissions.ts
if (call.name.includes("__")) {
  const [server, remoteTool] = call.name.split("__");
  return decide(`mcp:${server}/${remoteTool}`, call.args);
}
```

这一步是必要的：MCP 服务端不受本地权限系统管辖，如果不在调用入口拦截，使用者在配置里禁止的操作仍然可以通过 MCP 执行。

## pi 的做法

**核心不内置 MCP。** pi 的 `docs` 目录里没有 MCP 文档，`dist/core` 里没有 MCP 模块，内置工具集合由 `dist/core/tools/index.js` 固定导出八个工具。MCP 通过扩展接入，社区实现是 `pi-mcp-adapter`。

这个选择带来几处实际限制，`pi-subagents` 的文档记录得很清楚：

| 限制 | 原因 |
|------|------|
| MCP 工具必须在后台子智能体里使用 | 前台子智能体是父进程内的会话，不加载父级的扩展，拿不到适配器注册的工具 |
| 工具元数据在启动时缓存 | 连接新的服务端之后需要重启，直接工具才可用 |
| `mcp:` 前缀只授予指定的 MCP 工具 | 白名单，不会连带放开内置工具 |
| 运行时注册的服务端无法提供给子智能体 | 子智能体是进程内会话，无法接收 MCP 配置参数 |

这份限制表说明复杂度集中在四个位置：进程模型、扩展加载时机、权限收窄、工具元数据缓存。讲义里的实现按同样的顺序处理这四处。

**结果归一化。** 外部命令行适配器的文档里写明：标准错误与标准输出都是不可信内容，只有在有界的有效 JSON 里看到完成事件，并且最终产物存在时，运行才算成功。接入任何外部服务端都应当按这个标准判断，不能把「进程退出码为零」当作成功。

## 验收

1. 配置一个不存在的命令，启动应当在超时之后给出明确的失败说明，程序继续运行且其余工具可用。
2. 调用一个 MCP 工具，结果里带有服务端前缀，超长结果被截断并给出标记。
3. 在权限配置里禁止 `mcp:github/create_issue`，再让模型尝试调用，应当被阻止并返回理由。
4. 手动结束服务端进程，客户端应当在短时间内重启它，重启次数超过上限后停止并记录。

## 常见错误

第一个错误是不同服务端的工具名不加前缀。同名工具互相覆盖，注册表里只剩最后一个。

第二个错误是把 MCP 调用放行于权限系统之外。配置文件里的禁止规则完全不起作用。

第三个错误是不做启动超时。配置错误时程序卡在启动阶段，其余功能也无法使用。

第四个错误是不限制重启次数。服务端持续崩溃时客户端会不停重启。

第五个错误是把外部输出直接当作可信数据。返回内容需要截断、需要标注来源，也需要按不可信内容处理。