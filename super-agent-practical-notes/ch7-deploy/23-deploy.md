# 23 · 配置系统、CLI 入口与部署上线

> 章节：第七章 部署

## 本讲目标

把这套程序变成一个可以交给他人的工具。这一讲结束时，配置分层且可校验，命令行入口支持四种运行方式，进程可以由管理程序常驻并在异常退出后重新拉起。

## 要写的代码

```
src/
├── config/
│   ├── schema.ts       配置结构
│   ├── load.ts         分层加载与合并
│   └── diagnostics.ts  校验诊断
├── cli.ts              入口
└── modes/
    ├── interactive.ts
    ├── print.ts
    ├── json.ts
    └── rpc.ts
```

### 配置分层

```typescript
export type Settings = {
  model: { provider: string; id: string; contextWindow: number };
  limits: { maxSteps: number; maxTokens: number; maxRepeats: number };
  retry: { enabled: boolean; maxRetries: number; baseDelayMs: number; maxAgentDelayMs: number };
  tools: { active: string[]; disableBuiltin: string[] };
  compact: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
  cacheWarming: "off" | "streaming" | "idle";
  permissions: { defaultDecision: "allow" | "ask" | "deny"; rules: Array<{ match: string; decision: "allow" | "ask" | "deny" }> };
  channels: Array<{ name: string; type: "feishu"; enabled: boolean }>;
};
```

四个来源按优先级合并，后面的覆盖前面的：

| 顺序 | 来源 | 用途 |
|------|------|------|
| 1 | 内置默认值 | 保证程序总能启动 |
| 2 | 使用者级配置 `~/.super-agent/settings.json` | 个人习惯 |
| 3 | 项目级配置 `.super-agent/settings.json` | 项目约定 |
| 4 | 环境变量与命令行参数 | 单次运行覆盖 |

`src/config/load.ts`：

```typescript
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULTS: Settings = {
  model: { provider: "openai", id: "gpt-4.1-mini", contextWindow: 128_000 },
  limits: { maxSteps: 30, maxTokens: 200_000, maxRepeats: 3 },
  retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000, maxAgentDelayMs: 60_000 },
  tools: { active: ["read", "write", "edit", "bash", "grep", "glob"], disableBuiltin: [] },
  compact: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
  cacheWarming: "streaming",
  permissions: { defaultDecision: "ask", rules: [] },
  channels: [],
};

export function loadSettings(input: { cwd: string; overrides?: Partial<Settings> }): { settings: Settings; sources: string[] } {
  const sources: string[] = ["内置默认值"];
  let settings = DEFAULTS;

  const userPath = join(homedir(), ".super-agent", "settings.json");
  const projectPath = join(input.cwd, ".super-agent", "settings.json");

  for (const [path, label] of [[userPath, "使用者配置"], [projectPath, "项目配置"]] as const) {
    const parsed = readJson(path);
    if (!parsed) continue;
    settings = merge(settings, parsed as Partial<Settings>);
    sources.push(label);
  }

  settings = applyEnv(settings);
  if (input.overrides) {
    settings = merge(settings, input.overrides);
    sources.push("命令行参数");
  }

  return { settings, sources };
}

function readJson(path: string): unknown {
  try {
    const raw = readFileSync(path, "utf-8").replace(/\$\{(\w+)\}/g, (_match, name: string) => process.env[name] ?? "");
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function merge<T>(base: T, patch: Partial<T>): T {
  const output = { ...base } as T;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = (base as Record<string, unknown>)[key];
    if (isPlainObject(value) && isPlainObject(current)) {
      (output as Record<string, unknown>)[key] = merge(current, value as Record<string, unknown>);
    } else {
      (output as Record<string, unknown>)[key] = value;
    }
  }
  return output;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function applyEnv(settings: Settings): Settings {
  const output = { ...settings };
  if (process.env.SUPER_AGENT_MODEL) {
    const [provider, id] = process.env.SUPER_AGENT_MODEL.split("/");
    output.model = { ...output.model, provider, id };
  }
  if (process.env.SUPER_AGENT_MAX_STEPS) {
    output.limits = { ...output.limits, maxSteps: Number(process.env.SUPER_AGENT_MAX_STEPS) };
  }
  if (process.env.SUPER_AGENT_CACHE_WARMING) {
    output.cacheWarming = process.env.SUPER_AGENT_CACHE_WARMING as Settings["cacheWarming"];
  }
  return output;
}
```

