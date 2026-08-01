/**
 * Agent API 路由。
 *
 * 提供 agent 列表查询，支持按 session_id 过滤或按 status 分页。
 * Agent 是会话中的执行单元：每个 session 有一个 main agent，
 * 子 agent（subagent）由 Agent 工具或用户委派创建。
 */

const { Router } = require("express");
const { stmts } = require("../db");

const router = Router();

/**
 * GET /api/agents
 *
 * 查询参数：
 * - session_id: 返回某个会话下的全部 agent。
 * - status: 按状态过滤（working/waiting/completed/error），配合 limit/offset 分页。
 * - limit / offset: 分页参数，默认 limit=10000。
 */
router.get("/", (req, res) => {
  const rawLimit = parseInt(req.query.limit);
  const limit = rawLimit > 0 ? rawLimit : 10000;
  const offset = parseInt(req.query.offset) || 0;
  const status = req.query.status;
  const session_id = req.query.session_id;

  let rows;
  if (session_id) {
    rows = stmts.listAgentsBySession.all(session_id);
  } else if (status) {
    rows = stmts.listAgentsByStatus.all(status, limit, offset);
  } else {
    rows = stmts.listAgents.all(limit, offset);
  }

  res.json({ agents: rows, limit, offset });
});

module.exports = router;
