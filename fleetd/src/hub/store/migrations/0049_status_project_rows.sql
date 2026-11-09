-- Status is the project rows: the long status doc, its seen marks and the calibrated forecast went, and a bar earns
-- fixed stage credits. Every series restarts, as a point stored under the old credits would hold the new figure.
DROP TABLE status_seen;
  DROP TABLE status_planning;
  DROP TABLE progress_calibration;
  DELETE FROM status_series;
