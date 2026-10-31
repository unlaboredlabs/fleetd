# Bot icons

The built-in icons a project or Navi wears: one of nine glass beings (`glass/beings.json`: a shared hand-tuned body,
and each one's face) on a round field of one of twelve colors (`palette.json`). The hub names them
(`IconFace`, `IconColor` in fleetd-contracts, which a test keeps in step with these files) and derives one from a
project's id until a person picks.

`glass/scene.py` renders a being in Blender Cycles: frosted glass with the face sunk into it, over a lit disc of the
color. `glass/build.py` renders all 108 at 288 px into `out/` (ignored; it keeps renders already there), then
shrinks them into the WebP files the apps ship, at 32 and 96 points at 1x, 2x and 3x, in
`app/desktop/src/shared/botIcons/`, with their list (`index.ts`) and the phone's map (`app/mobile/src/botIconFiles.ts`):

    BLENDER=/path/to/blender python3 app/shared/bot-icons/glass/build.py

It needs Blender 4.5 and Python 3 with Pillow, and takes about 40 seconds an icon on two threads. `--shrink` only
remakes the WebP files from the renders in `out/`.
