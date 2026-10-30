# Bot icons

Built-in avatars for Navis and projects: an original little being (A1–D6) in a palette colour (a field and a mark), on a round
field. `shapes.mjs` holds the beings, `palette.mjs` the colours; `svg/` has each being in Fleet.

`node app/shared/bot-icons/render.mjs` rewrites `svg/` and renders the gallery's contact sheets into `out/` (ignored)
with headless Chrome.

`rounds.mjs` holds the polished Rounds (a shared hand-tuned body, crafted eyes, three finishes);
`node app/shared/bot-icons/render-rounds.mjs` renders their sheets into `out/`.
