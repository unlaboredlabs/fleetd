-- The slots' saturation spans went with the serial-wait findings that read them.
DELETE FROM time_spans WHERE kind = 37;
  DELETE FROM time_rollups WHERE kind = 37;
