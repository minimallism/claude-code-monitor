#!/usr/bin/env node

const { v4: uuidv4 } = require("uuid");
const { db, stmts } = require("../server/db");

const FIXTURES = {
  solo: {
    sessionId: "demo-solo-0001-0001-0001-000000000001",
    mainAgentId: "demo-solo-0001-main",
  },
  nested: {
    sessionId: "demo-nested-0001-0001-0001-000000000001",
    mainAgentId: "demo-nested-0001-main",
    agents: {
      l1Explorer: "demo-nested-0001-l1-explorer",
      l2Researcher: "demo-nested-0001-l2-researcher",
      l3TestWriter: "demo-nested-0001-l3-testwriter",
      l4Debugger: "demo-nested-0001-l4-debugger",
      l2Reviewer: "demo-nested-0001-l2-reviewer",
      l1Architect: "demo-nested-0001-l1-architect",
      l1DocWriter: "demo-nested-0001-l1-docwriter",
      l2ExampleGen: "demo-nested-0001-l2-examplegen",
    },
  },
};

const FIXTURE_SESSION_IDS = [FIXTURES.solo.sessionId, FIXTURES.nested.sessionId];

const args = new Set(process.argv.slice(2));
const FULL = args.has("--full");
const RESET = args.has("--reset");

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60000).toISOString();
}

const AGENT_NAMES = [
  "Main Agent",
  "Code Explorer",
  "Test Runner",
  "Code Reviewer",
  "Security Auditor",
  "Doc Writer",
  "Debugger",
  "Knowledge Base",
  "TDD Assistant",
  "UI Engineer",
];

const SUBAGENT_TYPES = [
  "Explore",
  "general-purpose",
  "Plan",
  "code-reviewer",
  "tdd-assistant",
  "debugger",
  "security-auditor",
  "doc-writer",
  "knowledge-base",
  "ui-engineer",
];

const TOOL_NAMES = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Grep",
  "Glob",
  "Agent",
  "WebSearch",
  "WebFetch",
];

const TASKS = [
  "Searching for authentication middleware patterns",
  "Running test suite for user service",
  "Reviewing PR #42 for security vulnerabilities",
  "Analyzing database schema for optimization",
  "Exploring component structure in src/components",
  "Writing unit tests for payment processor",
  "Debugging failing integration test",
  "Documenting API endpoints",
  "Scanning for OWASP Top 10 vulnerabilities",
  "Refactoring utility functions",
];

function sessionExists(id) {
  return !!db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(id);
}

