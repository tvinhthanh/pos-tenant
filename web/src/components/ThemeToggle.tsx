"use client";

import React, { useEffect, useState } from "react";
import { Sun, Moon, Laptop } from "lucide-react";

type Theme = "light" | "dark" | "system";

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const savedTheme = localStorage.getItem("melio_theme") as Theme | null;
    if (savedTheme) {
      setTheme(savedTheme);
    }
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;

    const root = window.document.documentElement;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

    const applyTheme = (currentTheme: Theme) => {
      root.classList.remove("light", "dark");
      
      if (currentTheme === "system") {
        const systemTheme = mediaQuery.matches ? "dark" : "light";
        root.classList.add(systemTheme);
      } else {
        root.classList.add(currentTheme);
      }
    };

    applyTheme(theme);
    localStorage.setItem("melio_theme", theme);

    const handleSystemThemeChange = () => {
      if (theme === "system") {
        applyTheme("system");
      }
    };

    mediaQuery.addEventListener("change", handleSystemThemeChange);
    return () => mediaQuery.removeEventListener("change", handleSystemThemeChange);
  }, [theme, mounted]);

  if (!mounted) {
    return <div className="w-9 h-9 shrink-0" />; // Spacer
  }

  const cycleTheme = () => {
    if (theme === "light") setTheme("dark");
    else if (theme === "dark") setTheme("system");
    else setTheme("light");
  };

  const getIcon = () => {
    switch (theme) {
      case "light":
        return <Sun className="w-4 h-4 text-amber-500" />;
      case "dark":
        return <Moon className="w-4 h-4 text-indigo-405 text-indigo-400" />;
      case "system":
        return <Laptop className="w-4 h-4 text-slate-400" />;
    }
  };

  const getTitle = () => {
    switch (theme) {
      case "light":
        return "Chế độ Sáng - Click để đổi";
      case "dark":
        return "Chế độ Tối - Click để đổi";
      case "system":
        return "Chế độ Hệ thống - Click để đổi";
    }
  };

  return (
    <button
      onClick={cycleTheme}
      title={getTitle()}
      className="rounded-xl p-2.5 hover:bg-slate-850 border border-slate-800 dark:border-slate-850 hover:text-slate-100 transition-all flex items-center justify-center shrink-0"
    >
      {getIcon()}
    </button>
  );
}
