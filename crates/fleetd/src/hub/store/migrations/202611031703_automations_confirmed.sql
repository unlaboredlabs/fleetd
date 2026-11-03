-- W355: an automation the person wrote in the app counts as their go-ahead on its runs (`Automation.confirmed`, read
-- by a Navi's approval checker). Those made in the app before the mark existed get it; a lead's or another key's stay
-- unmarked until the person says yes to them.
UPDATE automations SET data = json_set(data, '$.confirmed', json('true'))
    WHERE created_by = 'human' AND json_valid(data);