配置文件里允许用 `${变量名}` 引用环境变量，密钥本身放在环境变量或独立的凭据文件里，不进入配置文件。这一条决定了配置文件能否放进版本管理。

### 校验与诊断

```typescript
export function diagnose(settings: Settings): string[] {
  const problems: string[] = [];
  if (settings.limits.maxTokens <= settings.compact.reserveTokens) {
    problems.push("maxTokens 不大于 reserveTokens，压缩永远不会触发");
  }
  if (settings.compact.keepRecentTokens > settings.model.contextWindow / 2) {
    problems.push("keepRecentTokens 超过窗口的一半，压缩收益有限");
  }
  if (settings.retry.maxRetries > 5) {
    problems.push("maxRetries 超过五次，失败反馈时间会很长");
  }
  if (settings.permissions.defaultDecision === "allow" && settings.permissions.rules.length === 0) {
    problems.push("默认允许且没有任何规则，危险操作不会被拦截");
  }
  for (const rule of settings.permissions.rules) {
    if (!rule.match) problems.push("存在空的规则匹配");
  }
  return problems;
}
```

诊断输出在启动时打印。这类检查的价值在于把配置矛盾在启动阶段暴露，避免在运行中表现为难以解释的行为。

### 命令行入口

```typescript
type Mode = "interactive" | "print" | "json" | "rpc";

export function parseArgs(argv: string[]) {
  const options: {
    mode: Mode;
    prompt?: string;
    app?: string;
    cwd: string;
    sessionId?: string;
    noSession: boolean;
    extensionPaths: string[];
    model?: string;
  } = { mode: "interactive", cwd: process.cwd(), noSession: false, extensionPaths: [] };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--mode") options.mode = argv[++i] as Mode;
    else if (arg === "-p" || arg === "--print") options.mode = "print";
    else if (arg === "--json") options.mode = "json";
    else if (arg === "--rpc") options.mode = "rpc";
    else if (arg === "--app") options.app = argv[++i];
    else if (arg === "--cwd") options.cwd = argv[++i];
    else if (arg === "--session") options.sessionId = argv[++i];
    else if (arg === "--no-session") options.noSession = true;
    else if (arg === "--extension") options.extensionPaths.push(argv[++i]);
    else if (arg === "--model") options.model = argv[++i];
    else if (!arg.startsWith("-")) options.prompt = options.prompt ? `${options.prompt} ${arg}` : arg;
  }
  return options;
}
```

四种运行方式共用同一套会话与循环机制，差别只在输入输出：

| 方式 | 输入输出 | 适用 |
|------|----------|------|
| `interactive` | 终端界面 | 人工使用 |
| `print` | 一个提示词进，最终结果出 | 脚本调用 |
| `json` | 事件按行输出 JSON | 管道处理 |
| `rpc` | 标准输入输出按行收发 JSON | 常驻服务、编辑器插件 |

### 优雅退出