function deleteFixtureRows() {
  const placeholders = FIXTURE_SESSION_IDS.map(() => "?").join(",");
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM events WHERE session_id IN (${placeholders})`).run(
      ...FIXTURE_SESSION_IDS
    );
    db.prepare(`DELETE FROM agents WHERE session_id IN (${placeholders})`).run(
      ...FIXTURE_SESSION_IDS
    );
    db.prepare(`DELETE FROM token_usage WHERE session_id IN (${placeholders})`).run(
      ...FIXTURE_SESSION_IDS
    );
    db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...FIXTURE_SESSION_IDS);
  });
  tx();
}

function seedFixtures() {
  const result = { inserted: [], skipped: [] };

  const tx = db.transaction(() => {
    
    if (sessionExists(FIXTURES.solo.sessionId)) {
      result.skipped.push("Single Agent: Quick Hotfix");
    } else {
      stmts.insertSession.run(
        FIXTURES.solo.sessionId,
        "Single Agent: Quick Hotfix",
        "active",
        "/home/dev/hotfix",
        "claude-sonnet-4-6",
        null
      );
      stmts.insertAgent.run(
        FIXTURES.solo.mainAgentId,
        FIXTURES.solo.sessionId,
        "Main Agent",
        "main",
        null,
        "working",
        "Patching null-pointer in checkout handler",
        null,
        null
      );
      db.prepare("UPDATE agents SET current_tool = ? WHERE id = ?").run(
        "Edit",
        FIXTURES.solo.mainAgentId
      );
      result.inserted.push("Single Agent: Quick Hotfix");
    }

    
    if (sessionExists(FIXTURES.nested.sessionId)) {
      result.skipped.push("Deep Nesting: Multi-Agent Research Pipeline");
    } else {
      const ids = FIXTURES.nested.agents;
      stmts.insertSession.run(
        FIXTURES.nested.sessionId,
        "Deep Nesting: Multi-Agent Research Pipeline",
        "active",
        "/home/dev/research-pipeline",
        "claude-opus-4-6",
        null
      );
      stmts.insertAgent.run(
        FIXTURES.nested.mainAgentId,
        FIXTURES.nested.sessionId,
        "Main Agent",
        "main",
        null,
        "waiting",
        "Orchestrating multi-agent research pipeline",
        null,
        null
      );

      
      stmts.insertAgent.run(
        ids.l1Explorer,
        FIXTURES.nested.sessionId,
        "Codebase Explorer",
        "subagent",
        "Explore",
        "working",
        "Mapping authentication module dependencies",
        FIXTURES.nested.mainAgentId,
        null
      );
      db.prepare("UPDATE agents SET current_tool = ? WHERE id = ?").run("Glob", ids.l1Explorer);

      
      stmts.insertAgent.run(
        ids.l2Researcher,
        FIXTURES.nested.sessionId,
        "Security Researcher",
        "subagent",
        "general-purpose",
        "working",
        "Analyzing OAuth2 token validation patterns",
        ids.l1Explorer,
        null
      );
      db.prepare("UPDATE agents SET current_tool = ? WHERE id = ?").run(
        "WebSearch",
        ids.l2Researcher
      );

      
      stmts.insertAgent.run(
        ids.l3TestWriter,
        FIXTURES.nested.sessionId,
        "Test Engineer",
        "subagent",
        "test-engineer",
        "working",
        "Writing integration tests for token refresh flow",
        ids.l2Researcher,
        null
      );
      db.prepare("UPDATE agents SET current_tool = ? WHERE id = ?").run("Write", ids.l3TestWriter);

      
      stmts.insertAgent.run(
        ids.l4Debugger,
        FIXTURES.nested.sessionId,
        "Test Debugger",
        "subagent",
        "debugger",
        "working",
        "Investigating flaky assertion in token expiry test",
        ids.l3TestWriter,
        null
      );
      db.prepare("UPDATE agents SET current_tool = ? WHERE id = ?").run("Bash", ids.l4Debugger);

      
      stmts.insertAgent.run(
        ids.l2Reviewer,
        FIXTURES.nested.sessionId,
        "Code Reviewer",
        "subagent",
        "code-reviewer",
        "completed",
        "Reviewed middleware chain for injection risks",
        ids.l1Explorer,
        null
      );
      db.prepare("UPDATE agents SET ended_at = ? WHERE id = ?").run(minutesAgo(5), ids.l2Reviewer);

      
      stmts.insertAgent.run(
        ids.l1Architect,
        FIXTURES.nested.sessionId,
        "Architecture Planner",
        "subagent",
        "Plan",
        "completed",
        "Designed auth service boundary and API contracts",
        FIXTURES.nested.mainAgentId,
        null
      );
      db.prepare("UPDATE agents SET ended_at = ? WHERE id = ?").run(
        minutesAgo(12),
        ids.l1Architect
      );

      
      stmts.insertAgent.run(
        ids.l1DocWriter,
        FIXTURES.nested.sessionId,
        "Documentation Writer",
        "subagent",
        "doc-writer",
        "working",
        "Writing documentation",
        FIXTURES.nested.mainAgentId,
        null
      );
      db.prepare("UPDATE agents SET current_tool = ? WHERE id = ?").run("Edit", ids.l1DocWriter);

      
      stmts.insertAgent.run(
        ids.l2ExampleGen,
        FIXTURES.nested.sessionId,
        "Example Generator",
        "subagent",
        "general-purpose",
        "working",
        "Generating cURL examples for auth endpoints",
        ids.l1DocWriter,
        null
      );

      result.inserted.push("Deep Nesting: Multi-Agent Research Pipeline (9 agents, depth 4)");
    }

    
    for (const sid of FIXTURE_SESSION_IDS) {
      const hasEvents =
        db.prepare("SELECT 1 FROM events WHERE session_id = ? LIMIT 1").get(sid) !== undefined;
      if (hasEvents) continue;
      const agents = stmts.listAgentsBySession.all(sid);
      const eventCount = Math.floor(Math.random() * 8) + 3;
      for (let i = 0; i < eventCount; i++) {
        const agent = randomItem(agents);
        const eventType = randomItem(["PreToolUse", "PostToolUse", "Notification"]);
        const tool = randomItem(TOOL_NAMES);
        stmts.insertEvent.run(
          sid,
          agent?.id ?? null,
          eventType,
          eventType.includes("Tool") ? tool : null,
          eventType === "PreToolUse"
            ? `Using tool: ${tool}`
            : eventType === "PostToolUse"
              ? `Tool completed: ${tool}`
              : `Agent ${agent?.name || "unknown"} notification`,
          JSON.stringify({ tool_name: tool })
        );
      }
    }
  });

  tx();
  return result;
}

function seedFullDemo() {
  console.log("⚠️  --full mode: inserting random demo sessions on top of existing data.");
  console.log("   These get fresh UUIDs each run, so re-runs accumulate. Use intentionally.\n");

  const tx = db.transaction(() => {
    const sessions = [];

    const activeSessionId = uuidv4();
    stmts.insertSession.run(
      activeSessionId,
      "Feature: User Authentication",
      "active",
      "/home/dev/my-app",
      "claude-opus-4-6",
      null
    );
    sessions.push(activeSessionId);

    const activeSessionId2 = uuidv4();
    stmts.insertSession.run(
      activeSessionId2,
      "Bug Fix: Payment Processing",
      "active",
      "/home/dev/payment-service",
      "claude-sonnet-4-6",
      null
    );
    sessions.push(activeSessionId2);

    for (let i = 0; i < 5; i++) {
      const id = uuidv4();
      stmts.insertSession.run(
        id,
        randomItem([
          "Refactor: Database Layer",
          "Feature: Email Notifications",
          "Fix: Memory Leak in Worker",
          "Test: API Integration Suite",
          "Docs: Documentation Update",
        ]),
        "completed",
        randomItem(["/home/dev/api", "/home/dev/frontend", "/home/dev/worker"]),
        randomItem(["claude-opus-4-6", "claude-sonnet-4-6"]),
        null
      );
      db.prepare("UPDATE sessions SET ended_at = ? WHERE id = ?").run(
        minutesAgo(Math.floor(Math.random() * 120)),
        id
      );
      sessions.push(id);
    }

    const errSessionId = uuidv4();
    stmts.insertSession.run(
      errSessionId,
      "Deploy: Production Release",
      "error",
      "/home/dev/infra",
      "claude-opus-4-6",
      null
    );
    db.prepare("UPDATE sessions SET ended_at = ? WHERE id = ?").run(minutesAgo(45), errSessionId);
    sessions.push(errSessionId);

    const mainAgent1 = `${activeSessionId}-main`;
    stmts.insertAgent.run(
      mainAgent1,
      activeSessionId,
      "Main Agent",
      "main",
      null,
      "working",
      "Implementing JWT authentication middleware",
      null,
      null
    );
    db.prepare("UPDATE agents SET current_tool = ? WHERE id = ?").run("Edit", mainAgent1);

    for (let i = 0; i < 3; i++) {
      const subId = uuidv4();
      const status = randomItem(["working", "working", "working"]);
      stmts.insertAgent.run(
        subId,
        activeSessionId,
        AGENT_NAMES[i + 1],
        "subagent",
        SUBAGENT_TYPES[i + 1],
        status,
        TASKS[i],
        mainAgent1,
        null
      );
      if (status === "working") {
        db.prepare("UPDATE agents SET current_tool = ? WHERE id = ?").run(
          randomItem(TOOL_NAMES),
          subId
        );
      }
    }

    const mainAgent2 = `${activeSessionId2}-main`;
    stmts.insertAgent.run(
      mainAgent2,
      activeSessionId2,
      "Main Agent",
      "main",
      null,
      "working",
      "Investigating payment webhook failures",
      null,
      null
    );

    const sub2 = uuidv4();
    stmts.insertAgent.run(
      sub2,
      activeSessionId2,
      "Debugger",
      "subagent",
      "debugger",
      "working",
      "Tracing webhook request flow",
      mainAgent2,
      null
    );
    db.prepare("UPDATE agents SET current_tool = ? WHERE id = ?").run("Grep", sub2);

    for (const sid of sessions.slice(2)) {
      const mainId = `${sid}-main`;
      stmts.insertAgent.run(mainId, sid, "Main Agent", "main", null, "completed", null, null, null);
      db.prepare("UPDATE agents SET ended_at = ? WHERE id = ?").run(
        minutesAgo(Math.floor(Math.random() * 60)),
        mainId
      );
      const subCount = Math.floor(Math.random() * 3) + 1;
      for (let i = 0; i < subCount; i++) {
        const subId = uuidv4();
        const name = randomItem(AGENT_NAMES.slice(1));
        stmts.insertAgent.run(
          subId,
          sid,
          name,
          "subagent",
          randomItem(SUBAGENT_TYPES.slice(1)),
          sid === sessions[sessions.length - 1] ? "error" : "completed",
          randomItem(TASKS),
          mainId,
          null
        );
        db.prepare("UPDATE agents SET ended_at = ? WHERE id = ?").run(
          minutesAgo(Math.floor(Math.random() * 60)),
          subId
        );
      }
    }

    for (const sid of sessions) {
      const eventCount = Math.floor(Math.random() * 15) + 5;
      const agents = stmts.listAgentsBySession.all(sid);
      for (let i = 0; i < eventCount; i++) {
        const agent = randomItem(agents);
        const eventType = randomItem([
          "PreToolUse",
          "PostToolUse",
          "PreToolUse",
          "PostToolUse",
          "Notification",
        ]);
        const tool = randomItem(TOOL_NAMES);
        const summary =
          eventType === "PreToolUse"
            ? `Using tool: ${tool}`
            : eventType === "PostToolUse"
              ? `Tool completed: ${tool}`
              : `Agent ${agent?.name || "unknown"} notification`;
        stmts.insertEvent.run(
          sid,
          agent?.id ?? null,
          eventType,
          eventType.includes("Tool") ? tool : null,
          summary,
          JSON.stringify({ tool_name: tool })
        );
      }
      const session = stmts.getSession.get(sid);
      if (session && session.status !== "active") {
        stmts.insertEvent.run(
          sid,
          null,
          "Stop",
          null,
          `Session ended: ${session.status}`,
          JSON.stringify({ stop_reason: session.status })
        );
      }
    }
  });

  tx();
}

function main() {
  console.log("Seeding database (additive — existing data is preserved)...\n");

  if (RESET) {
    console.log("--reset: removing existing fixture rows before re-inserting.");
    deleteFixtureRows();
  }

  const fixtureResult = seedFixtures();

  if (fixtureResult.inserted.length > 0) {
    console.log("Inserted fixtures:");
    for (const name of fixtureResult.inserted) console.log(`  + ${name}`);
  }
  if (fixtureResult.skipped.length > 0) {
    console.log("Skipped (already present — pass --reset to recreate):");
    for (const name of fixtureResult.skipped) console.log(`  · ${name}`);
  }

  if (FULL) {
    console.log("");
    seedFullDemo();
  }

  const stats = stmts.stats.get();
  console.log("");
  console.log(
    `Total in DB: ${stats.total_sessions} sessions, ${stats.total_agents} agents, ${stats.total_events} events.`
  );
  console.log("");
  console.log("Test URLs:");
  console.log(`  Single-agent:   /sessions/${FIXTURES.solo.sessionId}`);
  console.log(`  Nested (depth 4): /sessions/${FIXTURES.nested.sessionId}`);
}

main();
