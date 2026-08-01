import i18n from "../i18n";

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

export function fmt(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

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

export function formatModelName(model: string | null | undefined): string | null {
  if (!model) return null;

  
  let name = model.includes("/") ? model.split("/").pop()! : model;

  
  let ctxSuffix = "";
  const ctxMatch = name.match(/\[(\d+[mk])\]$/i);
  if (ctxMatch) {
    ctxSuffix = ` (${(ctxMatch[1] as string).toUpperCase()})`;
    name = name.slice(0, -ctxMatch[0].length);
  }

  
  name = name.replace(/-\d{8}$/, "").replace(/-latest$/i, "");

  const parts: string[] = name.split("-");
  const firstPart = parts[0] ?? name;
  const brand = MODEL_BRANDS[firstPart.toLowerCase()];

  
  
  if (brand === "GPT" && parts.length >= 2) {
    const versionToken = parts[1] as string;
    const remainingParts = parts.slice(2);
    const suffix = remainingParts
      .map((segment) => (/^\d+$/.test(segment) ? segment : segment.charAt(0).toUpperCase() + segment.slice(1)))
      .join(" ");
    const formattedBase = suffix ? `${brand}-${versionToken} ${suffix}` : `${brand}-${versionToken}`;
    return formattedBase + ctxSuffix;
  }

  
  const result: string[] = [brand ?? firstPart.charAt(0).toUpperCase() + firstPart.slice(1)];

  let partIndex = 1;
  while (partIndex < parts.length) {
    const segment = parts[partIndex] as string;
    if (/^\d+$/.test(segment)) {
      const versionParts = [segment];
      while (partIndex + 1 < parts.length && /^\d+$/.test(parts[partIndex + 1] as string)) {
        partIndex++;
        versionParts.push(parts[partIndex] as string);
      }
      result.push(versionParts.join("."));
    } else if (/^\d+\w+$/.test(segment)) {
      result.push(segment);
    } else {
      result.push(segment.charAt(0).toUpperCase() + segment.slice(1));
    }
    partIndex++;
  }

  return result.join(" ") + ctxSuffix;
}

export function pathBasename(path: string | null | undefined): string | null {
  if (!path) return null;
  const trimmed = path.replace(/\/+$/, "");
  const lastSlashIndex = trimmed.lastIndexOf("/");
  return lastSlashIndex === -1 ? trimmed : trimmed.slice(lastSlashIndex + 1) || trimmed;
}
