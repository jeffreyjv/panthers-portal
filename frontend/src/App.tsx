import { useEffect, useState } from "react";
import { ClawMark } from "./ClawMark";
import { Countdown } from "./Countdown";
import { Live } from "./Live";
import { useLive } from "./liveStore";
import { News } from "./News";
import { navigate, pathOf, Tab, tabOf, useRoute } from "./router";
import { Schedule } from "./Schedule";
import { ScoreToasts } from "./ScoreToasts";
import { SocialLinks } from "./SocialLinks";
import { Talk } from "./Talk";
import { Team } from "./Team";

type Theme = "dark" | "light";

const THEME_KEY = "panthers-portal-theme";

// Live sits second: on a game day it's the reason to open the site, and it's
// where the schedule's next row leads anyway.
const TABS: { id: Tab; label: string }[] = [
  { id: "news", label: "News" },
  { id: "live", label: "Live" },
  { id: "schedule", label: "Schedule" },
  { id: "team", label: "Team" },
  { id: "talk", label: "Talk" },
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
  gameIsLive,
}: {
  theme: Theme;
  onToggleTheme: () => void;
  tab: Tab;
  onSelectTab: (t: Tab) => void;
  gameIsLive: boolean;
}) {
  return (
    <header className="masthead">
      <div className="masthead-inner">
        <div className="brand">
          <ClawMark className="brand-claw" />
          <span className="brand-team">Panthers Portal</span>
        </div>
        <nav className="tabs" aria-label="Sections">
          {TABS.map((t) => {
            // Only the Live tab, and only while the ball is actually in play.
            const live = t.id === "live" && gameIsLive;
            return (
              <button
                key={t.id}
                type="button"
                className={`tab${t.id === tab ? " is-active" : ""}${
                  live ? " is-live" : ""
                }`}
                aria-current={t.id === tab ? "page" : undefined}
                aria-label={live ? `${t.label} — game in progress` : undefined}
                onClick={() => onSelectTab(t.id)}
              >
                {live && <span className="tab-live-dot" aria-hidden="true" />}
                {t.label}
              </button>
            );
          })}
        </nav>
        <div className="masthead-tools">
          <Countdown />
          <SocialLinks label="Panthers on social media" />
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        </div>
      </div>
    </header>
  );
}

export default function App() {
  const { theme, toggle } = useTheme();
  const route = useRoute();
  // Subscribing here keeps the shared poll running on every tab, which is the
  // point: the Live tab has to be able to flag a kickoff you aren't watching.
  const { game } = useLive();

  // Otherwise switching tabs while scrolled down drops you mid-page. Keyed on
  // the path so opening a story or a recap starts at the top too.
  const path = pathOf(route);
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [path]);

  return (
    <div className="page">
      <Header
        theme={theme}
        onToggleTheme={toggle}
        tab={tabOf(route)}
        onSelectTab={(id) => navigate({ name: id })}
        gameIsLive={game?.state === "in"}
      />

      <main className="main">
        {/* Keyed on the tab, not the path: the entrance animation belongs to
            arriving at a section, and opening a story inside one shouldn't
            replay it — or throw away the feed behind it. */}
        <div className="tab-panel" key={tabOf(route)}>
          {(route.name === "news" || route.name === "article") && <News />}
          {route.name === "live" && <Live />}
          {route.name === "game" && <Live eventId={route.eventId} />}
          {route.name === "schedule" && <Schedule />}
          {route.name === "team" && <Team />}
          {route.name === "talk" && <Talk />}
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
        <SocialLinks label="Panthers on social media (footer)" />
      </footer>

      <ScoreToasts />
    </div>
  );
}
