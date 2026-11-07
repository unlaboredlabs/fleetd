-- The wrong codes tried while an agents' Mac setup code was the open one (hub/pair/mac.rs): at ten it closes, so
-- guesses are limited per code and per address, never hub-wide.
ALTER TABLE pair_codes ADD COLUMN failures INTEGER NOT NULL DEFAULT 0;
