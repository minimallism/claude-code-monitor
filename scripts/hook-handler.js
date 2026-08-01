#!/usr/bin/env node

/**
 * Claude Code hook 转发脚本。
 *
 * 该脚本由 Claude Code 的 user hooks 调用（通过 /terminal/hooks 脚本触发）。
 * 调用方式示例：
 *   node scripts/hook-handler.js <hook_type> < hook_payload.json
 *
 * 职责：
 * 1. 从命令行参数读取 hook 类型（如 PreToolUse、PostToolUse、Stop 等）。
 * 2. 从 stdin 读取 Claude Code 发送的 JSON payload。
 * 3. 把 payload 转发到本地 dashboard 服务端的所有可能端口。
 * 4. 无论成功失败，都在合理时间内退出，避免阻塞 Claude Code。
 *
 * 为什么需要转发到所有端口：
 * 用户可能同时运行多个 dashboard 实例（例如不同数据目录或开发/生产共存），
 * server-info 模块会记录这些实例的端口；脚本向所有端口广播，确保事件不丢失。
 */

const http = require("http");

// 命令行第一个参数为 hook 类型；如果没有（手动测试时），则标记为 unknown。
const hookType = process.argv[2] || "unknown";

/**
 * 解析需要转发到的所有 dashboard 端口。
 *
 * 优先级：
 * 1. server/lib/server-info 模块中记录的活跃 dashboard 端口（最准确，支持多实例）。
 * 2. 环境变量 CLAUDE_DASHBOARD_PORT。
 * 3. 默认端口 4820。
 *
 * 使用 try/catch 包裹 require，因为生产 npm 包中 server-info 一定存在，
 * 但在独立测试或异常安装场景下需要兜底。
 */
function resolvePorts() {
  try {
    return require("../server/lib/server-info").resolveAllDashboardPorts();
  } catch {
    const envPort = parseInt(process.env.CLAUDE_DASHBOARD_PORT || "", 10);
    return [Number.isInteger(envPort) && envPort > 0 ? envPort : 4820];
  }
}

const ports = resolvePorts();

let input = "";

// Claude Code 通过 stdin 一次性写入 JSON，这里按 utf8 累积数据块。
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));

process.stdin.on("end", () => {
  // 尝试把 stdin 内容解析为 JSON；如果解析失败（例如用户手动输入了非 JSON），
  // 则包装为 { raw: input }，保证后续仍然有一个合法的 data 字段上报。
  let parsedData;
  try {
    parsedData = JSON.parse(input);
  } catch {
    parsedData = { raw: input };
  }

  // 构造上报给 dashboard 的最终 JSON body。
  const payload = JSON.stringify({
    hook_type: hookType,
    data: parsedData,
  });
  const contentLength = Buffer.byteLength(payload);

  // 向每个端口并发发送 POST 请求；每个请求包装为一个 Promise，
  // 但这里只关心“请求已发出”，不关心响应内容（fire-and-forget）。
  const sends = ports.map(
    (port) =>
      new Promise((resolve) => {
        // settled 用于防止 error、timeout、end 多次触发导致 Promise 多次 resolve。
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };

        const req = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/api/hooks/event",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": contentLength,
            },
            // 超时 2 秒：hook 调用不能阻塞 Claude Code 太久。
            timeout: 2000,
          },
          // 收到响应后只需排空（resume）数据流即可；不解析响应体。
          (res) => res.resume()
        );

        req.on("error", done);
        req.on("timeout", () => {
          req.destroy();
          done();
        });
        req.write(payload);
        // req.end 的回调在请求完成时触发；与 error/timeout 共用 done 保证只 resolve 一次。
        req.end(done);
      })
  );

  // 所有请求（包括失败的）都 settled 后，在下一个事件循环退出进程。
  Promise.all(sends).finally(() => setImmediate(() => process.exit(0)));
});

// 兜底定时器：如果 stdin 没有正常结束或请求一直挂起，2.5 秒后强制退出，
// 避免 hook 进程长时间存活导致 Claude Code 等待。
setTimeout(() => process.exit(0), 2500);
