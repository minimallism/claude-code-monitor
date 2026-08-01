import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

const SESSION_KEY = "splash-shown-v1";
const HOLD_MS = 2600;
const EXIT_MS = 650;

function greetingKey(hour: number): "morning" | "afternoon" | "evening" | "night" {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "night";
}

export function SplashScreen() {
  const { t } = useTranslation("splash");

  const [mounted, setMounted] = useState(() => {
    try {
      return !sessionStorage.getItem(SESSION_KEY);
    } catch {
      return true;
    }
  });
  const [exiting, setExiting] = useState(false);
  const exitTimer = useRef<number | null>(null);
  const doneTimer = useRef<number | null>(null);

  const [copy] = useState(() => {
    const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]!;
    const taglines = t("taglines", { returnObjects: true }) as unknown as string[];
    const subs = t("subs", { returnObjects: true }) as unknown as string[][];
    const tagline = Array.isArray(taglines) && taglines.length > 0 ? pick(taglines) : t("tagline");
    const pair = Array.isArray(subs) && subs.length > 0 ? pick(subs) : [t("sub1"), t("sub2")];
    return {
      tagline,
      sub1: pair?.[0] ?? t("sub1"),
      sub2: pair?.[1] ?? t("sub2"),
    };
  });

  const beginExit = () => {
    if (exiting) return;
    setExiting(true);
    doneTimer.current = window.setTimeout(() => setMounted(false), EXIT_MS);
  };

  useEffect(() => {
    if (!mounted) return;
    try {
      sessionStorage.setItem(SESSION_KEY, "1");
    } catch {
      // ignore
    }
    exitTimer.current = window.setTimeout(beginExit, HOLD_MS);
    return () => {
      if (exitTimer.current) window.clearTimeout(exitTimer.current);
      if (doneTimer.current) window.clearTimeout(doneTimer.current);
    };
  }, [mounted]);

  if (!mounted) return null;

  const hour = new Date().getHours();
  const greeting = t(`greeting.${greetingKey(hour)}`);

  return (
    <div
      role="dialog"
      aria-label={`${greeting}. ${copy.tagline}`}
      onClick={beginExit}
      className={`splash-root ${exiting ? "splash-exit" : ""}`}
    >
      <style>{SPLASH_CSS}</style>

      <div className="splash-bg" aria-hidden="true" />
      <div className="splash-grid" aria-hidden="true" />
      <div className="splash-glow" aria-hidden="true" />

      <div className="splash-content">
        <div className="splash-mark" aria-hidden="true">
          <span className="splash-ring splash-ring-1" />
          <span className="splash-ring splash-ring-2" />
          <span className="splash-ring splash-ring-3" />
          <span className="splash-core" />
        </div>

        <div className="splash-greeting">
          <span className="splash-pill">{greeting}</span>
        </div>

        <h1 className="splash-tagline">{copy.tagline}</h1>

        <p className="splash-sub splash-sub-1">{copy.sub1}</p>
        <p className="splash-sub splash-sub-2">{copy.sub2}</p>

        <div className="splash-brand">{t("brand")}</div>
      </div>
    </div>
  );
}

