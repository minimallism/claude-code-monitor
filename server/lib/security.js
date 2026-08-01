const crypto = require("node:crypto");

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", ""]);

function resolveHost() {
  const host = (process.env.DASHBOARD_HOST || "").trim();
  return host || "127.0.0.1";
}

function isLoopbackHostname(name) {
  return LOOPBACK_HOSTS.has(String(name || "").toLowerCase());
}

function allowedHostnames() {
  return (process.env.DASHBOARD_ALLOWED_HOSTS || "")
    .split(",")
    .map((hostname) => hostname.trim().toLowerCase())
    .filter(Boolean);
}

function hostnameOf(hostHeader) {
  const host = String(hostHeader || "");
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end >= 0 ? host.slice(0, end + 1).toLowerCase() : host.toLowerCase();
  }
  return host.split(":")[0].toLowerCase();
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
        const originUrl = new URL(origin);
        if (
          isLoopbackHostname(originUrl.hostname) ||
          allowedHostnames().includes(originUrl.hostname.toLowerCase())
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
  const token = process.env.DASHBOARD_TOKEN;
  return typeof token === "string" && token.length > 0 ? token : null;
}

function tokensMatch(provided, expected) {
  if (typeof provided !== "string" || provided.length === 0) return false;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
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
  if (TOKEN_EXEMPT_PREFIXES.some((prefix) => req.path === prefix || req.path.startsWith(prefix + "/"))) {
    return next();
  }
  if (tokensMatch(extractToken(req), expected)) return next();
  return res
    .status(401)
    .json({ error: { code: "EUNAUTHORIZED", message: "missing or invalid dashboard token" } });
}

module.exports = {
  resolveHost,
  isLoopbackHostname,
  hostGuard,
  corsOptions,
  getDashboardToken,
  tokenGuard,
};
