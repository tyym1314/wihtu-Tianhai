# Local presentation fonts

These are unmodified WOFF2 files downloaded from the official Google Fonts CDN. `manifest.json` records the URL, script subset, bytes, SHA-256, real variable axes, CSS hash and corresponding OFL license for every font. The licenses come from the pinned `google/fonts` commit recorded in the manifest. Builds do not contact Google.

| Consumer | Fonts | Cold font bytes |
| --- | --- | ---: |
| Golf | DM Sans Latin + Cormorant Garamond Latin | 74,756 |
| Thunder, Chinese/English | Cinzel Latin | 25,888 |
| Thunder, Arabic | Cinzel Latin + Noto Sans Arabic Arabic subset | 192,040 |
| Tiger, Chinese/English | Cormorant Garamond Latin | 37,776 |
| Tiger, Arabic | Cormorant Garamond Latin + Noto Sans Arabic Arabic subset | 203,928 |

These figures describe font payloads when those families are used, not complete game payloads. All four assets total 266,796 bytes. Each face declares one variable URL for weights 400 through 700, within the actual file's weight axis; it is not downloaded once per weight. `unicode-range` keeps Arabic lazy. Existing `font-display: swap` behavior is retained. No font network request blocks game boot or input.

Latin assets retain the original decorative families and their official Latin script coverage. Other scripts use platform fallback fonts. Noto Sans Arabic is the complete official Arabic script subset, not a text/screenshot subset: 1,226 mapped code points, 1,340 glyphs, and the original GSUB/GPOS shaping tables. All 41 distinct Arabic UI code points found in the current prototype translations and platform copy are included.

Tiger's downloadable Noto Sans SC is intentionally replaced in the isolated platform presentation by `system-ui`, Apple system UI, PingFang SC, Hiragino Sans GB, Microsoft YaHei and Noto Sans CJK SC fallbacks. The logo receives the same native Chinese fallback. This avoids remote Chinese CSS/shards and preserves the OS's Chinese coverage for dynamically supplied nicknames. Chinese typography may vary by OS; glyph coverage is bounded by the OS, not an application screenshot subset. Original prototype files in the repository's `src/` stay unchanged.

Golf imports these local CSS files directly. `legacy-fonts.mjs` rewrites only the two copied legacy CSS files, checks the expected upstream boundaries, and rejects surviving external CSS imports. Vite emits hashed same-origin WOFF2 assets. `build-legacy.mjs` verifies font/CSS/license hashes and copies license files plus the manifest to `legacy/dist/font-licenses/`. Arena's build must likewise ship `font-licenses/`; Vite strips comments during CSS processing, so the source CSS's OFL comments alone are insufficient for a distribution.

Validation artifacts and reproduction scripts: `../../review/deep-mobile-20261004/fonts/`. They cover font loading, caching, shaping/coverage, isolated-source preservation, and mobile-width CSS rendering. They do not certify physical iPhone performance.