const SPLASH_CSS = `
.splash-root {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: #0a0a0f;
  cursor: pointer;
}
.splash-root.splash-exit {
  animation: splashExit ${EXIT_MS}ms cubic-bezier(0.4, 0, 0.2, 1) forwards;
  pointer-events: none;
}

.splash-bg {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(80% 60% at 50% 30%, rgba(34, 211, 238, 0.12) 0%, transparent 55%),
    radial-gradient(60% 50% at 80% 90%, rgba(52, 211, 153, 0.06) 0%, transparent 45%),
    radial-gradient(50% 40% at 20% 80%, rgba(34, 211, 238, 0.05) 0%, transparent 40%),
    linear-gradient(180deg, #0c0c12 0%, #0a0a0f 50%, #08080d 100%);
}

.splash-grid {
  position: absolute;
  inset: -50%;
  width: 200%;
  height: 200%;
  opacity: 0.35;
  background-image:
    linear-gradient(rgba(34, 211, 238, 0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(34, 211, 238, 0.04) 1px, transparent 1px);
  background-size: 48px 48px;
  transform: perspective(600px) rotateX(60deg) translateY(-10%) scale(1.4);
  transform-origin: 50% 0%;
  animation: splashGridMove 28s linear infinite;
  mask-image: radial-gradient(closest-side, black 0%, transparent 75%);
  -webkit-mask-image: radial-gradient(closest-side, black 0%, transparent 75%);
}

.splash-glow {
  position: absolute;
  inset: 0;
  background: radial-gradient(circle at 50% 55%, rgba(34, 211, 238, 0.08) 0%, transparent 50%);
  animation: splashGlowBreathe 5s ease-in-out infinite;
}

.splash-content {
  position: relative;
  z-index: 1;
  text-align: center;
  padding: 0 1.5rem;
  max-width: 44rem;
}

.splash-mark {
  position: relative;
  width: 88px;
  height: 88px;
  margin: 0 auto 2.5rem;
  opacity: 0;
  animation: splashMarkIn 0.85s cubic-bezier(0.22, 1, 0.36, 1) 0.1s forwards;
}
.splash-ring {
  position: absolute;
  inset: 0;
  border-radius: 9999px;
  border: 1.5px solid rgba(34, 211, 238, 0.35);
}
.splash-ring-1 {
  animation: splashRingPulse 2.8s ease-out infinite;
}
.splash-ring-2 {
  animation: splashRingPulse 2.8s ease-out 0.7s infinite;
}
.splash-ring-3 {
  animation: splashRingPulse 2.8s ease-out 1.4s infinite;
}
.splash-core {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 14px;
  height: 14px;
  margin: -7px 0 0 -7px;
  border-radius: 9999px;
  background: #22d3ee;
  box-shadow: 0 0 18px 4px rgba(34, 211, 238, 0.55), 0 0 36px 10px rgba(34, 211, 238, 0.25);
  animation: splashCorePulse 2.2s ease-in-out infinite;
}

.splash-greeting {
  margin-bottom: 1.4rem;
  opacity: 0;
  animation: splashRise 0.7s cubic-bezier(0.16, 1, 0.3, 1) 0.45s forwards;
}
.splash-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.35rem 0.9rem;
  border-radius: 9999px;
  border: 1px solid rgba(34, 211, 238, 0.25);
  background: rgba(34, 211, 238, 0.08);
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: #67e8f9;
}
.splash-pill::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  background: #34d399;
  box-shadow: 0 0 8px 1px rgba(52, 211, 153, 0.8);
  animation: splashStatusBlink 2s ease-in-out infinite;
}

.splash-tagline {
  font-size: clamp(1.8rem, 5vw, 3.4rem);
  line-height: 1.1;
  font-weight: 700;
  letter-spacing: -0.03em;
  color: #f1f5f9;
  margin: 0 0 1.25rem;
  text-wrap: balance;
  opacity: 0;
  animation: splashRise 0.85s cubic-bezier(0.16, 1, 0.3, 1) 0.6s forwards;
}
.splash-tagline::selection {
  background: rgba(34, 211, 238, 0.25);
}

.splash-sub {
  font-size: clamp(0.88rem, 1.7vw, 1.05rem);
  line-height: 1.65;
  color: #94a3b8;
  margin: 0 auto;
  max-width: 34rem;
  opacity: 0;
  animation: splashRise 0.7s cubic-bezier(0.16, 1, 0.3, 1) forwards;
}
.splash-sub-1 { animation-delay: 0.82s; }
.splash-sub-2 { animation-delay: 0.96s; color: #64748b; margin-top: 0.3rem; }

.splash-brand {
  margin-top: 2.75rem;
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.36em;
  text-transform: uppercase;
  color: #475569;
  opacity: 0;
  animation: splashRise 0.7s ease 1.15s forwards;
}

@keyframes splashExit {
  from { opacity: 1; transform: scale(1); filter: blur(0); }
  to { opacity: 0; transform: scale(1.05); filter: blur(5px); }
}
@keyframes splashGridMove {
  from { transform: perspective(600px) rotateX(60deg) translateY(0) scale(1.4); }
  to { transform: perspective(600px) rotateX(60deg) translateY(48px) scale(1.4); }
}
@keyframes splashGlowBreathe {
  0%, 100% { opacity: 0.7; }
  50% { opacity: 1; }
}
@keyframes splashMarkIn {
  from { opacity: 0; transform: translateY(16px) scale(0.85); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes splashRingPulse {
  0% { transform: scale(0.7); opacity: 0.55; }
  70% { opacity: 0; }
  100% { transform: scale(1.35); opacity: 0; }
}
@keyframes splashCorePulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.15); opacity: 0.85; }
}
@keyframes splashStatusBlink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
@keyframes splashRise {
  from { opacity: 0; transform: translateY(18px); }
  to { opacity: 1; transform: translateY(0); }
}

@media (prefers-reduced-motion: reduce) {
  .splash-root,
  .splash-root.splash-exit,
  .splash-grid,
  .splash-glow,
  .splash-mark,
  .splash-ring,
  .splash-core,
  .splash-pill,
  .splash-pill::before,
  .splash-greeting,
  .splash-tagline,
  .splash-sub,
  .splash-brand {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    opacity: 1 !important;
    transform: none !important;
    filter: none !important;
  }
}
`;
