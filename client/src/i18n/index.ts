/**
 * @file index.ts
 * @description Initializes the i18n internationalization framework for the agent dashboard application, setting up language resources for English and Chinese locales. It configures language detection, fallback options, and namespaces for organized translation keys. This module allows the application to support multiple languages and provides a seamless experience for users across different regions.

 */

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import common_en from "./locales/en/common.json";
import common_zh from "./locales/zh/common.json";
import nav_en from "./locales/en/nav.json";
import nav_zh from "./locales/zh/nav.json";
import dashboard_en from "./locales/en/dashboard.json";
import dashboard_zh from "./locales/zh/dashboard.json";
import sessions_en from "./locales/en/sessions.json";
import sessions_zh from "./locales/zh/sessions.json";
import activity_en from "./locales/en/activity.json";
import activity_zh from "./locales/zh/activity.json";
import analytics_en from "./locales/en/analytics.json";
import analytics_zh from "./locales/zh/analytics.json";
import workflows_en from "./locales/en/workflows.json";
import workflows_zh from "./locales/zh/workflows.json";
import settings_en from "./locales/en/settings.json";
import settings_zh from "./locales/zh/settings.json";
import errors_en from "./locales/en/errors.json";
import errors_zh from "./locales/zh/errors.json";
import ccConfig_en from "./locales/en/ccConfig.json";
import ccConfig_zh from "./locales/zh/ccConfig.json";
import alerts_en from "./locales/en/alerts.json";
import alerts_zh from "./locales/zh/alerts.json";
import splash_en from "./locales/en/splash.json";
import splash_zh from "./locales/zh/splash.json";

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: {
        common: common_en,
        nav: nav_en,
        dashboard: dashboard_en,
        sessions: sessions_en,
        activity: activity_en,
        analytics: analytics_en,
        workflows: workflows_en,
        settings: settings_en,
        errors: errors_en,
        ccConfig: ccConfig_en,
        alerts: alerts_en,
        splash: splash_en,
      },
      zh: {
        common: common_zh,
        nav: nav_zh,
        dashboard: dashboard_zh,
        sessions: sessions_zh,
        activity: activity_zh,
        analytics: analytics_zh,
        workflows: workflows_zh,
        settings: settings_zh,
        errors: errors_zh,
        ccConfig: ccConfig_zh,
        alerts: alerts_zh,
        splash: splash_zh,
      },
    },
    supportedLngs: ["en", "zh"],
    nonExplicitSupportedLngs: true,
    fallbackLng: "en",
    ns: [
      "common",
      "nav",
      "dashboard",
      "sessions",
      "activity",
      "analytics",
      "workflows",
      "settings",
      "errors",
      "ccConfig",
      "alerts",
      "splash",
    ],
    defaultNS: "common",
    interpolation: { escapeValue: false },
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
      lookupLocalStorage: "i18nextLng",
    },
  });

export default i18n;
