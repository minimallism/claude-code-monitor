# Claude Code Monitor

Claude Code agent 活动实时监控面板。通过 Web UI 追踪会话、Agent、Token 用量和分析数据。

## 功能特性

- **实时仪表盘** — SSE 实时推送活跃会话和 Agent 状态
- **会话管理** — 浏览、筛选、查看详情和 Agent 层级
- **Token 用量分析** — 追踪每个会话、Agent 及时间范围的 Token 消耗
- **项目级聚合** — 按项目目录分组查看活动
- **进程监控** — 查看运行中的 Claude Code 进程及资源占用
- **自动 Hook 集成** — 自动安装 Claude Code 钩子，实时捕获事件
- **文件系统同步** — 监听 `~/.claude/projects/` 自动同步新会话
- **零数据库配置** — SQLite，支持 `better-sqlite3` 或 Node 22+ 内置 `node:sqlite`

## 快速开始

```bash
npx claude-code-monitor          # 启动
npx claude-code-monitor --open   # 启动并自动打开浏览器
```

打开 [http://localhost:4820](http://localhost:4820)。

## CLI 选项

所有选项均支持环境变量（`DASHBOARD_` 前缀，如 `DASHBOARD_PORT`），也可在项目根目录 `.env` 文件中配置。

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `-p, --port` | 服务端口 | `4820` |
| `--host` | 绑定地址 | `127.0.0.1` |
| `-d, --data-dir` | 数据目录 | `~/.claude-code-monitor` |
| `--db-path` | SQLite 路径 | `<data-dir>/dashboard.db` |
| `-t, --token` | API Token（设置后需认证） | 无认证 |
| `-o, --open` | 自动打开浏览器 | — |
| `DASHBOARD_SESSION_SYNC_MS` | 文件同步轮询间隔（ms） | `30000` |
| `DASHBOARD_SESSION_MAX_AGE_HOURS` | 会话最大保留时间（h） | `72` |

## 开发

```bash
git clone <repo-url> && cd claude-code-monitor
npm run setup      # 安装所有依赖
npm run dev        # 同时启动服务端和 Vite 开发服务器
```

### 常用命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 开发模式（Express 后端 + Vite HMR） |
| `npm run build` | 构建前端生产版本 |
| `npm run start` | 生产模式启动 |
| `npm run install-hooks` | 安装 Claude Code 钩子 |
| `npm run import-history` | 导入 `~/.claude/` 历史会话 |
| `npm run clear-data` | 清除所有监控数据 |

## 项目架构

```
claude-code-monitor/
├── bin/                          # CLI 入口
├── server/
│   ├── index.js                  # Express 应用与优雅关闭
│   ├── db.js                     # SQLite 数据库
│   ├── sse.js                    # SSE 实时推送
│   ├── lib/                      # 安全、Token 聚合、转录缓存等
│   └── routes/                   # 会话/Agent/统计/Hook 等路由
├── client/
│   └── src/                      # React + Vite + Tailwind CSS + i18n
└── scripts/                      # Hook 安装、历史导入、数据清理等
```

## 运行要求

- **Node.js 18+**（推荐 22+）
- 现代浏览器

## 许可证

MIT
