export const App = () => (
  <div className="shell">
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
