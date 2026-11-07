"use client";

import { useTheme } from "@/lib/theme";
import { useHotkeys } from "react-hotkeys-hook";
import { Sun, Moon, Desktop } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  const cycle = () => {
    setTheme(theme === "light" ? "dark" : theme === "dark" ? "system" : "light");
  };

  useHotkeys("mod+shift+l", cycle, { preventDefault: true }, [theme]);

  const Icon = theme === "dark" ? Moon : theme === "system" ? Desktop : Sun;
  const nome = theme === "dark" ? "escuro" : theme === "system" ? "automático" : "claro";

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={cycle}
      aria-label={`Tema: ${nome}. Cmd+Shift+L para alternar.`}
      title={`Tema: ${nome}`}
    >
      <Icon size={16} aria-hidden />
    </Button>
  );
}
