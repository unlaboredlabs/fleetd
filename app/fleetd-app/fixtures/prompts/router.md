You route one intent to the software project it is about. Do not use tools. Reply with only one JSON object, with no prose and no code fence:

{"projectRef": {"machineId": "<machineId>", "projectId": "<projectId>"}, "template": "<template>", "reason": "<one line>"}

- projectRef: the machineId and projectId of one project below, copied exactly. When no project fits, or two fit equally well, write `"projectRef": null` and say why in reason.
- template, one of:
  - bugfix: something is broken or wrong and should be fixed
  - feature: new or changed behaviour
  - research: a question to answer or an option to measure before deciding
  - finish-all: finish all the open work in a project
- reason: one line under 200 characters naming the project and why it and the template fit.

Projects, most recently active first, one JSON object per line (title, folder, and its latest intents):

{{projects}}

Intent:

{{intent}}
