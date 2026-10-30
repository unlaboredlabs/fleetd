# Bot icons

Built-in avatars for Navis and projects: an original shape (A1–F8) in a palette colour (a field and a mark), on a round
field. `shapes.mjs` holds the shapes, `palette.mjs` the colours; `svg/` has each shape in Fleet.

`node app/shared/bot-icons/render.mjs` rewrites `svg/` and renders the gallery's contact sheets into `out/` (ignored)
with headless Chrome.
