/**
 * 应用根组件。
 *
 * 职责：
 * 1. 建立 SSE 长连接，并把收到的服务器消息通过 eventBus 分发给订阅者。
 * 2. 配置 React Router 路由与 Layout 布局。
 * 3. 根据当前路由动态更新页面标题（i18n）。
 */

import { BrowserRouter, Routes, Route, useLocation } from "react-router-dom";
import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Layout } from "./components/Layout";
import { SplashScreen } from "./components/SplashScreen";
import { Home } from "./pages/Home";
import { Sessions } from "./pages/Sessions";
import { SessionDetail } from "./pages/SessionDetail";
import { Analytics } from "./pages/Analytics";
import { Data } from "./pages/Data";
import { Settings } from "./pages/Settings";
import { NotFound } from "./pages/NotFound";
import { useSSE } from "./hooks/useSSE";
import { eventBus } from "./lib/eventBus";
import type { WSMessage } from "./lib/types";

const TITLE_KEYS: Record<string, string> = {
  "/": "nav:dashboard",
  "/sessions": "nav:sessions",
  "/analytics": "nav:analytics",
  "/settings": "nav:settings",
  "/data": "nav:data",
};

/**
 * 根据当前路由匹配对应的 i18n 标题 key，并设置 document.title。
 */
function TitleUpdater() {
  const { t } = useTranslation("nav");
  const location = useLocation();
  useEffect(() => {
    const key = Object.entries(TITLE_KEYS).find(([path]) =>
      location.pathname === path || location.pathname.startsWith(path + "/")
    )?.[1];
    document.title = key ? t(key) : t("dashboard");
  }, [location, t]);
  return null;
}

export default function App() {
  const onMessage = useCallback((message: WSMessage) => {
    eventBus.publish(message);
  }, []);

  useSSE(onMessage);
  return (
    <>
      <SplashScreen />
      <BrowserRouter>
        <TitleUpdater />
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Home />} />
            <Route path="sessions" element={<Sessions />} />
            <Route path="sessions/:id" element={<SessionDetail />} />
            <Route path="analytics" element={<Analytics />} />
            <Route path="data" element={<Data />} />
            <Route path="settings" element={<Settings />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </>
  );
}
