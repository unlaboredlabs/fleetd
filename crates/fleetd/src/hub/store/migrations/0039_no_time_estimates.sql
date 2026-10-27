-- fleetd makes no time estimates: the estimate samples go, and so do the retired estimate_miss incidents, whose
-- class no longer exists.
DROP TABLE estimates;
  DELETE FROM incidents WHERE class = 'estimate_miss';
