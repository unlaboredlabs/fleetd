# Third-party notices

Code adapted from other projects into app/desktop, with its license. npm dependencies carry their own licenses in
`node_modules` and are not listed here.

## T3 Code (pingdotgg/t3code), MIT

Used in `src/renderer/ui/diff/` (the diff parser's shapes and its raw-text fallback, the per-file diff blocks with
an "N unchanged lines" separator, add/delete tints mixed over the code surface), adapted from
`apps/web/src/lib/diffRendering.ts` and the diff panel.

Also in `src/renderer/screens/order/`: the follow-up composer's key resolution and its primary/secondary send
actions (`packages/client-runtime/src/state/composerDispatch.ts`, `apps/web/src/components/chat/ComposerPrimaryActions.tsx`
→ `composer.ts`, `Composer.tsx`); the work log's folding of tool-call runs and the timeline's follow-at-end rule
(`apps/web/src/components/chat/MessagesTimeline.logic.ts` → `conversation.ts`, `Conversation.tsx`).

```
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Fonts, SIL Open Font License 1.1

IBM Plex Sans (Copyright 2017 IBM Corp.) and Lilex (Copyright 2019 The Lilex Project Authors) are bundled in
`src/renderer/ui/fonts/`, each with its licence text beside it.
