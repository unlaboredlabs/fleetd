import { Suspense, useEffect, useState } from "react";
import { GalleryScreen } from "../ui";
import { BoardScreen } from "../screens/board/BoardScreen";

// Until F1's route table lands (#181 replaces this file's routing), the routes besides the shell are the
// design-system gallery and the board.
const useHash = () => {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return hash;
};

export const App = () => {
  const hash = useHash();
  if (hash.startsWith("#/board"))
    return (
      <div className="shell" data-screen="shell">
        <header className="top-bar" />
        <BoardScreen />
      </div>
    );
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
      {/* Fixture data must never pass for a live hub. */}
      {window.fleetd.fixture !== null && (
        <div className="fixture-banner" role="status">
          Sample data, not connected
        </div>
      )}
      <main className="content">
        <h1 className="wordmark">fleetd</h1>
      </main>
    </div>
  );
};
