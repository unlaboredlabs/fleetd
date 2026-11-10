# fleetd on X

The profile picture and the banner of fleetd's X account, with the sources that render them.

| File | What |
| --- | --- |
| `avatar-400.png` | The profile picture as X takes it, 400×400: Pebble on the landing page's dark paper. |
| `avatar-1024.png` | The same at 1024×1024, the master for anywhere that wants it larger. |
| `banner.png` | The banner, 1500×500: the name, lit from the corner where X sets the profile picture. |
| `designs.ts` | Both designs: the picture an SVG, the banner a page, in the landing page's colours and type. |
| `pebble.ts` | Pebble, still, drawn by the app's own rig (`app/desktop/src/shared/bot.ts`). |
| `build.ts` | Renders the three pictures from `designs.ts` with headless Chrome. |

After a change to a design, or to Pebble in the app, render them again and commit the pictures:

```sh
bun site/brand/x/build.ts
```

`CHROME` names the browser when it isn't `google-chrome`.

## What X does to them

- The profile picture is cut to a circle, zoomed about 5% on upload, and shown as small as 32 px, so it is one shape
  with room all round it: Pebble is 60% of the file's width, which X shows at 64% of the circle.
- The banner's lower left is under the profile picture. On a phone its top is under the clock and the round buttons,
  and about 100 px of each side is cut. The banner carries nothing that must be read: X sets the name right under it.

Nothing on fleetd.sh uses these files, and no check or build of the site reads them. Like the rest of `site/`, they are
served as they are (`/brand/x/banner.png`).
