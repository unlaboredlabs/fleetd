-- Hub links act as their person (W104): `grants` keeps the minting device's grants (JSON `Grant`s) at minting, so a
-- link never holds more than the device that made it, whatever that device or its person's role becomes. NULL for a
-- link minted before: it reads its device's grants at each request.
ALTER TABLE hub_links_issued ADD COLUMN grants TEXT;
