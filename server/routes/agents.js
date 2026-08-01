const { Router } = require("express");
const { stmts } = require("../db");

const router = Router();

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
