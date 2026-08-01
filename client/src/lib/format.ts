import i18n from "../i18n";

/**
 * 把后端返回的时间字符串解析为 Date。
 *
 * 兼容三种格式：
 * - 带 Z 或时区偏移的 ISO 字符串（直接传给 new Date）。
 * - SQLite 常见的 "YYYY-MM-DD HH:MM:SS" 空格分隔格式（替换成 T 并加 Z 再解析）。
 */
function parseDate(iso: string): Date {
  if (/[Zz]$/.test(iso) || /[+-]\d{2}:\d{2}$/.test(iso)) {
    return new Date(iso);
  }

  return new Date(iso.replace(" ", "T") + "Z");
}

type SupportedLanguage = "en" | "zh";

function getCurrentLanguage(): SupportedLanguage {
  const language = (i18n.resolvedLanguage ?? i18n.language ?? "en").toLowerCase().split("-")[0];
  if (language === "zh" || language === "en") {
    return language;
  }
  return "en";
}

function getCurrentLocale(): string {
  const language = getCurrentLanguage();
  if (language === "zh") return "zh-CN";
  return "en-US";
}

export function formatDateTime(iso: string): string {
  const date = parseDate(iso);
  return date.toLocaleString(getCurrentLocale(), {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * 计算两个时间点之间的时长，格式化为 "Xh Ym" / "Ym Zs" / "Zs"。
 * 如果 end 早于 start（异常数据），返回 0s 避免负数。
 */
export function formatDuration(start: string, end: string): string {
  const durationMs = parseDate(end).getTime() - parseDate(start).getTime();
  if (durationMs < 0) return "0s";
  const totalSec = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * 返回相对时间，如 "刚刚"、"5 分钟前"、"3 小时前"、"2 天前"。
 */
export function timeAgo(iso: string): string {
  const elapsedMs = Date.now() - parseDate(iso).getTime();
  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 60) return i18n.t("common:time.justNow");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return i18n.t("common:time.mAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return i18n.t("common:time.hAgo", { count: hours });
  const days = Math.floor(hours / 24);
  return i18n.t("common:time.dAgo", { count: days });
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1) + "\u2026";
}

/**
 * 把大数字格式化为 K/M/B 缩写（例如 1500 -> 1.5K）。
 * 非有限数值返回 "0"。
 */
export function fmt(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

/**
 * 把字节数格式化为人类可读大小（B/KB/MB/GB/TB）。
 */
export function fmtSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const formattedValue = bytes / Math.pow(1024, unitIndex);
  return `${formattedValue < 10 ? formattedValue.toFixed(1) : Math.round(formattedValue)} ${units[unitIndex]}`;
}

const MODEL_BRANDS: Record<string, string> = {
  claude: "Claude",
  gpt: "GPT",
  gemini: "Gemini",
};

/**
 * 把原始模型字符串格式化为易读的显示名称。
 *
 * 处理逻辑：
 * 1. 去掉供应商前缀（如 "anthropic/claude-3-opus" -> "claude-3-opus"）。
 * 2. 提取并暂存上下文长度后缀（如 "[200k]" -> " (200K)"）。
 * 3. 去掉日期戳和 "-latest" 后缀。
 * 4. 按 "-" 分段，识别品牌名（claude/gpt/gemini）。
 * 5. 对纯数字段做版本号合并（如 "3-5" -> "3.5"），其他段首字母大写。
 */
export function formatModelName(model: string | null | undefined): string | null {
  if (!model) return null;

  // 去掉 "provider/model" 中的 provider 前缀。
  let name = model.includes("/") ? model.split("/").pop()! : model;

  // 提取上下文窗口后缀，例如 "claude-3-opus[200k]" -> 后缀 " (200K)"。
  let ctxSuffix = "";
  const ctxMatch = name.match(/\[(\d+[mk])\]$/i);
  if (ctxMatch) {
    ctxSuffix = ` (${(ctxMatch[1] as string).toUpperCase()})`;
    name = name.slice(0, -ctxMatch[0].length);
  }

  // 去掉快照日期戳和 latest 标记。
  name = name.replace(/-\d{8}$/, "").replace(/-latest$/i, "");

  const parts: string[] = name.split("-");
  const firstPart = parts[0] ?? name;
  const brand = MODEL_BRANDS[firstPart.toLowerCase()];

  // GPT 系列格式特殊处理：保留 "GPT-4o" 这种连字符形式。
  if (brand === "GPT" && parts.length >= 2) {
    const versionToken = parts[1] as string;
    const remainingParts = parts.slice(2);
    const suffix = remainingParts
      .map((segment) => (/^\d+$/.test(segment) ? segment : segment.charAt(0).toUpperCase() + segment.slice(1)))
      .join(" ");
    const formattedBase = suffix ? `${brand}-${versionToken} ${suffix}` : `${brand}-${versionToken}`;
    return formattedBase + ctxSuffix;
  }

  // 通用处理：品牌名或首段首字母大写，后续段按版本号/单词规则格式化。
  const result: string[] = [brand ?? firstPart.charAt(0).toUpperCase() + firstPart.slice(1)];

  let partIndex = 1;
  while (partIndex < parts.length) {
    const segment = parts[partIndex] as string;
    if (/^\d+$/.test(segment)) {
      // 连续纯数字段合并成版本号，例如 "3-5" -> "3.5"。
      const versionParts = [segment];
      while (partIndex + 1 < parts.length && /^\d+$/.test(parts[partIndex + 1] as string)) {
        partIndex++;
        versionParts.push(parts[partIndex] as string);
      }
      result.push(versionParts.join("."));
    } else if (/^\d+\w+$/.test(segment)) {
      // 形如 "4o" 的版本标记直接保留。
      result.push(segment);
    } else {
      result.push(segment.charAt(0).toUpperCase() + segment.slice(1));
    }
    partIndex++;
  }

  return result.join(" ") + ctxSuffix;
}

/**
 * 简单的路径 basename 提取（仅处理 POSIX 风格 / 分隔符）。
 * 如果路径以 / 结尾，先去掉尾部斜杠；再取最后一段。
 */
export function pathBasename(path: string | null | undefined): string | null {
  if (!path) return null;
  const trimmed = path.replace(/\/+$/, "");
  const lastSlashIndex = trimmed.lastIndexOf("/");
  return lastSlashIndex === -1 ? trimmed : trimmed.slice(lastSlashIndex + 1) || trimmed;
}
