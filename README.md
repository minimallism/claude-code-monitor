# Claude Code Monitor

Claude Code agent 活动实时监控面板。通过 Web UI 追踪会话、Agent、Token 用量和分析数据。

## 功能特性

- **实时仪表盘** — 通过 SSE 实时展示活跃的 Claude Code 会话和 Agent
- **会话管理** — 浏览、筛选、查看会话详情、对话记录和 Agent 层级
- **Token 用量分析** — 追踪每个会话、Agent 及时间范围内的 Token 消耗
- **项目级聚合** — 按项目目录分组查看活动
- **进程监控** — 查看正在运行的 Claude Code 进程及资源占用
- **自动 Hook 集成** — 自动安装 Claude Code 钩子，实时捕获事件
- **文件系统同步** — 监听 `~/.claude/projects/` 目录，自动同步新会话文件
- **多语言 UI** — 支持英文和中文
- **零数据库配置** — 使用 SQLite；支持 `better-sqlite3` 或 Node 22+ 内置 `node:sqlite`
- **安全特性** — 可选 API Token 认证、Host 头校验、CORS 限制

## 快速开始

```bash
# 直接使用 npx 运行（无需安装）
npx claude-code-monitor

# 自动打开浏览器
npx claude-code-monitor --open

# 自定义端口
npx claude-code-monitor --port 8080 --open
```

在浏览器中打开 [http://localhost:4820](http://localhost:4820)。

## 安装方式

### 全局安装

```bash
npm install -g @minimallism/claude-code-monitor

# 运行
claude-code-monitor --open
```

### 项目内安装

```bash
npm install @minimallism/claude-code-monitor

# 构建前端（生产环境必需）
npm run build

# 启动
npx claude-code-monitor
```

## CLI 选项

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `-p, --port <number>` | 服务端口（环境变量：`DASHBOARD_PORT`） | `4820` |
| `-d, --data-dir <path>` | 数据目录（环境变量：`DASHBOARD_DATA_DIR`） | `~/.claude-code-monitor` |
| `--db-path <path>` | SQLite 数据库路径（环境变量：`DASHBOARD_DB_PATH`） | `<data-dir>/dashboard.db` |
| `-t, --token <string>` | API Token（环境变量：`DASHBOARD_TOKEN`） | _（无认证）_ |
| `--host <host>` | 绑定地址（环境变量：`DASHBOARD_HOST`） | `127.0.0.1` |
| `-o, --open` | 启动后自动打开浏览器 | — |
| `-h, --help` | 显示帮助信息 | — |

## 配置说明

支持通过环境变量、CLI 参数或项目根目录下的 `.env` 文件进行配置。

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `DASHBOARD_PORT` | 服务端口 | `4820` |
| `DASHBOARD_HOST` | 绑定地址 | `127.0.0.1` |
| `DASHBOARD_DATA_DIR` | 数据目录 | `~/.claude-code-monitor` |
| `DASHBOARD_DB_PATH` | SQLite 数据库路径 | `<data-dir>/dashboard.db` |
| `DASHBOARD_TOKEN` | API Token（设置后需认证才能访问） | _（不设置）_ |
| `DASHBOARD_ALLOWED_HOSTS` | 允许的 Host 头（逗号分隔） | _（仅回环地址）_ |
| `DASHBOARD_SESSION_SYNC_MS` | 文件同步轮询间隔（毫秒） | `30000` |
| `DASHBOARD_SESSION_MAX_AGE_HOURS` | 会话最大保留时间（小时） | `72` |

### `.env` 文件示例

```env
DASHBOARD_PORT=4820
DASHBOARD_HOST=127.0.0.1
DASHBOARD_TOKEN=your-secret-token
```

## 安全

默认情况下，服务只绑定 `127.0.0.1`（仅本地访问）。如果需要暴露到网络：

- **设置 `DASHBOARD_TOKEN`** — 所有 API 请求（hooks 和 health 除外）需要通过 `Authorization: Bearer <token>`、`X-Dashboard-Token` 头或 `?token=` 查询参数提供 Token
- **设置 `DASHBOARD_ALLOWED_HOSTS`** — 限制允许的 Host 头和 CORS 来源
- **Token 比较使用 `crypto.timingSafeEqual`** — 防止时序攻击

## 开发

```bash
# 克隆并安装依赖
git clone <repo-url>
cd claude-code-monitor
npm run setup

# 同时启动服务端和客户端（开发模式）
npm run dev

# 或分别运行各组件
npm run dev:server   # Express 后端（端口 4820）
npm run dev:client   # Vite 开发服务器（端口 5173）
```

`dev` 模式下使用 Vite 开发服务器提供前端 HMR，API 请求代理到 Express 后端。

## 命令

| 命令 | 说明 |
|------|------|
| `npm run setup` | 安装所有依赖（根目录 + client） |
| `npm run dev` | 同时启动服务端和 Vite 开发服务器 |
| `npm run dev:server` | 以 `--watch` 模式启动服务端 |
| `npm run dev:client` | 启动 Vite 开发服务器 |
| `npm run build` | 构建前端生产版本 |
| `npm run start` | 以生产模式启动服务端 |
| `npm run install-hooks` | （重新）安装 Claude Code 钩子 |
| `npm run import-history` | 从 `~/.claude/` 导入历史会话 |
| `npm run reconcile-tokens` | 修复 Token 用量数据 |
| `npm run clear-data` | 清除所有监控数据 |

## 项目架构

```
claude-code-monitor/
├── bin/
│   └── claude-code-monitor.js   # CLI 入口
├── server/
│   ├── index.js                 # Express 应用、启动、优雅关闭
│   ├── db.js                    # SQLite 数据库设置与查询
│   ├── sse.js                   # Server-Sent Events 实时推送
│   ├── compat-sqlite.js         # node:sqlite 兼容层
│   ├── lib/
│   │   ├── claude-home.js       # Claude Code 目录解析
│   │   ├── security.js          # 认证、CORS、Host 校验
│   │   ├── server-info.js       # 实例发现（端口文件）
│   │   ├── token-usage.js       # Token 用量聚合
│   │   ├── transcript-cache.js  # 会话记录缓存
│   │   └── session-liveness.js  # 会话健康检查
│   └── routes/
│       ├── sessions.js          # 会话 CRUD 与查询
│       ├── agents.js            # Agent 层级与详情
│       ├── stats.js             # 聚合统计
│       ├── analytics.js         # Token 用量分析
│       ├── hooks.js             # Claude Code 事件钩子
│       ├── settings.js          # 用户设置
│       ├── projects.js          # 项目级视图
│       └── processes.js         # 进程监控
├── client/
│   ├── src/                    # React + Vite + Tailwind CSS
│   │   ├── components/
│   │   ├── hooks/
│   │   ├── lib/
│   │   └── i18n/               # 英文和中文翻译
│   └── dist/                   # 前端构建产物
└── scripts/
    ├── install-hooks.js        # 钩子安装器
    ├── hook-handler.js         # 钩子事件处理器
    ├── import-history.js       # 历史会话导入
    ├── dev.js                  # 开发模式启动器
    └── clear-data.js           # 数据清理
```

## 运行要求

- **Node.js 18+**（推荐 22+，可使用内置 `node:sqlite`）
- 现代浏览器

## 许可证

MIT
