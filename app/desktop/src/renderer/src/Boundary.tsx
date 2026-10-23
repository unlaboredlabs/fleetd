// Error boundaries: a part of the app that throws while rendering shows a calm card (or, for an overlay, a toast)
// instead of taking the whole window down to a blank page. The error goes to the app log, scrubbed (shared/scrub.ts).
import { Component, Fragment, useEffect, useState, type ReactNode } from "react";
import { asError, errorText, routeShape } from "../../shared/scrub";
import { Button, copyText, EmptyState, toast } from "../ui";

/** An error card's Copy details: what failed, the error and its frames (scrubbed), the version and the route's shape. */
export const errorDetails = (part: string, error: unknown): string =>
  [
    `fleetd ${window.fleetd.version} (${window.fleetd.platform})`,
    `Part: ${part}`,
    `Route: ${routeShape(window.location.hash)}`,
    errorText(asError(error)),
  ].join("\n");

/** Sends an error to the app log; main scrubs it again before writing. */
export const reportError = (what: string, error: unknown): void => {
  const e = asError(error);
  void window.fleetd.app.logError({
    what,
    message: e.message,
    route: window.location.hash,
    ...(e.name === undefined ? {} : { name: e.name }),
    ...(e.stack === undefined ? {} : { stack: e.stack.slice(0, 20_000) }),
  });
};

const copiedTitle = (ok: boolean) => (ok ? "Copied the details" : "Couldn’t copy the details");

const copyDetails = (part: string, error: unknown) =>
  void copyText(errorDetails(part, error)).then((ok) => toast({ key: "error-details", title: copiedTitle(ok), tone: ok ? "neutral" : "warning" }));

function Card({ part, error, root, onReload }: { part: string; error: unknown; root: boolean; onReload: () => void }) {
  // The whole app's card has no rest of the app to point at, and no toasts: their host is inside it. It says so
  // itself, and confirms a copy in its own text.
  const [copied, setCopied] = useState<boolean | null>(null);
  const copy = () => (root ? void copyText(errorDetails(part, error)).then(setCopied) : copyDetails(part, error));
  return (
    <div data-crashed={part} role="status" style={{ display: "contents" }}>
      <EmptyState
        title={root ? "fleetd hit an error" : "This part hit an error"}
        actions={
          <>
            <Button variant="secondary" onClick={onReload}>
              Reload
            </Button>
            <Button variant="quiet" onClick={copy}>
              Copy details
            </Button>
          </>
        }
      >
        {root ? `Reload to start it again.${copied === null ? "" : ` ${copiedTitle(copied)}.`}` : "The rest of the app still works."}
      </EmptyState>
    </div>
  );
}

interface Props {
  /** The part in words, for the log and Copy details: "the chat", "the sidebar". */
  readonly part: string;
  /**
   * An overlay (the palette) has no place for a card: it closes (`onError`) and a toast says what happened, with Copy
   * details. Opening it again mounts it afresh.
   */
  readonly overlay?: { readonly onError: () => void } | undefined;
  /** The boundary around the whole app (main.tsx): nothing else is left up, toasts included. */
  readonly root?: true | undefined;
  readonly children: ReactNode;
}

interface State {
  readonly failed: boolean;
  readonly error: unknown;
  /** Bumped by Reload: the part mounts afresh. */
  readonly mount: number;
}

export class Boundary extends Component<Props, State> {
  override state: State = { failed: false, error: undefined, mount: 0 };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { failed: true, error };
  }

  override componentDidCatch(error: unknown): void {
    reportError(`${this.props.part} hit an error`, error);
    const { overlay, part } = this.props;
    if (overlay === undefined) return;
    toast({
      key: "error-overlay",
      title: `${part.charAt(0).toUpperCase()}${part.slice(1)} hit an error`,
      description: "The rest of the app still works.",
      action: { label: "Copy details", onClick: () => copyDetails(part, error) },
    });
    overlay.onError();
  }

  #reload = () => this.setState((s) => ({ failed: false, error: undefined, mount: s.mount + 1 }));

  override render(): ReactNode {
    const { failed, error, mount } = this.state;
    if (failed) return this.props.overlay === undefined ? <Card part={this.props.part} error={error} root={this.props.root === true} onReload={this.#reload} /> : null;
    return (
      <Fragment key={mount}>
        {QA_PROBE ? <Probe part={this.props.part} /> : null}
        {this.props.children}
      </Fragment>
    );
  }
}

// The QA build's way to show a card (qa/registry.ts): a "fleetd:qa-crash" event naming a part makes it throw. Release
// builds leave it out.
const QA_PROBE = import.meta.env.VITE_FLEETD_QA === "1";

function Probe({ part }: { part: string }) {
  const [crash, setCrash] = useState(false);
  useEffect(() => {
    const on = (e: Event) => {
      if (e instanceof CustomEvent && e.detail === part) setCrash(true);
    };
    window.addEventListener("fleetd:qa-crash", on);
    return () => window.removeEventListener("fleetd:qa-crash", on);
  }, [part]);
  if (crash) throw new Error("A forced error, for the QA gate");
  return null;
}
