-- In-stage progress counts only while work is in flight. A figure stored under the old rule, which credited every
-- minute in a stage, can only fall with an observed cause, so it would stay held at the old height: every scope's
-- series restarts at its next render.
DELETE FROM status_series;
