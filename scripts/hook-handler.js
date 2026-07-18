#!/usr/bin/env node

const http = require("http");

const hookType = process.argv[2] || "unknown";

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

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  let parsedData;
  try {
    parsedData = JSON.parse(input);
  } catch {
    parsedData = { raw: input };
  }

  const payload = JSON.stringify({
    hook_type: hookType,
    data: parsedData,
  });
  const contentLength = Buffer.byteLength(payload);

  
  
  
  
  
  const sends = ports.map(
    (port) =>
      new Promise((resolve) => {
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
            timeout: 2000,
          },
          
          
          (res) => res.resume()
        );

        req.on("error", done); 
        req.on("timeout", () => {
          req.destroy();
          done();
        });
        req.write(payload);
        
        
        req.end(done);
      })
  );

  
  
  Promise.all(sends).finally(() => setImmediate(() => process.exit(0)));
});

setTimeout(() => process.exit(0), 2500);
