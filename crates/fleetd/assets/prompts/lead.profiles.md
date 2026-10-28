## Task profiles
Every agent runs on a profile: a model, an effort and a speed. This project allows the ones below. `{{default}}` is the default: leave `profile` out of `spawn_agent` for it. Name another only when its note fits the work; when in doubt, the default.
{{profiles}}
- Reviews always run on the default, whatever you set.
- A task on another profile whose review finds blockers twice is redone on the default: spawn the redo without `profile`.
