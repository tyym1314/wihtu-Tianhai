# Isolated mobile measurement backend

`profile-mobile-isolated.mjs` serves copied production builds through an HTTP
localhost gateway and a private PostgreSQL database. It does not attach to a
browser or device. Start it with fresh output paths:

```sh
node scripts/profile-mobile-isolated.mjs \
  --output review/my-measurement/stack.json \
  --ready-file review/my-measurement/ready.json \
  --hold-seconds 900
```

Read the ready file for the origin and owned process ID. Send SIGTERM to that
process when finished. The harness audits sessions, stops its servers, drops
only its database, and removes its private build copy. These actions do not
clear cookies from an external browser.

## Cookie ownership

Cookies are shared across localhost ports. Each harness invocation therefore
creates a random `oasis_quality_demo_<128-bit hex>` alias, recorded as
`delivery.cookie_alias_name` in its report and `cookie_scope` in its ready file.
A supervised command receives `OASIS_PROFILE_COOKIE_ALIAS` together with
`OASIS_PROFILE_ORIGIN`.

The gateway forwards only its own alias as `__Host-oasis_demo`. It omits older
local aliases and an incoming cookie already named `__Host-oasis_demo` from
that upstream request; it does not delete them from the browser. The signed
value, expiry, HttpOnly, SameSite, and original server MAC/CSRF checks remain
unchanged. Only the cookie name and the HTTP-only gateway's Secure flag differ.
This fixture is not evidence of deployed HTTPS cookie acceptance.

The browser owner must clean its own alias **before closing its context**:

```js
import {withOwnedLoopbackCookie} from './mobile-isolated-cookie.mjs';

const scope = ready.cookie_scope;
await withOwnedLoopbackCookie(context, scope, async () => {
  // Run the already-authorized measurement in this owned context.
});
```

The helper uses `try/finally`, clears only the exact alias/domain/path, and
checks that it is absent. It preserves unrelated cookies, other instances,
and cookies with the same name on other paths. For an existing owner-specific
`finally`, call `clearOwnedLoopbackCookie(context, scope)` there. The helper
requires an explicit HTTP localhost port and never discovers a browser or
connects to CDP by itself. If both measurement and cleanup fail, both errors
remain available in an `AggregateError`.

Existing device drivers are not automatically connected to this helper. Their
owner must explicitly consume `cookie_scope` and record cleanup readback.
The server report marks browser cookie cleanup as not performed by the harness;
server shutdown must never be reported as browser cookie cleanup.

## Diagnostics and validation

An unsuccessful startup `/api/demo/config` JSON response is retained in
`protocol_config_error` with its HTTP status. Actual HTTP and browser errors
must remain failures; do not filter them from a report. The gateway handles
only exact `GET`/`HEAD /favicon.ico` with 204/no-store so the absent local favicon
does not create an unrelated resource error. API paths, query variants and
other methods follow normal routing.

The measurement source manifest includes both the harness and its cookie helper.
No cookie values, signing keys or CSRF tokens are placed in the ready file.

```sh
node --test tests/mobile-isolated-harness.test.mjs tests/mobile-isolated-cookie.test.mjs tests/mobile-output-guards.test.mjs
node --test tests/mobile-isolated-cookie-ui.mjs
```

The first command checks mapping, real demo-host MAC/CSRF rejection and cleanup
boundaries on local test servers. The second opens only a fresh temporary
headless desktop Chrome context to verify selective cookie deletion. It does
not navigate, access a phone, call public services, or create a game room.
