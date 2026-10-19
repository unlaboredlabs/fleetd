import { Suspense, useEffect, useState } from "react";
import { PaletteHost } from "../screens/palette";
import { AddProjectScreen, MachinesScreen, ProjectsHost } from "../screens/projects";
import { GalleryScreen } from "../ui";

// F1's shell frame and route table replace this; until then it shows the routes that have landed.
const useHash = () => {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return hash;
};

const Content = ({ hash }: { hash: string }) => {
  if (hash.startsWith("#/machines")) return <MachinesScreen />;
  return <h1 className="wordmark">fleetd</h1>;
};

export const App = () => {
  const hash = useHash();
  if (hash.startsWith("#/gallery") && GalleryScreen)
    return (
      <Suspense>
        <GalleryScreen />
      </Suspense>
    );
  return (
    <>
      <div className="shell" data-screen="shell">
        {/* The window's drag region; on macOS the traffic lights sit at its left. */}
        <header className="top-bar" />
        <main className="content">
          <Content hash={hash} />
        </main>
      </div>
      {hash.startsWith("#/projects/add") ? <AddProjectScreen /> : null}
      <ProjectsHost />
      <PaletteHost />
    </>
  );
};
