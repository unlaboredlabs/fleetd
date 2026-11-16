-- An iOS simulator the agents' Mac lends with `mac sim start` is a screen of its own (hub/mac_tool): the hub places it
-- on the Mac as a hosted session of the agent's, so its live view, takeover and recording go there. Such a place never
-- carries the agent's session calls (they stay on its own machine) and takes no screen slot on the Mac: the Mac's
-- simulator budget bounds them.
ALTER TABLE session_places ADD COLUMN sim INTEGER NOT NULL DEFAULT 0;
