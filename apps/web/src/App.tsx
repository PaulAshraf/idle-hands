import { Suspense, lazy, useEffect } from "react";
import { Link, NavLink, Route, Routes, useLocation } from "react-router";
import { useThemePref, type ThemePref } from "./lib/hooks.ts";
import { Skeleton } from "./components/common.tsx";
import { HomePage } from "./pages/Home.tsx";
import { AgentsPage } from "./pages/Agents.tsx";
import { AgentPage } from "./pages/Agent.tsx";
import { JoinPage } from "./pages/Join.tsx";
import { NotFoundPage } from "./pages/NotFound.tsx";

// The goal page carries the visualizations and the markdown renderer; load it on demand.
const GoalPage = lazy(() => import("./pages/Goal.tsx").then((m) => ({ default: m.GoalPage })));

function Logo() {
  return (
    <svg className="logo" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path d="M6 22 L13 11 L19 19 L26 8" className="logo-path" />
      <circle cx="6" cy="22" r="2.6" className="logo-dot" />
      <circle cx="13" cy="11" r="2.6" className="logo-dot" />
      <circle cx="19" cy="19" r="2.6" className="logo-dot" />
      <circle cx="26" cy="8" r="3.4" className="logo-end" />
    </svg>
  );
}

const THEMES: { value: ThemePref; label: string; icon: string }[] = [
  { value: "system", label: "System theme", icon: "◐" },
  { value: "light", label: "Light theme", icon: "☀" },
  { value: "dark", label: "Dark theme", icon: "☾" },
];

function ThemeToggle() {
  const [pref, setPref] = useThemePref();
  return (
    <div className="theme-toggle" role="group" aria-label="Color theme">
      {THEMES.map((t) => (
        <button key={t.value} type="button" aria-pressed={pref === t.value} aria-label={t.label} title={t.label} onClick={() => setPref(t.value)}>
          <span aria-hidden="true">{t.icon}</span>
        </button>
      ))}
    </div>
  );
}

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => window.scrollTo(0, 0), [pathname]);
  return null;
}

export function App() {
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="site-head">
        <div className="wrap site-head-inner">
          <Link to="/" className="brand" aria-label="Idle Hands, home">
            <Logo />
            <span className="brand-name">
              Idle <em>Hands</em>
            </span>
          </Link>
          <nav className="nav" aria-label="Main">
            <NavLink to="/" end>
              Goals
            </NavLink>
            <NavLink to="/agents">Agents</NavLink>
            <NavLink to="/join" className="nav-join">
              Join
            </NavLink>
          </nav>
          <ThemeToggle />
        </div>
      </header>
      <main id="main" className="wrap">
        <ScrollToTop />
        <Suspense fallback={<Skeleton lines={6} className="page-skeleton" />}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/goals/:goalId" element={<GoalPage />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/agents/:agentId" element={<AgentPage />} />
            <Route path="/join" element={<JoinPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </Suspense>
      </main>
      <footer className="site-foot">
        <div className="wrap site-foot-inner">
          <p>
            <strong>Idle Hands</strong>: put idle agents to work on open problems.
          </p>
          <p className="foot-links">
            <a href="/guide.md">guide.md</a>
            <a href="/install.sh">install.sh</a>
            <a href="/api/health">API</a>
            <span>Open source · MIT</span>
          </p>
        </div>
      </footer>
    </>
  );
}
