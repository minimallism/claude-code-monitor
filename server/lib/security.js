const crypto = require("node:crypto");

/**
 * 安全中间件集合。
 *
 * 包含：
 * - Host 头白名单检查（hostGuard）。
 * - CORS 来源限制（corsOptions）。
 * - DASHBOARD_TOKEN 鉴权（tokenGuard）。
 *
 * 当服务绑定到非回环地址时，这些防护尤为重要，可避免未授权访问。
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", ""]);

/**
 * 解析 DASHBOARD_HOST 环境变量，默认绑定 127.0.0.1。
 */
function resolveHost() {
  const host = (process.env.DASHBOARD_HOST || "").trim();
  return host || "127.0.0.1";
}

/**
 * 判断主机名是否为本地回环地址。
 */
function isLoopbackHostname(name) {
  return LOOPBACK_HOSTS.has(String(name || "").toLowerCase());
}

/**
 * 读取 DASHBOARD_ALLOWED_HOSTS 环境变量并解析为允许的主机名数组。
 */
function allowedHostnames() {
  return (process.env.DASHBOARD_ALLOWED_HOSTS || "")
    .split(",")
    .map((hostname) => hostname.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * 从 Host 头中提取主机名（去掉端口和 IPv6 括号）。
 */
function hostnameOf(hostHeader) {
  const host = String(hostHeader || "");
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end >= 0 ? host.slice(0, end + 1).toLowerCase() : host.toLowerCase();
  }
  return host.split(":")[0].toLowerCase();
}

/**
 * 判断请求的 Host 头是否在白名单内。
 */
function isHostAllowed(hostHeader) {
  const name = hostnameOf(hostHeader);
  return isLoopbackHostname(name) || allowedHostnames().includes(name);
}

/**
 * Express 中间件：拒绝非预期 Host 头的请求。
 */
function hostGuard(req, res, next) {
  if (isHostAllowed(req.headers.host)) return next();
  return res.status(403).json({ error: { code: "EBADHOST", message: "host not allowed" } });
}

/**
 * 生成 CORS 配置。
 *
 * 只允许来自回环地址或 DASHBOARD_ALLOWED_HOSTS 指定的来源，不携带凭证。
 */
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
        // URL 解析失败视为不允许。
      }
      return cb(null, false);
    },
    credentials: false,
  };
}

/**
 * 读取 DASHBOARD_TOKEN 环境变量；未设置或为空时返回 null。
 */
function getDashboardToken() {
  const token = process.env.DASHBOARD_TOKEN;
  return typeof token === "string" && token.length > 0 ? token : null;
}

/**
 * 使用 timingSafeEqual 比较 token，防止时序攻击。
 */
function tokensMatch(provided, expected) {
  if (typeof provided !== "string" || provided.length === 0) return false;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

/**
 * 从 Authorization 头、X-Dashboard-Token 头或 query 参数中提取 token。
 */
function extractToken(req) {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);
  const header = req.headers["x-dashboard-token"];
  if (typeof header === "string" && header) return header;
  if (req.query && typeof req.query.token === "string") return req.query.token;
  return null;
}

const TOKEN_EXEMPT_PREFIXES = ["/health", "/hooks"];

/**
 * Express 中间件：为 /api 路由校验 DASHBOARD_TOKEN。
 *
 * 未设置 token 时直接放行；/health 和 /hooks 路径豁免；
 * 其他路径需要提取的 token 与配置的 token 完全一致。
 */
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
