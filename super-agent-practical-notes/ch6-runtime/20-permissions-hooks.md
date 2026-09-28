# 20 · 权限系统与 Hook 管线

> 章节：第六章 权限 + Cron + Multi-Agent

## 本讲目标

让这套 Agent 可以被别人使用而不出事。这一讲结束时，危险操作按规则被允许、询问或拒绝；拒绝时把理由交回模型；每一次判定都有记录。

## 要写的代码

```
src/policy/
├── rules.ts          规则与匹配
├── path-guard.ts     路径规范化与检查
├── command-guard.ts  命令解析与检查
├── approval.ts       人工审批
├── audit.ts          审计记录
├── hooks.ts          Hook 管线
└── permissions.ts    四层判定
```

### 规则

```typescript
export type Decision = "allow" | "ask" | "deny";

export type Rule = {
  match: string;
  args?: Record<string, string>;
  decision: Decision;
  reason?: string;
};

export type Policy = { rules: Rule[]; defaultDecision: Decision };

/** 匹配对象形如 bash、edit、mcp:github/create_issue */
export function decide(policy: Policy, toolName: string, args: Record<string, unknown>): { decision: Decision; reason: string } {
  for (const rule of policy.rules) {
    if (!matchesTool(rule.match, toolName)) continue;
    if (!matchesArgs(rule.args, args)) continue;
    return { decision: rule.decision, reason: rule.reason ?? `匹配规则 ${rule.match}` };
  }
  return { decision: policy.defaultDecision, reason: "没有匹配的规则" };
}

function matchesTool(pattern: string, toolName: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === toolName;
  const regex = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`);
  return regex.test(toolName);
}

