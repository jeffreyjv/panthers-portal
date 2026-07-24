import { useEffect, useState } from "react";
import { ClawMark } from "./ClawMark";
import { Countdown } from "./Countdown";
import { News } from "./News";
import { Schedule } from "./Schedule";
import { Team } from "./Team";

type Theme = "dark" | "light";
type Tab = "news" | "schedule" | "team";

const THEME_KEY = "panthers-portal-theme";

const TABS: { id: Tab; label: string }[] = [
  { id: "news", label: "News" },
  { id: "schedule", label: "Schedule" },
  { id: "team", label: "Team" },
];

function readTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY);
  return stored === "light" || stored === "dark" ? stored : "dark";
}

function useTheme() {
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  const toggle = () => setTheme((t) => (t === "dark" ? "light" : "dark"));
  return { theme, toggle };
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.4v2.2M12 19.4v2.2M2.4 12h2.2M19.4 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.5 14.3A8.6 8.6 0 0 1 9.7 3.5a8.6 8.6 0 1 0 10.8 10.8z" />
    </svg>
  );
}

function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={onToggle}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
    >
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

function Header({
  theme,
  onToggleTheme,
  tab,
  onSelectTab,
}: {
  theme: Theme;
  onToggleTheme: () => void;
  tab: Tab;
  onSelectTab: (t: Tab) => void;
}) {
  return (
    <header className="masthead">
      <div className="masthead-inner">
        <div className="brand">
          <ClawMark className="brand-claw" />
          <span className="brand-team">Panthers Portal</span>
        </div>
        <Countdown />
        <div className="masthead-tools">
          <nav className="tabs" aria-label="Sections">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`tab${t.id === tab ? " is-active" : ""}`}
                aria-current={t.id === tab ? "page" : undefined}
                onClick={() => onSelectTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        </div>
      </div>
    </header>
  );
}

export default function App() {
  const { theme, toggle } = useTheme();
  const [tab, setTab] = useState<Tab>("news");

  // Otherwise switching tabs while scrolled down drops you mid-page.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [tab]);

  return (
    <div className="page">
      <Header
        theme={theme}
        onToggleTheme={toggle}
        tab={tab}
        onSelectTab={setTab}
      />

      <main className="main">
        <div className="tab-panel" key={tab}>
          {tab === "news" && <News />}
          {tab === "schedule" && <Schedule />}
          {tab === "team" && <Team />}
        </div>
      </main>

      <footer className="footer">
        <ClawMark className="footer-claw" />
        <span>
          Unofficial reader · Stories from{" "}
          <a href="https://www.panthers.com/news/" target="_blank" rel="noreferrer">
            panthers.com
          </a>
        </span>
      </footer>
    </div>
  );
}
