import { Suspense, useEffect, useState } from "react";
import { GalleryScreen } from "../ui";
import { InboxPanel } from "../screens/inbox";

// Until F1's route table lands, the routes besides the shell are the design-system gallery and the inbox.
const useHash = () => {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return hash;
};

// TEMPORARY until F1's shell (feat/desktop-shell-ui) lands with the real panel host: the inbox over the shell at
// <route>?inbox[&ask=<id>] or #/inbox, so the QA gate can check it. F1's Shell replaces this whole file.
const inboxRoute = (hash: string): { askId: string | undefined } | null => {
  if (hash.startsWith("#/inbox")) return { askId: undefined };
  const query = new URLSearchParams(hash.split("?")[1] ?? "");
  return query.has("inbox") ? { askId: query.get("ask") ?? undefined } : null;
};

export const App = () => {
  const hash = useHash();
  const inbox = inboxRoute(hash);
  if (hash.startsWith("#/gallery") && GalleryScreen)
    return (
      <Suspense>
        <GalleryScreen />
      </Suspense>
    );
  return (
    <div className="shell" data-screen="shell">
      {/* The window's drag region; on macOS the traffic lights sit at its left. */}
      <header className="top-bar" />
      <main className="content">
        <h1 className="wordmark">fleetd</h1>
      </main>
      {inbox === null ? null : (
        <div className="inbox-host">
          <InboxPanel askId={inbox.askId} onClose={() => (window.location.hash = "#/")} />
        </div>
      )}
    </div>
  );
};
