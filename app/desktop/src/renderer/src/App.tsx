import { Suspense, useEffect, useState } from "react";
import { PaletteHost } from "../screens/palette";
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

// F1's shell frame replaces this; it keeps <PaletteHost /> mounted once beside the routes.
export const App = () => {
  const gallery = useIsGallery();
  return (
    <>
      {gallery && GalleryScreen ? (
        <Suspense>
          <GalleryScreen />
        </Suspense>
      ) : (
        <div className="shell" data-screen="shell">
          {/* The window's drag region; on macOS the traffic lights sit at its left. */}
          <header className="top-bar" />
          <main className="content">
            <h1 className="wordmark">fleetd</h1>
          </main>
        </div>
      )}
      <PaletteHost />
    </>
  );
};
