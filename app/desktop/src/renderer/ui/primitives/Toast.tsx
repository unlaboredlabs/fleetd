import { Toast as T } from "radix-ui";
import { X } from "lucide-react";
import { useSyncExternalStore, type ReactNode } from "react";
import { Button } from "./Button";
import s from "./Misc.module.css";

export type ToastTone = "neutral" | "success" | "warning" | "danger";

export interface ToastInput {
  title: ReactNode;
  description?: ReactNode;
  tone?: ToastTone;
  /** One action, by verb ("Undo", "Open"). */
  action?: { label: string; onClick: () => void };
  /** Milliseconds; 0 keeps it until dismissed. Default 5 s, 8 s with an action. */
  duration?: number;
  /** A toast with the same key replaces the one on screen instead of stacking. */
  key?: string;
  /** Its time stops (the pointer or focus on it, the window in the background) and goes on, for a caller timing alongside. */
  onPause?: () => void;
  onResume?: () => void;
}

interface ToastItem extends ToastInput {
  id: string;
  open: boolean;
}

let items: ReadonlyArray<ToastItem> = [];
const listeners = new Set<() => void>();
let seq = 0;

function emit(next: ReadonlyArray<ToastItem>) {
  items = next;
  for (const l of listeners) l();
}

/** Shows a toast; returns a function that dismisses it. Callable from anywhere (stores, IPC handlers). */
export function toast(input: ToastInput): () => void {
  const id = input.key ?? `t${++seq}`;
  const item: ToastItem = { ...input, id, open: true };
  const at = items.findIndex((t) => t.id === id);
  emit(at >= 0 ? items.map((t, i) => (i === at ? item : t)) : [...items.slice(-3), item]);
  return () => dismiss(id);
}

function dismiss(id: string) {
  emit(items.map((t) => (t.id === id ? { ...t, open: false } : t)));
  // Drop it after the exit animation (which is 0 ms under reduced motion; the delay is harmless then).
  window.setTimeout(() => emit(items.filter((t) => t.id !== id || t.open)), 200);
}

function useToasts() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => items,
  );
}

/** Mounted once by <UiProvider>. */
export function Toaster({ children }: { children: ReactNode }) {
  const list = useToasts();
  return (
    <T.Provider swipeDirection="right" label="Notification">
      {children}
      {list.map((t) => (
        <T.Root
          key={t.id}
          className={s.toast}
          open={t.open}
          duration={t.duration === 0 ? Infinity : (t.duration ?? (t.action ? 8000 : 5000))}
          {...(t.onPause === undefined ? {} : { onPause: t.onPause })}
          {...(t.onResume === undefined ? {} : { onResume: t.onResume })}
          onOpenChange={(open) => {
            if (!open) dismiss(t.id);
          }}
        >
          <span className={s.toastDot} data-tone={t.tone ?? "neutral"} aria-hidden />
          <div className={s.toastText} data-text="wrap">
            <T.Title className={s.toastTitle}>{t.title}</T.Title>
            {t.description ? <T.Description className={s.toastDescription}>{t.description}</T.Description> : null}
          </div>
          <div className={s.toastActions}>
            {t.action ? (
              <T.Action asChild altText={t.action.label}>
                <Button variant="ghost" onClick={t.action.onClick}>
                  {t.action.label}
                </Button>
              </T.Action>
            ) : null}
            <T.Close asChild>
              <Button variant="quiet" iconOnly aria-label="Dismiss">
                <X />
              </Button>
            </T.Close>
          </div>
        </T.Root>
      ))}
      <T.Viewport className={s.toastViewport} />
    </T.Provider>
  );
}
