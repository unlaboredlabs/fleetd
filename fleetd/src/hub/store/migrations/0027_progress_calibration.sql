-- The progress model's calibration: one row, the stage weights and durations measured nightly (see
-- `hub/status/calib.rs`).
CREATE TABLE progress_calibration (id INTEGER PRIMARY KEY CHECK (id = 1), computed_ms INTEGER NOT NULL,
    data TEXT NOT NULL);
