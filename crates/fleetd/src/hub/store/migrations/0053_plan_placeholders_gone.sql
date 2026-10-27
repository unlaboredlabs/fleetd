-- One `plan` call sets a workstream's items: the placeholders that stood in for an order with no items, and
-- their markers, go.
DROP TABLE plan_placeholders;
  DELETE FROM plan_changes WHERE milestone = 0;
