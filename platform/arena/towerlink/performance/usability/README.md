# Tower Link UI validation

Run from `platform/` with the isolated `node arena/towerlink/performance/ui-server.mjs` fixture already listening on port 18126:

```sh
node arena/towerlink/performance/ui-check.mjs
```

The fixture renders the production React component and Canvas renderer and submits accepted actions to a real, isolated Tower Link engine. It does not access the application API, sessions, wallets, or a public deployment. Opponent AI is covered by the separate training scenario tests, not this UI fixture.

`report.json` is the latest authoritative result. The script asserts:

- Chromium and WebKit: two-player games at 390×844 and 320×568, four-player game at 390×844, lesson 7 at 390×844, and lesson 6 at 320×568.
- Every tower hit box is 48×52 CSS pixels; tower hit boxes do not overlap; the page does not overflow; header/footer controls are at least 44 pixels in both dimensions; production text fits the selected-tower summary.
- Chromium CDP native touch dispatch at both viewport sizes: create route; repeat drag removes the route; blank drop; unreachable tower; touch cancellation; second finger inside the battlefield; second finger on the footer; lost pointer capture; successful new gesture after cancellation; and secondary selected-tower route clearing.
- No uncaught browser page errors.

`chromium-*` and `webkit-*` PNGs show the final layout. `chromium-drag-create-*`, `chromium-drag-cut-*`, and `chromium-route-panel-*` show gesture feedback and the secondary action “撤掉这座塔全部路线”. The shorter legacy PNG names mirror the Chromium layout images. `production-before-final.json` preserves the intermediate text-overflow regression that the stronger bounds check exposed; it is not the final result.

These are desktop browser engines with mobile viewport/touch emulation. Physical iPhone Safari usability, thermals, sustained frame pacing, and actual Wi-Fi/network behavior remain outside this check.
