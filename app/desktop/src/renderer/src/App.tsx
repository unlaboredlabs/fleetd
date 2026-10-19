import { Suspense, useEffect, useState } from "react";
import { GalleryScreen } from "../ui";

// Until F1's route table lands, the one route besides the shell is the design-system gallery.
const useIsGallery = () => {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return hash.startsWith("#/gallery");
};

export const App = () => {
  const gallery = useIsGallery();
  if (gallery && GalleryScreen)
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