function matchesArgs(expect: Record<string, string> | undefined, args: Record<string, unknown>): boolean {
  if (!expect) return true;
  return Object.entries(expect).every(([key, pattern]) => {
    const value = args[key];
    if (typeof value !== "string") return false;
    return new RegExp(pattern).test(value);
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
```

规则支持参数级匹配。只按工具名称匹配会让「读取这个目录」与「写入这个目录」无法区分。

### 路径检查

```typescript
import { realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

export async function checkPath(raw: string, workspaceRoot: string): Promise<{ allowed: boolean; reason?: string }> {
  const root = await resolveExisting(workspaceRoot);
  const candidate = resolve(root, raw);
  const resolvedTarget = await resolveExisting(candidate);

  if (resolvedTarget !== root && !resolvedTarget.startsWith(root + sep)) {
    return { allowed: false, reason: `路径超出工作目录范围：${resolvedTarget}` };
  }
  return { allowed: true };
}

/** 路径不存在时解析其父目录，避免因为没有文件而跳过规范化。 */
async function resolveExisting(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    const parent = resolve(target, "..");
    if (parent === target) return target;
    try {
      const resolvedParent = await stat(parent).then(() => realpath(parent));
      return `${resolvedParent}${sep}${target.slice(parent.length + 1)}`;
    } catch {
      return target;
    }
  }
}
```

顺序是先解析再判断。字符串前缀比较是不够的：`/workspace-other` 以 `/workspace` 为前缀。符号链接必须解析到实际位置，否则链接指向目录外部时检查会全部通过。

### 命令检查

```typescript
const CHAIN_SYMBOLS = /(?:^|[^\\])(?:;|&&|\|\||`|\$\(|>|>>|<)/;
const DANGEROUS = [/\brm\s+(-rf?|--recursive)/i, /\bsudo\b/i, /\b(chmod|chown)\b.*777/i, /\bgit\s+push\s+--force/i, /\bdd\s+if=/i];

export function checkCommand(command: string): { allowed: boolean; reason?: string } {
  if (DANGEROUS.some((pattern) => pattern.test(command))) {
    return { allowed: false, reason: `命令命中高危模式：${command.slice(0, 80)}` };
  }
  if (CHAIN_SYMBOLS.test(command)) {
    return { allowed: false, reason: "命令包含串联执行或重定向，需要人工确认" };
  }
  return { allowed: true };
}
```

字符串包含检查不能作为判定方式。完整的做法是把命令解析成词元再判断，讲义里先用规则加人工确认的组合，效果已经足够。

### 人工审批

```typescript
export type ApprovalRequest = {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  detail: string;
  timeoutMs?: number;
};

export type ApprovalResult = { approved: boolean; scope: "once" | "session" | "always"; by: string };

export class ApprovalGate {
  private sessionGrants = new Set<string>();
  private pending = new Map<string, { resolve: (result: ApprovalResult) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private readonly request: (input: ApprovalRequest) => Promise<void>,
    private readonly timeoutMs = 10 * 60 * 1000,
  ) {}

  async ask(input: ApprovalRequest, requester: string): Promise<ApprovalResult> {
    const key = grantKey(input.toolName, input.args);
    if (this.sessionGrants.has(key)) {
      return { approved: true, scope: "session", by: requester };
    }

    await this.request(input);
    return new Promise<ApprovalResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(input.callId);
        // 超时默认拒绝
        resolve({ approved: false, scope: "once", by: "timeout" });
      }, input.timeoutMs ?? this.timeoutMs);
      this.pending.set(input.callId, { resolve, timer });
    });
  }

  settle(callId: string, result: ApprovalResult): void {
    const entry = this.pending.get(callId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(callId);
    if (result.approved && result.scope === "session") {
      this.sessionGrants.add(callId);
    }
    entry.resolve(result);
  }
}

function grantKey(toolName: string, args: Record<string, unknown>): string {
  return `${toolName}:${JSON.stringify(args)}`;
}
```

三处约定：审批超时默认拒绝；授权范围分单次、本次会话、永久三种；会话级授权在工作目录切换之后需要失效，否则权限会带到另一个项目。

### 审计记录

```typescript
export async function audit(entry: {
  at: string;
  toolName: string;
  args: Record<string, unknown>;
  decision: Decision;
  reason: string;
  actor?: string;
}): Promise<void> {
  await appendFile(
    join(process.cwd(), ".super-agent", "audit.jsonl"),
    `${JSON.stringify(entry)}\n`,
    "utf-8",
  );
}
```

每一次危险操作、每一次审批、每一次拒绝都记录操作内容与判定依据。这些记录是排查问题的唯一依据。

### 四层判定

```typescript
export async function authorize(input: {
  toolName: string;
  args: Record<string, unknown>;
  policy: Policy;
  workspaceRoot: string;
  approvals: ApprovalGate;
  actor?: string;
}): Promise<{ decision: Decision; reason: string }> {
  const argPaths = collectPaths(input.args);
  for (const path of argPaths) {
    const check = await checkPath(path, input.workspaceRoot);
    if (!check.allowed) {
      await audit({ at: new Date().toISOString(), toolName: input.toolName, args: input.args, decision: "deny", reason: check.reason!, actor: input.actor });
      return { decision: "deny", reason: check.reason! };
    }
  }

  if (typeof input.args.command === "string") {
    const check = checkCommand(input.args.command);
    if (!check.allowed) {
      const approved = await input.approvals.ask(
        { callId: randomUUID(), toolName: input.toolName, args: input.args, detail: check.reason! },
        input.actor ?? "unknown",
      );
      const decision: Decision = approved.approved ? "allow" : "deny";
      await audit({ at: new Date().toISOString(), toolName: input.toolName, args: input.args, decision, reason: check.reason!, actor: approved.by });
      return { decision, reason: check.reason! };
    }
  }

  const ruled = decide(input.policy, input.toolName, input.args);
  if (ruled.decision === "ask") {
    const approved = await input.approvals.ask(
      { callId: randomUUID(), toolName: input.toolName, args: input.args, detail: ruled.reason },
      input.actor ?? "unknown",
    );
    const decision: Decision = approved.approved ? "allow" : "deny";
    await audit({ at: new Date().toISOString(), toolName: input.toolName, args: input.args, decision, reason: ruled.reason, actor: approved.by });
    return { decision, reason: ruled.reason };
  }

  await audit({ at: new Date().toISOString(), toolName: input.toolName, args: input.args, decision: ruled.decision, reason: ruled.reason, actor: input.actor });
  return { decision: ruled.decision, reason: ruled.reason };
}

function collectPaths(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string") continue;
    if (!/path|file|dir|cwd/i.test(key)) continue;
    paths.push(value);
  }
  return paths;
}
```

拒绝时把理由交回模型。模型看不到理由时会尝试其他路径绕过限制，返回理由能让它理解边界并改变做法。

### Hook 管线

`src/policy/hooks.ts`：

```typescript
export type HookPhase = "before_run" | "before_request" | "before_tool" | "after_tool" | "before_compaction" | "session_start" | "session_shutdown";

export type Hook = {
  name: string;
  phase: HookPhase;
  order?: number;
  run: (input: HookInput, ctx: { cwd: string; signal?: AbortSignal }) => Promise<HookOutput | undefined>;
};

export function sortHooks(hooks: Hook[]): Hook[] {
  return [...hooks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** 结果合并规则按阶段决定：阻止类取首个，改写类依次串联。 */
export function mergeResults(phase: HookPhase, results: HookOutput[]): HookOutput | undefined {
  if (phase === "before_tool") {
    const blocked = results.find((result) => result.block);
    if (blocked) return blocked;
  }
  return results.reduce<HookOutput | undefined>((merged, result) => ({ ...(merged ?? {}), ...result }), undefined);
}
```

阶段划分对应流程里的固定位置：`before_run` 在任务开始之前，`before_request` 在每次请求之前，`before_tool` 与 `after_tool` 围绕工具执行，`before_compaction` 在压缩之前，会话开始与结束各有一次。

## pi 的做法

**权限立场。** `docs/security.md` 的表述很直接：pi 会以启动它的账号权限读取、修改、执行文件，不会在每次工具调用之前请求批准；安全性来自限制 pi 能访问的文件、凭证、进程与网络服务。它同时说明项目信任只控制启动时加载哪些可执行资源，不构成安全边界：

```
Project trust does not limit what tool calls can access or affect.
```

讲义里的四层判定比 pi 核心提供的能力多，原因在第 13 讲已经出现过一次：pi 把「需要确认」这类策略留给扩展与运行环境，核心只提供挂载点。

**挂载点。** pi 的 `tool_call` 事件处理器可以返回 `block` 阻止执行，示例扩展 `permission-gate.ts` 的写法与讲义对应：

```typescript
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName !== "bash") return undefined;
  const command = event.input.command as string;
  if (dangerousPatterns.some((p) => p.test(command))) {
    if (!ctx.hasUI) {
      return { block: true, reason: "Dangerous command blocked (no UI for confirmation)" };
    }
    const choice = await ctx.ui.select(`危险命令：${command}，是否允许？`, ["Yes", "No"]);
    if (choice !== "Yes") return { block: true, reason: "Blocked by user" };
  }
  return undefined;
});
```

两处细节值得记录：没有界面时默认阻止；拒绝理由写在 `reason` 字段里，模型能看到。

**路径与外部工具的规范。** `resolveToCwd`、`path-utils.js` 负责把相对路径统一成绝对路径；写入类工具用 `withFileMutationQueue` 以 `realpath` 作为队列键，符号链接指向同一文件时进入同一个队列。讲义里的 `resolveExisting` 处理的是同一类问题：路径不存在时仍然需要规范化。

**项目信任的决策顺序。** `trust-manager.js` 的优先级是命令行参数、扩展处理信任事件、已保存决策、全局默认设置。决策保存在使用者目录下，键是规范化之后的绝对路径，读写带文件锁，查找时从当前目录向上取最近的一条。这一处设计可以直接借用：信任决策按目录继承，子目录可以覆盖父目录。

**子智能体侧的收窄。** `pi-subagents` 用 `tools` frontmatter 做严格白名单，用能力上限限制子智能体可用的扩展与工具，外部命令行代理的文档明确要求不要交出完整访问权限或审批绕过。

## 验收

1. 在配置里拒绝 `edit` 对工作目录以外路径的操作，让模型尝试修改外部文件，应当被阻止并把理由交回模型。
2. 执行一条包含串联符号的命令，应当进入审批流程；不处理审批请求，超时之后应当默认拒绝。
3. 审批一次并选择「本次会话有效」，同样的调用再次出现时不再询问；切换工作目录之后应当重新询问。
4. 打开审计文件，每一次判定都有一行记录，包含操作内容、判定结果与依据。

## 常见错误

第一个错误是把提示词当作权限控制。提示词可以被模型忽略，也可以被工具返回内容影响。

第二个错误是用字符串包含判断路径。前缀相同的另一个目录会被放行。

第三个错误是不解析符号链接。链接指向目录外部时检查全部通过。

第四个错误是审批超时默认允许。程序在无人在场时自动执行了危险操作。

第五个错误是会话级授权跨工作目录沿用。权限被带到另一个项目。

第六个错误是拒绝时不返回理由。模型持续重试被拒绝的操作，浪费轮数。