```typescript
export function installShutdownHandlers(dispose: Array<() => Promise<void>>): void {
  let shuttingDown = false;

  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[退出] 原因：${reason}`);
    for (const action of dispose) {
      try {
        await action();
      } catch (error) {
        console.error(`[退出] 释放资源失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("收到中断信号"));
  process.on("SIGTERM", () => void shutdown("收到终止信号"));
  process.on("uncaughtException", (error) => void shutdown(`未捕获异常：${error.message}`));
  process.on("unhandledRejection", (reason) => void shutdown(`未处理的拒绝：String(reason)`));
}
```

释放动作需要可以重复执行，并且要覆盖全部长期资源：会话文件的写入缓冲、消息通道的长连接、定时任务、子进程、锁文件。

### 常驻部署

```yaml
# ecosystem.config.cjs（进程管理配置）
module.exports = {
  apps: [
    {
      name: "super-agent",
      script: "dist/cli.js",
      args: "--mode rpc",
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      kill_timeout: 15000,
      max_memory_restart: "1G",
      out_file: "logs/out.log",
      error_file: "logs/error.log",
      time: true,
    },
  ],
};
```

几个参数的作用：`instances: 1` 保证只有一个实例；`max_restarts` 限制重启次数，配置错误时不会无限重启；`kill_timeout` 给优雅退出留出时间；`max_memory_restart` 在内存异常增长时重启进程。日志按时间戳写入，配合 `logrotate` 做轮转。

### 容器化

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY dist ./dist
RUN useradd -m agent
USER agent
ENV SUPER_AGENT_MEMORY_DIR=/app/.data/memory
VOLUME ["/app/.data"]
CMD ["node", "dist/cli.js", "--mode", "rpc"]
```

容器化是这套程序唯一可靠的安全边界：文件系统只挂载必要目录，网络按需开放，凭据在启动时注入，进程以非特权账号运行。程序内部的权限判定是防误操作，容器的隔离才是防意外。

## pi 的做法

**配置分层。** pi 的设置在 `~/.pi/agent/settings.json` 与项目 `.pi/settings.json` 两级，涵盖重试、超时、缓存续期模式、思考过程隐藏、缓存失效提示等。`settings-manager.js` 的读取接口按字段分组，例如：

```typescript
getRetrySettings() {
  return {
    enabled: this.getRetryEnabled(),
    maxRetries: this.settings.retry?.maxRetries ?? 3,
    baseDelayMs: this.settings.retry?.baseDelayMs ?? 2000,
    maxAgentDelayMs: this.settings.retry?.maxAgentDelayMs ?? DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
  };
}
```

两处设计值得记录：每一项都有默认值，配置缺项不会导致启动失败；缓存续期这类会产生支出的开关只从使用者级配置读取，项目配置不能开启它。

**四种界面模式。** `docs/how-pi-works.md` 明确说明所有界面共用同一套 agent 与 session 机制：交互模式渲染会话事件，打印模式执行一个提示词并输出最终结果，JSON 模式把事件按行输出，RPC 模式接受标准输入上的命令并把响应与事件写到标准输出。换一种接入方式不需要重写循环或状态管理。

**信任与项目资源。** 启动顺序上有一处必须记住：项目 `sessionDir` 设置会在信任判定之前被读取，因此拒绝信任无法撤销这一次目录查找。上下文文件无论是否授予信任都会被加载，使用者应当把它们当作不可信输入。这两条写在 `docs/security.md` 里，讲义里的实现同样需要注意加载顺序。

**容器化建议。** 文档把三种运行方式并列比较：直接以当前账号运行、完全放进容器或沙箱、只把内置工具放进隔离环境。第二种保护最强，第三种范围较窄，因为主程序与扩展仍在边界之外。

## 验收

1. 分别修改使用者级与项目级配置里的同一个字段，项目级应当胜出；再用命令行参数覆盖，参数应当胜出。
2. 把 `maxTokens` 设成小于 `reserveTokens`，启动时应当打印诊断提示。
3. 用 `--print` 执行一个提示词，标准输出里只有最终结果，没有过程事件。
4. 用进程管理程序启动服务，手动结束进程，管理程序应当重新拉起；连续十次之后停止并给出说明。
5. 给进程发送终止信号，日志里应当出现退出原因与资源释放记录。

## 常见错误

第一个错误是把密钥写进配置文件。配置文件需要放进版本管理，密钥不能。

第二个错误是配置缺项时启动失败。每一项都应当有默认值。

第三个错误是四种模式各写一套循环。行为不一致，修复需要改多处。

第四个错误是退出时不释放资源。锁文件残留，长连接未关闭，会话文件写入未完成。

第五个错误是实例数设成多个。消息被重复处理，定时任务并发执行。

第六个错误是把程序内部的权限判定当作安全边界。真正的边界是容器与账号权限。