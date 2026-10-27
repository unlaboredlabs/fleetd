-- Incidents went: what they told is in the events they were taken from. Their events go too, as no reader decodes
-- them.
DROP TABLE incidents;
  DELETE FROM events WHERE type = 'incident.recorded';
