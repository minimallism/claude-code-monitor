/**
 * @file Sidebar.tsx
 * @description Defines the Sidebar component that provides navigation links to different sections of the application, and includes a toggle button for collapsing or expanding the sidebar. The component uses React Router's NavLink for navigation and Lucide icons for visual representation. The collapsed state of the sidebar is stored in localStorage to persist user preferences across sessions.

 */

import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  LayoutDashboard,
  FolderOpen,
  Activity,
  BarChart3,
  Workflow,
  Boxes,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
  Languages,
  ChevronUp,
  ChevronDown,
} from "lucide-react";

const NAV_KEYS = [
  { to: "/", icon: LayoutDashboard, key: "nav:dashboard" },
  { to: "/sessions", icon: FolderOpen, key: "nav:sessions" },
  { to: "/analytics", icon: BarChart3, key: "nav:analytics" },
  { to: "/workflows", icon: Workflow, key: "nav:workflows" },
  { to: "/cc-config", icon: Boxes, key: "nav:ccConfig" },
  { to: "/settings", icon: Settings, key: "nav:settings" },
] as const;

const STORAGE_KEY = "sidebar-collapsed";
const SUPPORTED_LANGUAGES = ["en", "zh"] as const;
type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function normalizeLanguage(language: string): SupportedLanguage {
  const base = language.toLowerCase().split("-")[0];
  if (base === "zh" || base === "en") {
    return base;
  }
  return "en";
}

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const { t, i18n } = useTranslation();
  const navRef = useRef<HTMLElement | null>(null);
  const [navOverflow, setNavOverflow] = useState({ up: false, down: false });

  const recomputeNavOverflow = useCallback(() => {
    const el = navRef.current;
    if (!el) return;
    const up = el.scrollTop > 1;
    const down = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    setNavOverflow((prev) => (prev.up === up && prev.down === down ? prev : { up, down }));
  }, []);

  useEffect(() => {
    recomputeNavOverflow();
    const el = navRef.current;
    if (!el) return;
    const onScroll = () => recomputeNavOverflow();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(recomputeNavOverflow) : null;
    ro?.observe(el);
    window.addEventListener("resize", recomputeNavOverflow);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro?.disconnect();
      window.removeEventListener("resize", recomputeNavOverflow);
    };
  }, [recomputeNavOverflow, collapsed]);

  const scrollNavBy = useCallback((delta: number) => {
    navRef.current?.scrollBy({ top: delta, behavior: "smooth" });
  }, []);

  const currentLanguage = normalizeLanguage(i18n.resolvedLanguage ?? i18n.language);
  const currentIndex = SUPPORTED_LANGUAGES.indexOf(currentLanguage);
  const nextLanguage = SUPPORTED_LANGUAGES[(currentIndex + 1) % SUPPORTED_LANGUAGES.length];
  const switchLanguageTitle = t("nav:switchLanguage", {
    language: t(`nav:languageNames.${nextLanguage}`),
  });

  const toggleLang = () => {
    i18n.changeLanguage(nextLanguage);
  };

  const changeLanguage = (language: SupportedLanguage) => {
    if (language !== currentLanguage) {
      i18n.changeLanguage(language);
    }
  };

  return (
    <aside
      className={`fixed left-0 top-0 bottom-0 bg-surface-1 border-r border-border flex flex-col z-30 overflow-hidden transition-[width] duration-200 ${
        collapsed ? "w-[4.25rem]" : "w-60"
      }`}
    >
      {/* Brand */}
      <div className="px-3 py-4 border-b border-border flex-shrink-0">
        <div className={`flex items-center ${collapsed ? "justify-center" : "gap-3 px-2"}`}>
          <div className="w-8 h-8 rounded-lg bg-accent/20 flex items-center justify-center flex-shrink-0">
            <Activity className="w-4 h-4 text-accent" />
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <h1 className="text-sm font-semibold text-gray-100 truncate">{t("nav:brand")}</h1>
              <p className="text-[11px] text-gray-500">{t("nav:brandSub")}</p>
            </div>
          )}
        </div>
      </div>

      {/* Nav - only this section scrolls when its items overflow; the rest of
          the sidebar (brand, language, collapse toggle, footer) stays pinned.
          Chevron buttons appear at the edges when content is clipped, so the
          user knows there's more to reach without inspecting the scrollbar. */}
      <div className="flex-1 min-h-0 relative flex">
        <nav ref={navRef} className="flex-1 overflow-y-auto overflow-x-hidden px-2 py-3 space-y-1">
          {NAV_KEYS.map(({ to, icon: Icon, key }) => {
            const label = t(key);
            return (
              <NavLink
                key={to}
                to={to}
                end={to === "/"}
                title={collapsed ? label : undefined}
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-lg text-sm font-medium transition-colors duration-150 ${
                    collapsed ? "justify-center px-2 py-2.5" : "px-3 py-2.5"
                  } ${
                    isActive
                      ? "bg-accent/10 text-accent border border-accent/20"
                      : "text-gray-400 hover:text-gray-200 hover:bg-surface-3 border border-transparent"
                  }`
                }
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                {!collapsed && <span>{label}</span>}
              </NavLink>
            );
          })}
        </nav>
        {!collapsed && navOverflow.up && (
          <button
            type="button"
            onClick={() => scrollNavBy(-160)}
            aria-label={t("nav:scrollUp")}
            title={t("nav:scrollUp")}
            className="absolute top-1.5 right-[7px] z-10 inline-flex items-center justify-center w-6 h-6 rounded-md border border-border bg-surface-2/90 text-gray-300 hover:text-gray-50 hover:bg-surface-3 shadow-md backdrop-blur-sm transition-colors animate-fade-in"
          >
            <ChevronUp className="w-3.5 h-3.5" aria-hidden />
          </button>
        )}
        {!collapsed && navOverflow.down && (
          <button
            type="button"
            onClick={() => scrollNavBy(160)}
            aria-label={t("nav:scrollDown")}
            title={t("nav:scrollDown")}
            className="absolute bottom-1.5 right-[7px] z-10 inline-flex items-center justify-center w-6 h-6 rounded-md border border-border bg-surface-2/90 text-gray-300 hover:text-gray-50 hover:bg-surface-3 shadow-md backdrop-blur-sm transition-colors animate-fade-in"
          >
            <ChevronDown className="w-3.5 h-3.5" aria-hidden />
          </button>
        )}
      </div>

      {/* Language controls */}
      <div className="px-2 pb-2 flex-shrink-0">
        {collapsed ? (
          <button
            onClick={toggleLang}
            className="w-full h-9 rounded-lg border border-border bg-surface-2 text-gray-300 hover:bg-surface-3 hover:text-gray-100 transition-colors flex flex-col items-center justify-center gap-0.5"
            title={switchLanguageTitle}
            aria-label={switchLanguageTitle}
          >
            <Languages className="w-3.5 h-3.5" />
            <span className="text-[10px] font-semibold leading-none">
              {t(`nav:languageShort.${currentLanguage}`)}
            </span>
          </button>
        ) : (
          <div className="rounded-lg border border-border bg-surface-2 p-2">
            <p className="px-1 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
              {t("nav:language")}
            </p>
            <div className="mt-2 grid grid-cols-2 gap-1">
              {SUPPORTED_LANGUAGES.map((language) => {
                const active = language === currentLanguage;
                return (
                  <button
                    key={language}
                    onClick={() => changeLanguage(language)}
                    aria-pressed={active}
                    aria-label={t(`nav:languageNames.${language}`)}
                    title={t(`nav:languageNames.${language}`)}
                    className={`rounded-md px-2 py-1.5 text-[11px] font-semibold transition-colors ${
                      active
                        ? "bg-accent/20 text-accent border border-accent/30"
                        : "bg-surface-1 text-gray-400 border border-border hover:bg-surface-3 hover:text-gray-200"
                    }`}
                  >
                    {t(`nav:languageShort.${language}`)}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Collapse toggle */}
      <div className="px-2 py-2 flex-shrink-0">
        <button
          onClick={onToggle}
          className={`w-full h-10 rounded-lg border border-border bg-surface-2 transition-colors ${
            collapsed
              ? "flex items-center justify-center text-gray-400 hover:text-gray-200 hover:bg-surface-3"
              : "flex items-center gap-2.5 px-3 text-gray-300 hover:text-gray-100 hover:bg-surface-3"
          }`}
          title={collapsed ? t("nav:expand") : t("nav:collapse")}
          aria-label={collapsed ? t("nav:expand") : t("nav:collapse")}
        >
          {collapsed ? (
            <PanelLeftOpen className="w-4 h-4 flex-shrink-0" />
          ) : (
            <>
              <PanelLeftClose className="w-4 h-4 flex-shrink-0" />
              <span className="text-[11px] font-semibold uppercase tracking-wide">
                {t("nav:collapseShort")}
              </span>
            </>
          )}
        </button>
      </div>

    </aside>
  );
}

export { STORAGE_KEY as SIDEBAR_STORAGE_KEY, loadCollapsed };
