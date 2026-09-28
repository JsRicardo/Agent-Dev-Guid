# super-agent 实战讲义

这份讲义从零做一个可以长期运行的 Agent 程序，目标项目名为 `super-agent`，使用 TypeScript 与 Node.js。每一讲都给出可运行的代码，并把 pi 的真实实现作为对照：pi 在同一个问题上做了什么选择，与讲义里的最小实现差在哪里。

模型调用使用 Vercel AI SDK 的形态（`streamText`、`tool`、`inputSchema`、`stopWhen`）。不同版本之间字段名会有变化，以你安装的版本为准。pi 的模型层是自己写的 `pi-ai`，这一点在第 1 讲里会对照说明。

## 目标项目的目录

```
super-agent/
├── src/
│   ├── agent/
│   │   ├── loop.ts              第 2 讲  循环
│   │   ├── fuses.ts             第 3 讲  循环检测与预算
│   │   └── retry.ts             第 3 讲  API 容错
│   ├── tools/
│   │   ├── registry.ts          第 4 讲  注册与执行管线
│   │   ├── truncate.ts          第 4 讲  结果截断
│   │   ├── builtin/             第 5 讲  read / edit / grep / glob / bash
│   │   ├── search/              第 7 讲  联网检索
│   │   ├── mcp.ts               第 8 讲  MCP 接入
│   │   └── tool-search.ts       第 9 讲  动态工具集
│   ├── context/
│   │   ├── session.ts           第 10 讲 会话持久化
│   │   ├── prompt-pipe.ts       第 10 讲 提示词组装
│   │   ├── compact.ts           第 11 讲 压缩
│   │   ├── defense.ts           第 12 讲 即时防线
│   │   └── cache.ts             第 13 讲 缓存与成本
│   ├── memory/
│   │   ├── store.ts             第 14 讲 记忆存储
│   │   ├── retrieve.ts          第 15 讲 混合检索
│   │   └── maintain.ts          第 16 讲 记忆维护
│   ├── skills.ts                第 17 讲 Skills
│   ├── plugins/                 第 18 讲 Plugin 架构
│   ├── channels/feishu.ts       第 19 讲 Channel
│   ├── policy/
│   │   ├── permissions.ts       第 20 讲 权限系统
│   │   └── hooks.ts             第 20 讲 Hook 管线
│   ├── cron/scheduler.ts        第 21 讲 定时任务
│   ├── subagent/                第 22 讲 子智能体
│   ├── trace/                   第 24 讲 本地 Trace
│   ├── config.ts                第 23 讲 配置
│   └── cli.ts                   第 23 讲 入口
├── package.json
└── tsconfig.json
```

## 每一讲的结构

| 小节 | 内容 |
|------|------|
| 本讲目标 | 这一讲结束时能跑起来的东西 |
| 要写的代码 | 目标项目里的路径与可运行代码 |
| pi 的做法 | pi 在同一个问题上的实现，标注文件与关键代码 |
| 验收 | 怎么确认做对了，包含一个具体的操作与一个具体的结果 |
| 常见错误 | 这一类实现最常出现的偏差 |

## 对照用的 pi 源码位置

```
@earendil-works/pi-coding-agent
~/.pi/agent/npm/node_modules/pi-feishu-lark     飞书 Channel 扩展
~/.pi/agent/npm/node_modules/pi-memory          记忆系统扩展
~/.pi/agent/npm/node_modules/pi-web-access      联网检索扩展
~/.pi/agent/npm/node_modules/pi-subagents       子智能体与工作流
```

## 目录

### 第一章 起步 + Agent Loop

| 文件 | 标题 |
|------|------|
| `ch1-boot/01-hello-agent.md` | 10 分钟，让你的 AI 开口说话 |
| `ch1-boot/02-agent-loop.md` | 从能聊天到能干活：给 Agent 装上 while 循环 |
| `ch1-boot/03-fuses.md` | 循环检测、API 容错与 Token 预算 |

### 第二章 Tool System

| 文件 | 标题 |
|------|------|
| `ch2-tools/04-tool-system.md` | Tool 注册、执行、截断与并发 |
| `ch2-tools/05-builtin-tools.md` | edit_file、grep、glob 与 bash |
| `ch2-tools/06-mini-apps.md` | 把工具组装成应用：代码分析、Research Agent、Vibe Coding |
| `ch2-tools/07-search-tool.md` | Agent 的 Search 工具如何实现 |
| `ch2-tools/08-mcp.md` | MCP 接入实战：给 Agent 接上 GitHub |
| `ch2-tools/09-tool-search.md` | 实现 ToolSearch |

### 第三章 Context Engineering

| 文件 | 标题 |
|------|------|
| `ch3-context/10-session-prompt.md` | Session 持久化与模块化提示词组装 |
| `ch3-context/11-compaction.md` | Microcompact 与 LLM 摘要压缩 |
| `ch3-context/12-context-defense.md` | 三层即时防线 |
| `ch3-context/13-cache-cost.md` | Prompt Cache 与成本追踪 |

### 第四章 Memory + RAG

| 文件 | 标题 |
|------|------|
| `ch4-memory/14-memory.md` | 持久化记忆系统 |
| `ch4-memory/15-rag.md` | 混合检索实战 |
| `ch4-memory/16-memory-maintenance.md` | 给记忆库做体检 |

### 第五章 Skills + Plugins + Channel

| 文件 | 标题 |
|------|------|
| `ch5-extensions/17-skills.md` | Skills：给 Agent 注入领域知识 |
| `ch5-extensions/18-plugins.md` | Plugin 架构 |
| `ch5-extensions/19-channel.md` | Channel 抽象：让 Agent 活在飞书群里 |

### 第六章 权限 + Cron + Multi-Agent

| 文件 | 标题 |
|------|------|
| `ch6-runtime/20-permissions-hooks.md` | 权限系统与 Hook 管线 |
| `ch6-runtime/21-cron.md` | Cron 定时任务系统 |
| `ch6-runtime/22-sub-agent.md` | 实现 Sub-Agent 机制 |

### 第七章 部署

| 文件 | 标题 |
|------|------|
| `ch7-deploy/23-deploy.md` | 配置系统、CLI 入口与部署上线 |
| `ch7-deploy/24-trace.md` | 把每一步留下来：本地 Trace 与执行复盘 |

## 使用方式

按顺序做，每一讲结束时把「验收」那一步跑一遍再进入下一讲。第 4 讲之后每一讲都会改动工具层或上下文层，前面的验收步骤需要重跑一次，否则问题会累积到后面才暴露。

需要先理解设计取舍时，对照 `../agent-fundamentals-notes/`：那份讲义按六大支柱展开，讲的是每个位置为什么这样选，代码细节留给这份实战讲义。