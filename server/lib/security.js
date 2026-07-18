const crypto = require("node:crypto");

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", ""]);

function resolveHost() {
  const h = (process.env.DASHBOARD_HOST || "").trim();
  return h || "127.0.0.1";
}

function isLoopbackHostname(name) {
  return LOOPBACK_HOSTS.has(String(name || "").toLowerCase());
}

function allowedHostnames() {
  return (process.env.DASHBOARD_ALLOWED_HOSTS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function hostnameOf(hostHeader) {
  const h = String(hostHeader || "");
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end >= 0 ? h.slice(0, end + 1).toLowerCase() : h.toLowerCase();
  }
  return h.split(":")[0].toLowerCase();
}

function isHostAllowed(hostHeader) {
  const name = hostnameOf(hostHeader);
  return isLoopbackHostname(name) || allowedHostnames().includes(name);
}

function hostGuard(req, res, next) {
  if (isHostAllowed(req.headers.host)) return next();
  return res.status(403).json({ error: { code: "EBADHOST", message: "host not allowed" } });
}

function corsOptions() {
  return {
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      try {
        const u = new URL(origin);
        if (
          isLoopbackHostname(u.hostname) ||
          allowedHostnames().includes(u.hostname.toLowerCase())
        ) {
          return cb(null, true);
        }
      } catch {
        
      }
      return cb(null, false);
    },
    credentials: false,
  };
}

function getDashboardToken() {
  const t = process.env.DASHBOARD_TOKEN;
  return typeof t === "string" && t.length > 0 ? t : null;
}

function tokensMatch(provided, expected) {
  if (typeof provided !== "string" || provided.length === 0) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function extractToken(req) {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);
  const header = req.headers["x-dashboard-token"];
  if (typeof header === "string" && header) return header;
  if (req.query && typeof req.query.token === "string") return req.query.token;
  return null;
}

const TOKEN_EXEMPT_PREFIXES = ["/health", "/hooks"];

function tokenGuard(req, res, next) {
  const expected = getDashboardToken();
  if (!expected) return next();
  if (TOKEN_EXEMPT_PREFIXES.some((p) => req.path === p || req.path.startsWith(p + "/"))) {
    return next();
  }
  if (tokensMatch(extractToken(req), expected)) return next();
  return res
    .status(401)
    .json({ error: { code: "EUNAUTHORIZED", message: "missing or invalid dashboard token" } });
}

function isWebSocketAuthorized(req) {
  const expected = getDashboardToken();
  if (!expected) return true;
  try {
    const u = new URL(req.url, "http://localhost");
    if (tokensMatch(u.searchParams.get("token"), expected)) return true;
  } catch {
    
  }
  const header = req.headers["x-dashboard-token"];
  if (typeof header === "string" && tokensMatch(header, expected)) return true;
  return false;
}

module.exports = {
  LOOPBACK_HOSTS,
  resolveHost,
  isLoopbackHostname,
  allowedHostnames,
  hostnameOf,
  isHostAllowed,
  hostGuard,
  corsOptions,
  getDashboardToken,
  tokenGuard,
  isWebSocketAuthorized,
  
  tokensMatch,
  extractToken,
};
