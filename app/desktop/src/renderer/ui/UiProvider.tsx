import type { ReactNode } from "react";
import { TooltipProvider } from "./primitives/Tooltip";
import { Toaster } from "./primitives/Toast";
import { ThemeProvider, type ThemeMode } from "./theme";
import "./tokens.css";
import "./base.css";

/** The design system's root: tokens and fonts, light/dark, the tooltip delay group and the toast viewport. */
export function UiProvider(props: { children: ReactNode; initialMode?: ThemeMode; onModeChange?: (mode: ThemeMode) => void }) {
  return (
    <ThemeProvider {...(props.initialMode ? { initialMode: props.initialMode } : {})} {...(props.onModeChange ? { onModeChange: props.onModeChange } : {})}>
      <TooltipProvider>
        <Toaster>{props.children}</Toaster>
      </TooltipProvider>
    </ThemeProvider>
  );
}
