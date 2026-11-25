/** biome-ignore-all lint/a11y/noSvgWithoutTitle: decorative icons, aria label is set on button */
import { useEffect, useState } from "react";
import styles from "./styles.module.css";

type Theme = "light" | "dark";

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.setAttribute("data-theme", theme);
  root.style.colorScheme = theme;
}

function MoonIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="30"
      height="30"
      viewBox="0 0 80 80"
      aria-hidden="true"
    >
      <path
        className={styles.moonShape}
        d="M29.62,30.63c-.1,4.71.74,9.7,3.9,14.07s7.71,6.75,12.25,8.1A13.79,13.79,0,0,1,40.05,54a14.82,14.82,0,0,1-2.2-.17,14,14,0,0,1-8.23-23.23M39.75,18A22,22,0,0,0,36.6,61.76a22.47,22.47,0,0,0,3.45.27A22,22,0,0,0,60.87,47c-.87,0-2.15-.08-3.69-.26C51.39,46.08,43.75,45.17,40,40s-2.26-12.62-1.13-18.38c.3-1.52.63-2.76.88-3.59Z"
      />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="30"
      height="30"
      viewBox="0 0 80 80"
      aria-hidden="true"
    >
      <path
        className={styles.sunShape}
        d="M40,26A14,14,0,1,1,26,40,14,14,0,0,1,40,26m0-8A22,22,0,1,0,62,40,22,22,0,0,0,40,18Z"
      />

      <g className={styles.sunLines}>
        <line x1="40" y1="3" x2="40" y2="16" strokeWidth="8" />
        <line x1="77" y1="40" x2="64" y2="40" strokeWidth="8" />
        <line x1="40" y1="77" x2="40" y2="64" strokeWidth="8" />
        <line x1="3" y1="40" x2="16" y2="40" strokeWidth="8" />
        <line x1="66.16" y1="13.84" x2="56.97" y2="23.03" strokeWidth="8" />
        <line x1="66.16" y1="66.16" x2="56.97" y2="56.97" strokeWidth="8" />
        <line x1="13.84" y1="66.16" x2="23.03" y2="56.97" strokeWidth="8" />
        <line x1="13.84" y1="13.84" x2="23.03" y2="23.03" strokeWidth="8" />
      </g>
    </svg>
  );
}

export default function ThemeToggle() {
  // Initialize state to undefined to prevent hydration mismatch before client mount
  const [theme, setTheme] = useState<Theme | undefined>(undefined);

  // Derive initial theme preference from localStorage or system preference
  useEffect(() => {
    const savedTheme = localStorage.getItem("theme");
    const prefersDark = window.matchMedia(
      "(prefers-color-scheme: dark)",
    ).matches;

    if (savedTheme === "dark" || savedTheme === "light") {
      setTheme(savedTheme);
    } else if (prefersDark) {
      setTheme("dark");
    } else {
      setTheme("light");
    }
  }, []);

  // Apply theme to DOM and persist preference
  useEffect(() => {
    if (theme === undefined) return;

    applyTheme(theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  // Sync with OS color-scheme changes
  useEffect(() => {
    const handleMediaChange = ({ matches: isDark }: MediaQueryListEvent) => {
      setTheme(isDark ? "dark" : "light");
    };

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    mediaQuery.addEventListener("change", handleMediaChange);

    return () => {
      mediaQuery.removeEventListener("change", handleMediaChange);
    };
  }, []);

  const toggleTheme = (): void => {
    setTheme((prevTheme) => (prevTheme === "light" ? "dark" : "light"));
  };

  // Avoid rendering the button until the theme is determined to prevent incorrect icon/aria-label
  if (theme === undefined) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className={styles.themeToggle}
      aria-label={
        theme === "light" ? "Activate dark mode" : "Activate light mode"
      }
      title={theme === "light" ? "Activate dark mode" : "Activate light mode"}
    >
      {theme === "light" ? <MoonIcon /> : <SunIcon />}
    </button>
  );
}
