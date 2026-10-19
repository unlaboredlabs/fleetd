import { PaletteHost } from "../screens/palette";
import { UiProvider } from "../ui";

// F1's shell frame replaces this; it keeps <PaletteHost /> mounted once inside <UiProvider>.
export const App = () => (
  <UiProvider>
    <div className="shell" data-screen="shell">
      {/* The window's drag region; on macOS the traffic lights sit at its left. */}
      <header className="top-bar" />
      <main className="content">
        <h1 className="wordmark">fleetd</h1>
      </main>
    </div>
    <PaletteHost />
  </UiProvider>
);
