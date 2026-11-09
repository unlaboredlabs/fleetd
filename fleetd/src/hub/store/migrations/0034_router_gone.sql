-- The order router went: nothing emits intake.routed, and a stored one would no longer decode.
DELETE FROM events WHERE type = 'intake.routed';
