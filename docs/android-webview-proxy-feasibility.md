# Feasibility study: Android `WebView` → `http://127.0.0.1:<port>` → SSH local port forward → remote web UI

**Scope.** An Android app runs an SSH client plus a `ServerSocket` bound to `127.0.0.1:<port>` (an SSH `direct-tcpip` local forward), and points a `WebView` at `http://127.0.0.1:<port>/?token=<secret>`; the server redirects and exchanges the token for a session cookie.

**How claims were verified.** Android documentation was read in full from the `developer.android.com` pages (the same pages were reachable through the `developer.android.google.cn` mirror, which serves identical content). Browser behaviour was verified in **Chromium source** (`chromium.googlesource.com`) and **AOSP source** (`android.googlesource.com`) rather than from blog posts. Wire behaviour is cited to IETF/W3C specs. Anything I could not verify is marked **UNVERIFIED** — the full list is at the end.

> **This is the second half of a pair.** The first half — whether the Android client should embed Node, port
> to Kotlin, or vendor an `ssh` binary, and which JVM SSH library to use — is
> [android-ssh-feasibility.md](android-ssh-feasibility.md). This document takes that decision as given (a
> Kotlin client with an in-process `LocalPortForwarder`) and covers what happens *after* it: the loopback URL
> the forward produces, and what the `WebView` does with it. Neither document repeats the other.

---

## (A) Navigating a `WebView` to `http://127.0.0.1:<port>` — cleartext policy

**Short answer: yes, it is allowed, but on API 28–36 you must explicitly opt in. It is not blocked "because it is localhost", and being loopback does not exempt you from the cleartext policy on those versions.**

### A1. The default, per API level

From the official network security configuration reference:

> "The default behavior of cleartext traffic depends on the API level:
> - Up to Android 8.1 (API level 27), cleartext support is enabled by default. Applications can opt out of cleartext traffic for additional security.
> - Starting with Android 9 (API level 28), cleartext support is disabled by default. Applications that require cleartext traffic can opt in to cleartext traffic."

The same page gives the effective default `base-config`:

> "The default configuration for apps targeting Android 9 (API level 28) and higher is as follows:
> `<base-config cleartextTrafficPermitted="false"><trust-anchors><certificates src="system" /></trust-anchors></base-config>`"

And for `android:usesCleartextTraffic` in the `<application>` element:

> "The default value for apps that target API level 27 or lower is `"true"`. Apps that target API level 28 or higher default to `"false"`."
> "This flag is ignored on Android 7.0 (API level 24) and above if an Android Network Security Config is present."
> "**Note: WebView honors this attribute for applications targeting API level 26 and higher.**"
> "This attribute is getting deprecated and will be ignored for apps targeting API levels 38 and above."

Sources: [Network security configuration](https://developer.android.com/privacy-and-security/security-config) · [`<application>` / `android:usesCleartextTraffic`](https://developer.android.com/guide/topics/manifest/application-element)

**Practical summary table**

| targetSdk | Without NSC | With NSC (base-config cleartext `false`) |
|---|---|---|
| ≤ 23 | cleartext allowed; also set `usesCleartextTraffic="true"` if you add an NSC | must set `usesCleartextTraffic="true"` **and** an NSC |
| 24–27 | cleartext allowed | NSC governs; `usesCleartextTraffic` ignored |
| 28–37 | cleartext **blocked** | per-host `cleartextTrafficPermitted="true"` unblocks the host |
| ≥ 38 | `usesCleartextTraffic` ignored (must use NSC) | per-host rule required |

### A2. WebView really does enforce the per-host cleartext policy

This is not just a platform-networking footnote. Chromium's Android network library, which WebView uses, calls the platform policy per host:

```java
/** Returns true if cleartext traffic to |host| is allowed by the current app. */
private static boolean isCleartextPermitted(String host) {
    try {
        return NetworkSecurityPolicyProxy.getInstance().isCleartextTrafficPermitted(host);
    } catch (IllegalArgumentException e) {
        return NetworkSecurityPolicyProxy.getInstance().isCleartextTrafficPermitted();
    }
}
```

which forwards to `android.security.NetworkSecurityPolicy.getInstance().isCleartextTrafficPermitted(host)`, i.e. an **application-level policy** (the stack is not a separate process, so the app's own manifest + NSC decide).

`ApplicationConfig.isCleartextTrafficPermitted(String hostname)` resolves the hostname to the most specific matching config and returns that config's flag, falling back to the default config:

```java
public boolean isCleartextTrafficPermitted(String hostname) {
    return getConfigForHostname(hostname).isCleartextTrafficPermitted();
}
```

Sources: [Chromium `net/android/java/src/org/chromium/net/AndroidNetworkLibrary.java`](https://chromium.googlesource.com/chromium/src/+/main/net/android/java/src/org/chromium/net/AndroidNetworkLibrary.java) · [AOSP `ApplicationConfig.java`](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/security/net/config/ApplicationConfig.java) · [AOSP `NetworkSecurityPolicy.java`](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/security/NetworkSecurityPolicy.java)

*(I did not find the `ERR_CLEARTEXT_NOT_PERMITTED` string mapping in the files I fetched — the failure surface is that the request is refused by policy. The exact `net::Error` code WebView surfaces for a blocked loopback subresource is **UNVERIFIED** here.)*

### A3. Does a `domain-config` for `127.0.0.1` / `localhost` work? Yes.

The documented syntax allows a `domain-config` that permits cleartext for named domains, and the platform explicitly recognises loopback as a *domain* value:

> "If your app needs to connect to destinations using cleartext traffic (HTTP), you can opt in to supporting cleartext to those destinations.
> `<domain-config cleartextTrafficPermitted="true"><domain includeSubdomains="true">insecure.example.com</domain></domain-config>`"

> "**Localhost configuration**
> Enforcing the network security features for localhost connections is generally unnecessary. For example, certificate transparency is rarely needed for localhost connections.
> From Android 17 (API level 37) and higher, if no configuration has been defined for localhost, an implicit configuration is included. By default, this configuration does the following:
> - Allows cleartext traffic.
> - Doesn't enforce certificate transparency (CT).
> - Doesn't enforce certificate pinning.
> - Delegates to `<base-config>` for trust anchors.
>
> A configuration is considered to be targeting localhost if the domain is:
> - `localhost`
> - `ip6-localhost` or
> - a numerical IP address and `InetAddress.isLoopback()` is true (for example, `127.0.0.1` or `[::1]`)"

Two consequences worth flagging:

1. **On API 28–36 there is no documented implicit loopback exemption.** The API-37 wording ("*From* Android 17 … an implicit configuration *is included*") implies that before API 37 an app with `cleartextTrafficPermitted="false"` had to opt in explicitly for loopback too. I grepped AOSP `main` (`ApplicationConfig.java`, `NetworkSecurityConfig.java`, `ManifestConfigSource.java`, `XmlConfigSource.java`, `NetworkSecurityConfigProvider.java`) and found **no localhost/loopback special-casing in those files**, which is consistent with the docs but does not prove where the API-37 behaviour lives. See **UNVERIFIED** list.
2. **Ambiguity on API 37+:** "if *no configuration has been defined for localhost*" — whether a `base-config` with `cleartextTrafficPermitted="false"` counts as "a configuration … for localhost" is not stated. Do not rely on the implicit config; write the explicit rule.

**Recommended configuration (explicit, version-independent):**

```xml
<!-- res/xml/network_security_config.xml -->
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <!-- default: no cleartext anywhere -->
  <base-config cleartextTrafficPermitted="false">
    <trust-anchors><certificates src="system" /></trust-anchors>
  </base-config>

  <!-- narrow opt-in for the local proxy origin only -->
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">127.0.0.1</domain>
    <domain includeSubdomains="false">localhost</domain>
    <domain includeSubdomains="false">[::1]</domain>
  </domain-config>
</network-security-config>
```

```xml
<application android:networkSecurityConfig="@xml/network_security_config" ... >
```

Do **not** use `<base-config cleartextTrafficPermitted="true">`; the docs call that "insecure … should be avoided whenever possible". Make sure the listener is bound to `127.0.0.1` only, so the narrow NSC rule cannot be exploited against a `0.0.0.0` bind.

Source: [Network security configuration](https://developer.android.com/privacy-and-security/security-config)

### A4. Is anything special about loopback *at the web-platform level*? Yes — but that is a different mechanism

`http://127.0.0.1` is a **potentially trustworthy origin** (a "secure context") per the W3C Secure Contexts algorithm:

> Step 4: "If origin's host matches one of the CIDR notations `127.0.0.0/8` or `::1/128` [RFC4632], return `Potentially Trustworthy`."

That governs feature availability (`crypto.subtle`, `navigator.clipboard`, service workers, `isSecureContext`), **not** the Android cleartext blocklist. The two are independent: a page can be a secure context and still be refused by `NetworkSecurityPolicy`. Do not conflate them.

Source: [W3C Secure Contexts, §3.1](https://w3c.github.io/webappsec-secure-contexts/#is-origin-trustworthy)

### A5. Forward-looking risks in this area

- `android:usesCleartextTraffic` "is getting deprecated and will be ignored for apps targeting API levels 38 and above" → migrate to NSC now. [`<application>` docs](https://developer.android.com/guide/topics/manifest/application-element)
- Android 17 blocks **cross-profile** loopback ("Loopback traffic within the same profile is not affected") — relevant if you ever support a work profile. [Android 17 behaviour changes](https://developer.android.com/about/versions/17/behavior-changes-all)
- Local Network Protections (`ACCESS_LOCAL_NETWORK`, enforced from Android 17 for targetSdk 37+) gate traffic "to and from a **local network address**", and the doc's impact table includes "Accepting an incoming TCP connection — yes". The document never mentions loopback. **UNVERIFIED whether `127.0.0.1` counts.** Note also: "Traffic originating from Android Webviews that require local network access will inherit permission state from the host app." [Local network permission](https://developer.android.com/privacy-and-security/local-network-permission)

---

## (B) WebView data directory, cookies, `localStorage`, and ephemerality

### B1. Where WebView data lives

WebView stores all of its per-process data (cookies, DOM storage, HTTP cache, service workers) under a directory the app does not choose directly; the only official handle is `WebView.setDataDirectorySuffix(String)` (API 28+):

> "Define the directory used to store WebView data for the current process. The provided suffix will be used when constructing data and cache directory paths. If this API is not called, no suffix will be used. Each directory can be used by only one process in the application. … This API must be called before any instances of WebView are created in this process and before any other methods in the `android.webkit` package are called by this process."

Since Android's app-private internal storage is used, the files sit under the app's private data dir, and "**Other apps cannot access files stored within internal storage.**"

Sources: [`WebView.setDataDirectorySuffix`](https://developer.android.com/reference/android/webkit/WebView#setDataDirectorySuffix(java.lang.String)) · [App-specific storage](https://developer.android.com/training/data-storage/app-specific)

*(The concrete on-disk names — e.g. an `app_webview/` directory with a `Cookies` SQLite file, `Local Storage/leveldb`, `Service Worker/` — are **not** documented by Google. I did not verify the exact paths: **UNVERIFIED**.)*

### B2. Cookies

Cookies are held by the process-wide `CookieManager` singleton:

> "Manages the cookies used by an application's WebView instances. `CookieManager` represents cookies as strings in the same format as the HTTP Cookie and Set-Cookie header fields (defined in RFC6265bis)."

Key API semantics (all verbatim from the reference):

| API | Documented behaviour |
|---|---|
| `flush()` | "Ensures all cookies currently accessible through the `getCookie` API are **written to persistent storage**. This call will block the caller until it is done and may perform I/O." |
| `removeAllCookies(ValueCallback)` | "Removes all cookies. This method is asynchronous." |
| `removeSessionCookies(ValueCallback)` | "Removes all session cookies, which are cookies **without an expiration date**." |
| `setAcceptCookie(boolean)` | "By default this is set to `true` and the WebView accepts cookies." |
| `setAcceptThirdPartyCookies(WebView, boolean)` | "Allowing third party cookies is a **per WebView policy** and can be set differently on different WebView instances. Apps that target `Build.VERSION_CODES.KITKAT` or below default to allowing third party cookies. Apps targeting `Build.VERSION_CODES.LOLLIPOP` or later **default to disallowing** third party cookies." |
| `getCookie(String url)` | "Note: Any cookies set with the `"Partitioned"` attribute will only be returned for the top-level partition of `url`." |

Source: [`CookieManager`](https://developer.android.com/reference/android/webkit/CookieManager)

### B3. Does a session cookie survive an app restart?

**The important, non-obvious answer: Android gives you no API-level guarantee that session cookies are discarded on restart, and the store is explicitly persistent.**

`flush()` is documented as writing "**all** cookies currently accessible through the `getCookie` API" to persistent storage — that includes cookies with no expiry, because `getCookie` returns them (they are only *called* "session cookies" because they have no expiry date, per `removeSessionCookies`). There is no documented "session cookies are memory-only in WebView" statement, and there is no documented flush-on-pause contract you can rely on.

**Therefore you must actively clear state, and you must do it on both the cookie and DOM-storage axes.**

> **UNVERIFIED:** whether a session cookie set during a session *always* survives a restart without an explicit `flush()` (i.e. whether WebView flushes on its own). Treat "it survives" as the safe assumption. I found no official statement either way, and `CookieSyncManager` (which used to mediate this) is deprecated in API 21 and only appears in the API index.

### B4. `localStorage` is off by default

> `setDomStorageEnabled(boolean)`: "Sets whether the DOM storage API is enabled. **The default value is `false`.**"

So `localStorage`/`sessionStorage` do nothing at all unless you call `getSettings().setDomStorageEnabled(true)`. If the remote UI depends on them and you forget this, it will fail in a confusing, silent way. Source: [`WebSettings`](https://developer.android.com/reference/android/webkit/WebSettings#setDomStorageEnabled(boolean))

### B5. Is there a supported *ephemeral* profile for one WebView?

**There is no incognito/off-the-record mode for Android WebView.** I found no `incognito`, `offTheRecord`, or in-memory-profile API in `WebSettings`, `WebView`, or `WebViewCompat`/`Profile`/`ProfileStore`. (Calling this **UNVERIFIED** in the strict sense: it is an absence of API rather than a documented statement.)

The closest supported mechanism is the **androidx.webkit multi-profile API**:

> "`ProfileStore`: Manages any creation, deletion for `Profile`."
> `getOrCreateProfile(String name)` — "Returns a profile with the given name, creating if needed."
> `deleteProfile(String name)` — "Deletes the profile data associated with the name. If this method returns `true`, the `Profile` object associated with the name will no longer be usable…"; throws `IllegalStateException` "if there are living WebViews associated with that profile" and "if you are trying to delete the default Profile."
> `Profile` exposes `getCookieManager()`, `getWebStorage()`, `getServiceWorkerController()`, `getGeolocationPermissions()` — "Each object is specific to the profile, and information is not shared between different profiles in the application."
> `WebViewCompat.setProfile(WebView, String)` — "Sets the `Profile` with its name as the current Profile for this WebView. **This should be called before doing anything else with WebView other than attaching it to the view hierarchy.**" Throws `IllegalStateException` if the WebView has already navigated, if a profile was already set, or if `evaluateJavascript` was called first; requires `WebViewFeature.MULTI_PROFILE`.

That gives you a **separate, deletable cookie jar + DOM storage + service-worker store per WebView**. It is *not* documented as memory-only, so it is "ephemeral if you delete it", not "ephemeral by construction".

Practical options, in order of strength:

1. **Server-side session semantics (do this regardless).** The `?token=` value should be single-use and short-lived; the server should invalidate the session on a logout/shutdown call and expire it aggressively. Never rely on client-side cleanup for a secret.
2. **Named profile + delete on exit** (`androidx.webkit` ≥ 1.9.0, feature-gated on `WebViewFeature.MULTI_PROFILE`): `setProfile` before navigating, then on shutdown destroy the WebView and `ProfileStore.getInstance().deleteProfile(name)`.
3. **Clear on exit** (works everywhere): `CookieManager.getInstance().removeAllCookies(null)` + `removeSessionCookies(null)` + `WebStorage.getInstance().deleteAllData()`.
4. **`setDataDirectorySuffix`** gives a separate persistent directory — useful for process isolation, **not** for ephemerality.
5. **Do not** try to `deleteAllData` while the WebView is alive and mid-session, and do not expect cookie clearing to kill an in-flight WebSocket.

Sources: [`ProfileStore`](https://developer.android.com/reference/androidx/webkit/ProfileStore) · [`Profile`](https://developer.android.com/reference/androidx/webkit/Profile) · [`WebViewCompat.setProfile`](https://developer.android.com/reference/androidx/webkit/WebViewCompat#setProfile(android.webkit.WebView,java.lang.String)) · [androidx WebKit release notes](https://developer.android.com/jetpack/androidx/releases/webkit) · [`WebStorage`](https://developer.android.com/reference/android/webkit/WebStorage)

---

## (C) Token → redirect → session cookie: what can break

### C1. A redirect from `http://127.0.0.1` that sets a cookie: fine

Nothing in the platform, WebView, or the cookie spec special-cases a *redirect* for cookie setting. Cookies are keyed by (name, domain/host-only, path), and a `Set-Cookie` on a redirect response is stored normally. The token exchange is also a **top-level navigation**, which is the most permissive case:

> RFC 6265bis §5.6: "If the cookie was received from a request which is navigating a top-level traversable …, skip the remaining substeps and continue processing the cookie. Note: Top-level navigations can create a cookie with any `SameSite` value, even if the new cookie wouldn't have been sent along with the request had it already existed prior to the navigation."

So `SameSite=Lax` (and even `Strict`) is settable and *sent* here, because the WebView is the top-level context and every subsequent request is same-origin/same-site. **The supported, boring design is: server sets a host-only, `Path=/`, `HttpOnly`, `SameSite=Lax` (or no `SameSite`) cookie.** That is what I would recommend as the primary path.

Source: [RFC 6265bis (draft-ietf-httpbis-rfc6265bis-21), §5.6](https://www.ietf.org/archive/id/draft-ietf-httpbis-rfc6265bis-21.html)

### C2. `Secure` cookies over plain HTTP — **loopback is the exception, and it works in Chromium**

The spec's baseline rule would drop them:

> RFC 6265bis §5.6: "If the request-uri does not denote a 'secure' connection (as defined by the user agent), and the cookie's `secure-only-flag` is true, then abort these steps and ignore the cookie entirely."

…but the spec then explicitly delegates "secure connection" to the UA, and names localhost:

> RFC 6265bis §5.7, Note: "The notion of a 'secure' connection is not defined by this document. Typically, user agents consider a connection secure if the connection makes use of transport-layer security, such as SSL or TLS, **or if the host is trusted**. For example, most user agents consider 'https' to be a scheme that denotes a secure protocol and **'localhost' to be trusted host**."

Chromium implements exactly this. Its cookie code classifies the cookie source as a third scheme, `kTrustworthy`:

```cpp
// Provisional evaluation of acceptability of setting secure cookies on
// `source_url` based only on the `source_url`'s scheme and whether it
// is a localhost URL. …
CookieAccessScheme ProvisionalAccessScheme(const GURL& source_url) {
  return source_url.SchemeIsCryptographic()
             ? CookieAccessScheme::kCryptographic
             : IsLocalhost(source_url) ? CookieAccessScheme::kTrustworthy
                                       : CookieAccessScheme::kNonCryptographic;
}
```

and `CanonicalCookie::Create` treats a `Secure` cookie from a non-cryptographic but trustworthy URL as if the source scheme had been secure:

```cpp
// It's possible that a trustworthy origin is setting this cookie with the
// `Secure` attribute even if the url's scheme isn't secure. In that case
// we'll act like it was a secure scheme.
if (parsed_cookie.IsSecure() || url.SchemeIsCryptographic()) {
    source_scheme = CookieSourceScheme::kSecure;
    if (!url.SchemeIsCryptographic()) {
      status->AddWarningReason(WARN_TENTATIVELY_ALLOWING_SECURE_SOURCE_SCHEME);
    }
}
```

`IsLocalhost` is defined as: IP literal ⇒ `IPAddress::IsLoopback()`; otherwise `localhost`, `localhost.`, or `*.localhost`:

```cpp
bool HostStringIsLocalhost(std::string_view host) {
  IPAddress ip_address;
  if (ip_address.AssignFromIPLiteral(host))
    return ip_address.IsLoopback();
  return IsLocalHostName(host);
}
```

**Conclusion:** `Secure` cookies *can* be set from `http://127.0.0.1:<port>` in Chromium/WebView. Two sharp edges:

- It keys off **localhost/loopback hostnames and IP literals only**. A LAN IP, a `.local` mDNS name, or a hostname that merely resolves to loopback will **not** get the trusted treatment. Use literally `127.0.0.1` or `localhost`.
- The `WARN_TENTATIVELY_ALLOWING_SECURE_SOURCE_SCHEME` warning reason exists precisely because this is a deliberate deviation from the letter of the spec. Chromium notes the cookie is "rejected later if the url isn't allowed to access secure cookies". Treat it as an implementation detail you depend on, not a standard.

Sources: [RFC 6265bis §5.6/§5.7](https://www.ietf.org/archive/id/draft-ietf-httpbis-rfc6265bis-21.html) · [Chromium `net/cookies/cookie_util.h`](https://chromium.googlesource.com/chromium/src/+/main/net/cookies/cookie_util.h) · [Chromium `net/cookies/cookie_util.cc`](https://chromium.googlesource.com/chromium/src/+/main/net/cookies/cookie_util.cc) · [Chromium `net/cookies/canonical_cookie.cc`](https://chromium.googlesource.com/chromium/src/+/main/net/cookies/canonical_cookie.cc) · [Chromium `net/base/url_util.h`](https://chromium.googlesource.com/chromium/src/+/main/net/base/url_util.h)

### C3. `SameSite=None` — the requirement is `Secure`, not `HTTPS`

> RFC 6265bis §5.6: "If the cookie's `same-site-flag` is `"None"`, abort this algorithm and ignore the cookie entirely **unless the cookie's `secure-only-flag` is true**."

So the spec's gate is the `Secure` **attribute**, not the transport. Since (C2) shows Chromium sets `Secure` cookies on loopback, `SameSite=None; Secure` from `http://127.0.0.1` should be accepted.

Chromium's own announcement is stricter in its wording, and is the thing to worry about if you ever move off loopback:

> "Cookies that still need to be delivered in a cross-site context can explicitly request `SameSite=None`, and must also be marked `Secure` **and delivered over HTTPS**."

**You do not need `SameSite=None` at all** if the WebView is the top-level document and all requests go to the same origin — `Lax` (or unspecified) is correct and safest. Only reach for `None` if the remote UI is itself embedded cross-origin (in which case third-party cookie policy also bites — see C5).

**UNVERIFIED:** I did not empirically confirm that Chromium/WebView accepts `SameSite=None; Secure` (as opposed to silently downgrading it to `Lax`) when set from `http://127.0.0.1`. The spec + source chain strongly suggests acceptance; test on device.

Sources: [RFC 6265bis §5.6](https://www.ietf.org/archive/id/draft-ietf-httpbis-rfc6265bis-21.html) · [Chromium SameSite updates](https://www.chromium.org/updates/same-site/) · [SameSite FAQ](https://www.chromium.org/updates/same-site/faq/)

### C4. SameSite default and Schemeful Same-Site

- Since **Chrome 80**, a cookie with no `SameSite` attribute is treated as `SameSite=Lax` (with a temporary "Lax+POST" 2-minute intervention). So an un-annotated cookie is fine for same-origin use but will not be sent from a genuine cross-site context. [Chromium SameSite updates](https://www.chromium.org/updates/same-site/)
- **Schemeful Same-Site** means `http://127.0.0.1` and `https://anything` are *different* sites for SameSite computation (the scheme is part of the site). If your token flow redirects `http://127.0.0.1` → `https://remote-host` → back, the cookie round-trip is cross-site. Chromium: "The modern SameSite behavior (SameSite=Lax by default, SameSite=None requires Secure, and Schemeful Same-Site)..." [Chromium SameSite updates](https://www.chromium.org/updates/same-site/). Keep the whole flow on the loopback origin; do the SSH-side work server-side.

### C5. Third-party cookie restrictions

- **WebView has its own, per-WebView switch**, and the default is restrictive for modern targets: `setAcceptThirdPartyCookies` — "Apps targeting `Build.VERSION_CODES.LOLLIPOP` or later **default to disallowing** third party cookies." If the remote UI embeds cross-origin iframes that need their own cookies, they will be dropped unless you opt in. [`CookieManager`](https://developer.android.com/reference/android/webkit/CookieManager)
- **Partitioned cookies are supported**: `getCookie` documents that cookies with the `"Partitioned"` attribute are returned only for the top-level partition, i.e. CHIPS semantics are implemented in WebView. [`CookieManager`](https://developer.android.com/reference/android/webkit/CookieManager)
- **UNVERIFIED:** whether Android WebView is in scope for Chrome's third-party-cookie deprecation (3PCD). I could not find an authoritative statement either way. In practice WebView has always been governed by `setAcceptThirdPartyCookies` + `setAcceptCookie`, but confirm for your target WebView version.
- **`Domain=` on an IP literal:** RFC 6265bis stores a host-only cookie unless the `Domain` attribute domain-matches the request host, aborting the cookie otherwise. A server that emits `Set-Cookie: …; Domain=127.0.0.1` is relying on IP-literal domain matching, which is a known portability hazard. Emit the cookie **without** a `Domain` attribute (host-only) for a `127.0.0.1` origin. [RFC 6265bis §5.6](https://www.ietf.org/archive/id/draft-ietf-httpbis-rfc6265bis-21.html)

### C6. Practical recommended flow

```
GET http://127.0.0.1:PORT/?token=<one-time>
  → 303 See Other  Location: http://127.0.0.1:PORT/app
     Set-Cookie: sid=<opaque>; Path=/; HttpOnly; SameSite=Lax
                 (omit Domain; add Secure only if you have verified it on your target WebView)
```
and in the app, immediately after the redirect resolves, rewrite the visible URL (e.g. `history.replaceState`) so the token does not linger in history or leak via `Referer`. Note that the `Referer` header will include the full URL — **including the query string** — for any cross-origin subresource the page loads, unless a referrer policy prevents it. Prefer a `Referrer-Policy: no-referrer` response header from the remote UI, or exchange the token on a top-level navigation only and never let the page load third-party subresources before the exchange.

---

## (D) Two-way realtime and what a hand-rolled proxy must get right

### D1. Yes — the traffic is proxied transparently, because there is no proxy involved

The `WebView` opens a plain TCP connection to `127.0.0.1:<port>` and speaks ordinary HTTP to *your listener*. There is no Android-provided proxying of WebSocket or SSE; from Chromium's point of view your listener simply *is* the origin server. Everything therefore depends on your listener implementing HTTP correctly.

### D2. `ws://` from an `http://127.0.0.1` page is not blocked as mixed content

Mixed content is defined relative to *potentially trustworthy* URLs, and loopback is potentially trustworthy:

> "A request is **mixed content** if its URL is **not** a potentially trustworthy URL **and** the context responsible for loading it prohibits mixed security contexts."
> §4.3 "Does settings prohibit mixed security contexts?": Step 1 — "If settings' origin is a potentially trustworthy origin, then return `Prohibits Mixed Security Contexts`."

`http://127.0.0.1` **is** potentially trustworthy (Secure Contexts §3.1 step 4: `127.0.0.0/8`, `::1/128`). Subresources fetched from it are therefore potentially trustworthy URLs, so mixed-content blocking never triggers for `http://` or `ws://` requests to loopback. Top-level navigations are additionally excluded from mixed-content checks entirely ("We exclude top-level navigations from mixed content checks").

Sources: [W3C Mixed Content §2, §4.3, §4.4](https://w3c.github.io/webappsec-mixed-content/) · [W3C Secure Contexts §3.1](https://w3c.github.io/webappsec-secure-contexts/#is-origin-trustworthy)

**Design constraint that actually bites:** if the remote UI emits an **absolute** `wss://remote-host/...` or `https://remote-host/...` URL, the WebView will connect directly to that host and **bypass your local proxy and the SSH tunnel entirely** — and then fail (or leak traffic). The remote UI must be configured with a relative or loopback-absolute base URL. If it hardcodes `wss://`, you must terminate TLS on your local listener (self-signed cert ⇒ you would then have to defeat certificate validation, which the docs explicitly forbid — see G). This is a real architectural constraint, not a detail.

### D3. HTTP/1.1 requirements your listener must satisfy

Chromium is a full HTTP/1.1 client. Your listener is the server, so **you** must implement the server side correctly.

- **Persistent connections are the default.**
  > RFC 9112 §9.3: "HTTP/1.1 defaults to the use of 'persistent connections', allowing multiple requests and responses to be carried over a single connection. HTTP implementations SHOULD support persistent connections." … "If the 'close' connection option is present … the connection will not persist after the current response."
- **Message delimitation is mandatory.** "In order to remain persistent, all messages on a connection need to have a self-defined message length (i.e., one not defined by closure of the connection)." So: always emit a correct `Content-Length`, or use `Transfer-Encoding: chunked` and terminate with a zero-length chunk. Never delimit a response body by closing the socket if you want the connection reused.
- **Chunked must be parsed and generated.**
  > RFC 9112 §6.1: "A recipient MUST be able to parse the chunked transfer coding." §7.1: "A sender MUST NOT apply the chunked transfer coding more than once to a message body."
- **Pipelining is rare.** RFC 9112 §9.3.2 says a client "MAY 'pipeline' its requests"; Chromium does not pipeline in normal navigation. Do not rely on it, but be aware a client may send a second request before reading the first response — safest is to read requests sequentially and never assume the socket has no buffered bytes.
- **Upgrade / WebSocket handshake** (RFC 6455 §1.3, §4.1): the client sends
  ```
  GET /chat HTTP/1.1
  Host: server.example.com
  Upgrade: websocket
  Connection: Upgrade
  Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
  Origin: http://example.com
  Sec-WebSocket-Protocol: chat, superchat
  Sec-WebSocket-Version: 13
  ```
  and the server replies `HTTP/1.1 101 Switching Protocols` with `Upgrade: websocket`, `Connection: Upgrade`, and the correct `Sec-WebSocket-Accept`. Your proxy must detect `Upgrade: websocket` (case-insensitively), relay the handshake **verbatim** (in particular `Sec-WebSocket-Key`, `Sec-WebSocket-Version`, `Sec-WebSocket-Protocol`, `Sec-WebSocket-Extensions`) to the far end, then switch to **opaque bidirectional byte relay** — no HTTP framing, no buffering, no coalescing. Buffer the header block up to `\r\n\r\n` before deciding that it is an upgrade; do not stream half a header.
  Sources: [RFC 6455](https://www.rfc-editor.org/rfc/rfc6455.html)
- **SSE / long-poll** need *no* special handling beyond "don't buffer": the response typically has `Content-Type: text/event-stream`, no `Content-Length`, and `Transfer-Encoding: chunked` (or HTTP/1.0-style close-delimited). Your proxy must **flush each chunk as it arrives**; a proxy that accumulates until EOF turns SSE into a hang. Do not add `Content-Length`, do not gzip, do not set a read/write timeout shorter than the UI's idle period (SSE keepalive comments can be minutes apart).
- **`Expect: 100-continue`**: a client may send `Expect: 100-continue` before a large body. RFC 9110 §10.1.1 defines the interim response; if your proxy swallows the `Expect` header or fails to relay the `100 Continue`, large uploads stall until timeout. [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html)
- **`CONNECT` is not needed.** `CONNECT` "requests that the recipient establish a tunnel to the destination origin server" and exists for proxying. Chromium does not use `CONNECT` to reach a plain `http://` origin; it opens a direct TCP connection. [RFC 9110 §9.3.6](https://www.rfc-editor.org/rfc/rfc9110.html)
- **Host/Origin rewriting.** Send `Host: 127.0.0.1:<port>` on the loopback hop. The remote server (or a reverse proxy / vhost) may behave differently for that `Host`, and the web UI's own same-origin checks (including any `Origin` check on POST or on the WebSocket handshake) will see `http://127.0.0.1:<port>`. If the remote UI enforces `Origin`/`Host` allowlists, you must either preserve the original host via SNI/`Host` mapping or configure the server to accept the loopback origin. **This is a common, non-obvious failure.**
- **Backpressure.** With WebSockets and SSE you will have long-lived connections in both directions. If you read faster than you write, you will buffer without bound and OOM. Cap per-connection buffering and pause reads (`InputStream` blocking naturally gives you this if you use a single reader thread per direction per connection — but do **not** spawn a thread per byte or per frame). Also handle **half-close**: the client may `shutdownOutput()` (e.g. `FIN` after a request body) while still expecting the response; closing the whole connection on `read() == -1` breaks that.
- **Concurrency.** Expect *many* simultaneous loopback connections (HTML + N subresources + WebSocket + SSE). Use a bounded thread pool or NIO/`Selector`; a single-threaded accept loop that handles one connection at a time will deadlock a modern web app.
- **HTTP/2 over cleartext (h2c):** Chromium is not expected to negotiate h2c for ordinary `http://` navigations (HTTP/2 in Chromium is TLS+ALPN in practice), so an HTTP/1.1-only listener should suffice. **UNVERIFIED** — I did not confirm this in Chromium source. If your listener sees the HTTP/2 connection preface `PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n`, that assumption is wrong.
- **Proxies:** WebView uses the system proxy by default ("by default the system-wide Android network proxy settings are used to redirect requests to appropriate proxy servers"), but Chromium applies **implicit bypass rules** for loopback, so your loopback origin is not sent to the proxy:
  > "Our implicit rules are approximately: `localhost`, `localhost.`, `*.localhost`, `loopback` [Windows only], `[::1]`, `127.0.0.1/8`, `169.254/16`, `[FE80::]/10`"
  If you want to be bulletproof, or if the device has an exotic proxy config, use `ProxyController.setProxyOverride(...)` with an explicit bypass rule — but note "calling `setProxyOverride` will cause any existing system wide setting to be ignored".
  Sources: [Chromium `proxy_host_matching_rules.cc`](https://chromium.googlesource.com/chromium/src/+/main/net/proxy_resolution/proxy_host_matching_rules.cc) · [`ProxyController`](https://developer.android.com/reference/androidx/webkit/ProxyController)

---

## (E) Lifecycle: keeping a loopback listener and an SSH connection alive

### E1. What happens when the app goes to the background

Three distinct things, and only the first is benign:

1. **Activity stopped, process alive and visible-ish** — the socket keeps accepting; the WebView keeps running. Nothing special.
2. **Process cached → frozen (Android 11+, hardened in Android 14+).** This is the decisive fact:
   > "App processes in the cached state are frozen **10 seconds** after entering the cached state."
   > "When an app process is frozen, **all of its threads are suspended** and can't perform CPU work until unfrozen."
   > "**If all processes for a particular app are frozen, the system terminates any active TCP sockets maintained by the app.** This prevents the server side of the socket from sending TCP keepalive pings that would wake up the device modem."
   > "Android terminates the least recently used cached app process if there are more than `MAX_CACHED_PROCESSES` cached app processes."
   So: **your `ServerSocket` and your SSH connection are terminated, not merely throttled.** A background SSH tunnel cannot survive on cached-process luck.
3. **App Standby** — "The system makes this determination when the user doesn't touch the app for a certain period of time and none of the following conditions applies: … The app has a process currently in the foreground, either as an activity **or foreground service** …". So a foreground service keeps the app out of App Standby.

Sources: [Cached apps freezer](https://source.android.com/docs/core/perf/cached-apps-freezer) · [Doze and App Standby](https://developer.android.com/training/monitoring-device-state/doze-standby)

### E2. There is no "network" or "socket" foreground service type — pick `specialUse`

The FGS type list is: `camera`, `connectedDevice`, `dataSync`, `health`, `location`, `mediaPlayback`, `mediaProcessing`, `mediaProjection`, `microphone`, `phoneCall`, `remoteMessaging`, `shortService`, `specialUse`, `systemExempted`.

- **`dataSync`** — "Data transfer operations … Transfer data between a device and the cloud over a network." Nominally closest, but **Android 15 introduced a hard cap**: "The system permits an app's `dataSync` services to run for a total of **6 hours** in any 24-hour period"; exceeding it throws `ForegroundServiceStartNotAllowedException` with "Time limit already exhausted for foreground service type dataSync", and a running one that overruns raises `RemoteServiceException: "A foreground service of type dataSync did not stop within its timeout"`. Also, targetSdk 35+ **cannot start `dataSync` from a `BOOT_COMPLETED` receiver**. For a tunnel a user may hold open for a working day, this is disqualifying.
- **`connectedDevice`** — "Interactions with external devices that require a Bluetooth, NFC, IR, USB, or network connection", but it has runtime prerequisites (one of `CHANGE_NETWORK_STATE`/`CHANGE_WIFI_STATE`/`CHANGE_WIFI_MULTICAST_STATE`/`NFC`/`TRANSMIT_IR`, or a granted `BLUETOOTH_CONNECT`/`BLUETOOTH_ADVERTISE`/`BLUETOOTH_SCAN`/`UWB_RANGING`, or `UsbManager.requestPermission()`). An SSH tunnel to a server is not an "external device" interaction, so this would be a misuse and would need an unrelated permission.
- **`specialUse`** — "Covers any valid foreground service use cases that aren't covered by the other foreground service types." Runtime prerequisites: **None**. But:
  > "In addition to declaring the `FOREGROUND_SERVICE_TYPE_SPECIAL_USE` foreground service type, developers **should declare use cases in the manifest**. To do so, they specify the `<property>` element within the `<service>` element. These values and corresponding use cases are **reviewed when you submit your app in the Google Play Console**."
  ```xml
  <service android:name="fooService" android:foregroundServiceType="specialUse">
    <property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"
              android:value="explanation_for_special_use"/>
  </service>
  ```

**Recommendation:** `specialUse`, with a clear `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` justification ("maintains a user-initiated SSH tunnel serving the app's own in-app WebView"), **plus** declare it in Play Console → Policy → App content. Budget for review friction; this is a Play-policy risk, not a technical one.

Sources: [Foreground service types](https://developer.android.com/develop/background-work/services/fgs/service-types) · [Android 15 behaviour changes](https://developer.android.com/about/versions/15/behavior-changes-15) · [Foreground service types are required (Android 14)](https://developer.android.com/about/versions/14/changes/fgs-types-required)

### E3. API 34+ hard requirements (Android 14)

Verbatim from the Android 14 change document:

> "If an app that targets Android 14 doesn't define types for a given service in the manifest, then the system will raise **`MissingForegroundServiceTypeException`** upon calling `startForeground()` for that service."

> "**Caution:** If you call `startForeground()` without declaring the appropriate foreground service type permission, the system throws a **`SecurityException`**."

> "**Caution:** If your app doesn't fulfill all of the runtime requirements for starting a foreground service, the system throws a `SecurityException` after you call `startForeground()` for that service. This prevents the foreground service from starting, might cause a running foreground service to be removed from the foreground process state, and might cause your app to crash."

Manifest shape for this app:

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_SPECIAL_USE" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />

<service android:name=".TunnelService"
         android:exported="false"
         android:foregroundServiceType="specialUse">
  <property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"
            android:value="User-initiated SSH tunnel serving the app's own WebView" />
</service>
```

Use `ServiceCompat.startForeground(this, id, notification, FOREGROUND_SERVICE_TYPE_SPECIAL_USE)`. "If the foreground service type is not specified in the call, the type defaults to the values defined in the manifest."

Sources: [Foreground service types are required (Android 14)](https://developer.android.com/about/versions/14/changes/fgs-types-required) · [Foreground service types](https://developer.android.com/develop/background-work/services/fgs/service-types)

### E4. You must start the FGS while the app is visible

> "In the following situations, your app can start foreground services even while your app runs in the background: Your app transitions from a user-visible state, such as an activity." Google Play policy / messaging: "…needs to be visible before you start a foreground service." Attempting a background start without an exemption raises `ForegroundServiceStartNotAllowedException`.

Design implication: **start the tunnel service from the foreground** (e.g. when the user taps "Connect"), never from a background receiver, and never rely on `BOOT_COMPLETED`. Also handle the user swiping the task away and the "user-stopped foreground service" case — once the user stops it, the app cannot restart it (see the "Handle user-stopped foreground service" section of the FGS overview).

Sources: [Restrictions on starting a foreground service from the background](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start) · [Android 15 behaviour changes](https://developer.android.com/about/versions/15/behavior-changes-15)

### E5. Notifications and `POST_NOTIFICATIONS`

> "**Note:** Apps **don't need** to request the `POST_NOTIFICATIONS` permission in order to launch a foreground service. However, apps **must include a notification** when they start a foreground service, just as they do on previous versions of Android."
> "Post notifications related to foreground services … appear in the notification drawer." Without the permission, the FGS notification is still visible via the **Task Manager** but not the drawer.

Also: "The status bar notification must use a priority of `PRIORITY_LOW` or higher."

Sources: [Notification runtime permission](https://developer.android.com/develop/ui/views/notifications/notification-permission) · [Launch a foreground service](https://developer.android.com/develop/background-work/services/fgs/launch)

### E6. Doze

> "The system applies the following restrictions to your apps while in Doze: **Suspends network access.** Ignores wake locks. Defers standard `AlarmManager` alarms…"

A foreground service keeps you out of App Standby but does **not** by itself exempt you from device-wide Doze network suspension. The documented escape hatch is the battery-optimization allowlist:

> "An app that is **partially exempt** can use the network and hold partial wake locks during Doze and App Standby. However, other restrictions still apply to the app… An app can check whether it is currently on the exemption list by calling `isIgnoringBatteryOptimizations()`."

And the policy catch:

> "**Note:** Google Play policies prohibit apps from requesting direct exemption from Power Management features—Doze and App Standby—in Android 6.0 and above unless the core function of the app is adversely affected."
> "Most apps can invoke an intent that contains the `ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS`. Apps that satisfy an acceptable use case can instead invoke an intent that contains the `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` intent action…"

The "Acceptable use cases for exemption" table accepts a "Peripheral device companion app" whose "core function is maintaining a persistent connection with the peripheral device for the purpose of providing the peripheral device internet access", and enterprise VOIP apps that "can't use FCM because of technical dependency on another messaging service". **An SSH tunnel to a server is not in that table.** So `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` is a Play-policy risk for this app; the user can still be sent to the battery-optimization settings screen manually, or better, the UI should degrade gracefully: reconnect the tunnel when the app returns to the foreground.

Also, since Doze "ignores wake locks", a `PARTIAL_WAKE_LOCK` is not a substitute for the allowlist during Doze.

Sources: [Optimize for Doze and App Standby](https://developer.android.com/training/monitoring-device-state/doze-standby)

### E7. What the WebView does in the background

When the app's process is cached and frozen, **all threads are suspended** including the renderer's main thread and the browser process's IO thread — a WebSocket/SSE will stall and the peer will eventually time out. When the process is instead alive with a **foreground service**, the renderer is not frozen; but note that Chromium also throttles timers in background/hidden pages, and an off-screen WebView may be deprioritized (`WebSettingsCompat.setOffscreenPreRaster` exists for off-screen rendering). **Practical consequence: do not rely on WebView-resident JS to keep the session warm. The tunnel must be kept alive by the Android service, independent of the WebView's liveness, and the UI must re-sync on resume.**

Sources: [Cached apps freezer](https://source.android.com/docs/core/perf/cached-apps-freezer) · [`WebSettingsCompat`](https://developer.android.com/reference/androidx/webkit/WebSettingsCompat)

---

## (F) Rendering and client wiring for a desktop-oriented web app

### F1. Viewport — WebView has no "request desktop site" mode

> `setUseWideViewPort(boolean)`: "Sets whether the WebView should enable support for the 'viewport' HTML meta tag or should use a wide viewport. When the value of the setting is `false`, the layout width is always set to the width of the WebView control in device-independent (CSS) pixels. When the value is `true` and the page contains the viewport meta tag, the value of the width specified in the tag is used. **If the page does not contain the tag or does not provide a width, then a wide viewport will be used.**"

So for a page with **no** viewport meta tag, `setUseWideViewPort(true)` gives you the closest thing to a desktop layout width. Add `setLoadWithOverviewMode(true)` to zoom out to fit. Note the coupling: if the page *does* contain a mobile viewport tag, `setUseWideViewPort(true)` honours the page's own (mobile) width — you cannot override a page that declares `width=device-width`.

User agent: `setUserAgentString(String)` and `getDefaultUserAgent(Context)`. Caveat that matters: "**Note that starting from `Build.VERSION_CODES.KITKAT` Android version, changing the user-agent while loading a web page causes WebView to initiate loading once again.**" Also, overriding the UA can change User-Agent Client Hints and `navigator.userAgentData`, so also look at `WebSettingsCompat.setUserAgentMetadata`. Set the UA **before** the first `loadUrl`.

Sources: [`WebSettings`](https://developer.android.com/reference/android/webkit/WebSettings) · [`WebSettingsCompat`](https://developer.android.com/reference/androidx/webkit/WebSettingsCompat)

### F2. `WebChromeClient` — what is broken by default, and what to override

| Feature | Callback | Documented default if you don't override |
|---|---|---|
| `alert()` | `onJsAlert` | If a client **is** set: "The default behavior if this method returns `false` or is not overridden is to show a dialog containing the alert message and suspend JavaScript execution until the dialog is dismissed." If **no** client is set: "the default dialog will be suppressed and Javascript execution will continue immediately." |
| `confirm()` / `prompt()` | `onJsConfirm` / `onJsPrompt` | Same dialog contract as `onJsAlert` |
| `<input type="file">` upload | `onShowFileChooser` (API 21+) | "**The default behavior is that WebView will cancel all file requests.**" Also: "This can be invoked both for uploads and downloads, and it can also be invoked for single files, multiple files, or entire folders." |
| Camera / mic / other permission prompts | `onPermissionRequest` | "**If this method isn't overridden, the permission is denied.**" |
| Fullscreen video / element fullscreen | `onShowCustomView` / `onHideCustomView` | No fullscreen; you must add the custom view to your hierarchy and remove it on hide |
| `console.log` | `onConsoleMessage` | Not surfaced to logcat by default — wire it, you will need it |
| Load progress | `onProgressChanged` | No progress UI |
| `target="_blank"` / `window.open()` | `onCreateWindow` | "The default implementation of this method does nothing and hence returns `false`." Requires `setSupportMultipleWindows(true)`; you must create a WebView and hand it over via `resultMsg`/`WebViewTransport.setWebView` |
| Geolocation | `onGeolocationPermissionsShowPrompt` + `setGeolocationEnabled` | Not granted |
| Window close | `onCloseWindow` | Nothing |

Two explicit warnings worth heeding from the docs:

- `addJavascriptInterface` is injected "into **all frames** of the web page, including all the iframes … Because the object is exposed to all the frames, any frame could obtain the object name and call methods on it. **There is no way to tell the calling frame's origin from the app side**, so the app must not assume that the caller is trustworthy unless the app can guarantee that no third party [content is loaded]".
- "**Note:** There is no trustworthy way to tell which page requested the new window: the request might originate from a third-party iframe inside the WebView." (on `onCreateWindow`)

Sources: [`WebChromeClient`](https://developer.android.com/reference/android/webkit/WebChromeClient) · [`WebView.addJavascriptInterface`](https://developer.android.com/reference/android/webkit/WebView#addJavascriptInterface(java.lang.Object,java.lang.String))

### F3. `WebViewClient` — what breaks if you don't set one

- **Link navigation.** "For security reasons, the system's browser app doesn't share its application data with your app. To open links tapped by the user, provide a `WebViewClient` for your WebView using `setWebViewClient`. All links the user taps load in your WebView. If you want more control over where a clicked link loads, create your own `WebViewClient` that overrides the `shouldOverrideUrlLoading` method." Use `shouldOverrideUrlLoading(WebView, WebResourceRequest)` (API 24+); the `String` overload is deprecated. **This is your origin allowlist hook — return `true` for anything outside `http://127.0.0.1:<port>`.**
- **SSL errors.** `onReceivedSslError`: "Warning: Application overrides of this method can be used to display custom error pages or to silently log issues, but the host application should **always** call `SslErrorHandler#cancel()` and **never** proceed past errors. … **Do not prompt the user about SSL errors.**" The default is to cancel.
- `onPageStarted` / `onPageFinished`, `onReceivedError`, `onReceivedHttpError`, `shouldInterceptRequest`, `doUpdateVisitedHistory` — instrumentation; `shouldInterceptRequest` is where you could block off-origin subresources at the network layer.
- `onRenderProcessGone` (API 26+): the renderer can be killed under memory pressure; the WebView instance becomes unusable and you must recreate it. Plan for this — it is the WebView equivalent of a tab crash.
- Downloads: `setDownloadListener` — "Registers the interface to be used when content can not be handled by the rendering engine, and should be downloaded instead." Without a listener there is nothing to handle `Content-Disposition: attachment`, so a download from the remote UI does nothing. Note also the newer `onShowFileChooser` doc says it "can be invoked both for uploads **and downloads**".
- WebView lifecycle: create and destroy on the UI thread; `WebView.saveState`/`restoreState` for config changes. "This method should be called before [the WebView] is destroyed" for `saveState`; the docs warn the restored state "could potentially leak files if `restoreState` was never [called]".

Sources: [`WebViewClient`](https://developer.android.com/reference/android/webkit/WebViewClient) · [`WebView`](https://developer.android.com/reference/android/webkit/WebView) · [Managing WebView objects](https://developer.android.com/develop/ui/views/layout/webapps/managing-webview) · [Building web apps in WebView](https://developer.android.com/develop/ui/views/layout/webapps/webview)

### F4. Keyboard, IME and edge-to-edge

- Set `android:windowSoftInputMode="adjustResize"` on the activity so the WebView shrinks above the IME; `adjustPan` will scroll the whole window and can push the focused field off-screen.
- **Android 15 (API 35) enforces edge-to-edge** for apps targeting it, so the WebView draws under the system bars and the IME. You must consume `WindowInsets` (or opt out via `windowOptOutEdgeToEdgeEnforcement` on API 35 only), otherwise the bottom of a desktop-width page — including a status/command bar or a send button — sits under the keyboard. See [Edge-to-edge](https://developer.android.com/develop/ui/views/layout/edge-to-edge).
- **Android 17 change:** "when the device's configuration changes (for example, through rotation), and this is not handled by the app itself, the previous IME visibility is not restored." Either set `android:windowSoftInputMode="stateAlwaysVisible"`, or re-request the soft keyboard in `onCreate()`/`onConfigurationChanged()`. [Android 17 behaviour changes](https://developer.android.com/about/versions/17/behavior-changes-all)
- Hardware keyboards/mice work through normal Android input dispatch; you likely want `setSupportZoom`/`setBuiltInZoomControls` decisions and a `WebView` inside a `NestedScrollView`-free layout (WebView handles its own scrolling).

### F5. Clipboard and other secure-context APIs

`http://127.0.0.1` is a **potentially trustworthy origin** (Secure Contexts §3.1 step 4), so `isSecureContext === true`, and `crypto.subtle`, service workers, and `[SecureContext]`-gated APIs are exposed — which is a genuine advantage of the loopback design over, say, `file://` content. `navigator.clipboard` requires both a secure context and a focused document with transient user activation for write; because the origin qualifies, it *should* work. **UNVERIFIED:** I found no Android-specific documentation of `navigator.clipboard` behaviour inside `WebView`, and WebView has historically differed from Chrome on permission-gated web APIs (compare `onPermissionRequest`, whose default is "deny"). Test clipboard read/write on your minimum supported WebView version and provide an Android-side fallback (`WebChromeClient` + `ClipboardManager`) if it matters.

Sources: [W3C Secure Contexts §3.1](https://w3c.github.io/webappsec-secure-contexts/#is-origin-trustworthy) · [Chromium Mixed Content](https://w3c.github.io/webappsec-mixed-content/)

### F6. `<textarea>` / `contenteditable` / rich editors

**UNVERIFIED.** I could not locate specific, citable Chromium issue-tracker entries for WebView IME composition bugs in `<textarea>`/`contenteditable` within the time available. What I can state from official documentation is the surrounding, verified context:

- IME composition in a WebView is mediated by Chromium's Android IME bridge, and Android 17 changes IME-visibility restoration after configuration changes (F4).
- `input`/`beforeinput` event semantics and IME composition differ from desktop Chrome in ways that are not documented by Google for WebView.

**Recommendation:** treat this as an empirical test item, not a documented one. If the remote UI has a rich editor, test with at least one IME that does multi-stage composition (e.g. a CJK IME and a gesture-typing IME) on your minimum and maximum API levels.

### F7. File upload and download

- **Upload:** implement `onShowFileChooser` and call `filePathCallback` with the chosen `Uri[]`, honouring `FileChooserParams.getAcceptTypes()`, `getMode()`, and multiple-selection. Note the security caveat: "**WebView does not enforce any restrictions on the chosen file(s). WebView can access all files that your app can access.** In case the file(s) are chosen through an untrusted source such as a third-party app, it is your own app's responsibility to check what the returned `Uris` refer to."
- **Download:** wire `setDownloadListener`, or use `onShowFileChooser` per the updated docs, and hand the bytes to `DownloadManager` (which is itself subject to the cleartext policy) or write via `MediaStore`.
- If the remote UI offers "download the file", do not rely on default behaviour: the default is nothing.

Sources: [`WebChromeClient`](https://developer.android.com/reference/android/webkit/WebChromeClient) · [`WebView`](https://developer.android.com/reference/android/webkit/WebView) · [`<application>` / usesCleartextTraffic](https://developer.android.com/guide/topics/manifest/application-element)

---

## (G) Security: what is actually risky, and what to configure

### G1. Bind to `127.0.0.1` — but understand that "loopback" ≠ "only this app"

- Bind **`127.0.0.1`** (and optionally `::1`), **never** `0.0.0.0` / `::` / `InetAddress.getByName(null)`-with-wildcard. A wildcard bind exposes the tunnel's plaintext entry point to the whole LAN/Wi-Fi network and, on a hostile network, to anyone who can reach the device — with no TLS in the way.
- **Another app on the same device can connect to your `127.0.0.1:<port>`.** Android does not give each app a private loopback interface. The strongest official signal is the Android 17 change: "Beginning with Android 17, **cross-profile** loopback traffic is no longer permitted by default. **Loopback traffic within the same profile is not affected.**" — i.e. loopback is reachable across apps within a profile by default, and only *cross-profile* reachability is being closed. Also, the platform-wide assumption is that local connectivity is open to anything holding `INTERNET`: "Devices on a Local Area Network (LAN) can be accessed by any app that has the `INTERNET` permission."
  Sources: [Android 17 behaviour changes](https://developer.android.com/about/versions/17/behavior-changes-all) · [Local network permission](https://developer.android.com/privacy-and-security/local-network-permission)
- **Therefore: loopback binding is not authentication.** Any app on the device can port-scan `127.0.0.1` and reach your listener. Consequences:
  - Use an **unguessable, per-connection secret validated on every request**, not just on the first request. The `?token=` in the URL only protects the *initial* navigation; a hostile app can connect directly to the socket without it unless you require the credential on every HTTP request and on the WebSocket handshake.
  - **Randomize the port** (bind port 0 and learn the actual port) so a hostile app cannot target a fixed number. Do not reuse a well-known port.
  - **Reject requests whose `Host`/`Origin` is not your loopback origin.** This defeats DNS-rebinding-style attacks from a browser/WebView elsewhere on the device, which can reach `127.0.0.1` too.
  - **Do not expose a management/debug endpoint on the listener.**
  - Treat the tunnel's HTTP as hostile-input parsing: it is reachable by other apps.
- **UNVERIFIED:** whether `127.0.0.1` counts as a "local network address" for Android 16/17 Local Network Protections / `ACCESS_LOCAL_NETWORK`, and whether an unprivileged app can bind ports below 1024 on current Android. Test both on your minimum and maximum targets.

### G2. Settings that must be off / on

From the `WebSettings` reference and Android security guidance:

| Setting | Required value | Why (documented) |
|---|---|---|
| `setJavaScriptEnabled` | `true` — **only** because you load only your own trusted origin | "JavaScript is disabled in a WebView by default." |
| `setDomStorageEnabled` | `true` if the UI uses `localStorage`/`sessionStorage` | "The default value is `false`." |
| `setAllowFileAccess` | **`false`** | "To prevent possible security issues targeting `Build.VERSION_CODES.Q` and earlier, you should explicitly set this value to `false`." Default is `true` for target ≤ Q. |
| `setAllowFileAccessFromFileURLs` | **`false`** (deprecated API 30) | "Enabling this setting allows malicious scripts loaded in a `file://` context to access arbitrary local files including WebView cookies and app private data." |
| `setAllowUniversalAccessFromFileURLs` | **`false`** (deprecated API 30) | "Enabling this setting allows malicious scripts loaded in a `file://` context to launch cross-site scripting attacks, either accessing arbitrary local files including WebView cookies, app private data or even credentials used on arbitrary web sites." |
| `setAllowContentAccess` | `false` unless needed | reduces `content://` reachability |
| `addJavascriptInterface` | **do not use** | "This method can be used to allow JavaScript to control the host application. … Use extreme care when using this method in a WebView which could contain untrusted content." Injected into all frames; caller origin unknowable. |
| `setMixedContentMode` | leave at the default `MIXED_CONTENT_NEVER_ALLOW` | "Apps targeting `Build.VERSION_CODES.LOLLIPOP` default to `MIXED_CONTENT_NEVER_ALLOW`. … use of `MIXED_CONTENT_ALWAYS_ALLOW` is [discouraged]" |
| `setSafeBrowsingEnabled` | leave `true` | "Safe Browsing is enabled by default for devices which support it." |
| `setJavaScriptCanOpenWindowsAutomatically` | `false` | popups without a gesture |
| `setSupportMultipleWindows` / `onCreateWindow` | `false` unless the UI genuinely needs popups | opening a new window without careful UI "may mislead the user about which site they are viewing" |
| `setSavePassword` | leave disabled (deprecated) | handled by Autofill |
| `onReceivedSslError` | always `cancel()` | "never proceed past errors" |
| `setWebContentsDebuggingEnabled` | `false` in release | enables remote debugging of your WebView |

Also required by Android security guidance:

> "WebView objects in your app shouldn't let users navigate to sites that are outside of your control. Whenever possible, use an allowlist to restrict the content loaded by your app's WebView objects. In addition, **never enable JavaScript interface support unless you completely control and trust the content in your app's WebView objects.**"
> "If your app must use JavaScript interface support on devices running Android 6.0 (API level 23) and higher, use **HTML message channels** instead…"

i.e. if you need app↔web communication, use `WebView.createWebMessageChannel()` / `WebMessagePort` (or `androidx.webkit`'s `WebViewCompat.WebMessageListener`) rather than `addJavascriptInterface`.

Sources: [`WebSettings`](https://developer.android.com/reference/android/webkit/WebSettings) · [`WebView`](https://developer.android.com/reference/android/webkit/WebView) · [`WebViewClient`](https://developer.android.com/reference/android/webkit/WebViewClient) · [Security best practices — "Use WebView objects carefully"](https://developer.android.com/privacy-and-security/security-best-practices)

### G3. The token is the weak link

- The token travels in a URL. URLs leak through: the `Referer` header on any subresource request, `document.referrer`, the WebView's back/forward history, `WebView.saveState` bundles, and any logging/crash-reporting that captures URLs. Mitigate by making the token **single-use, short-lived, and bound to one connection**, and by rewriting the URL out of history once exchanged.
- Do **not** put the token in the fragment (`#`) expecting secrecy — fragments are visible to scripts and are preserved in history; they are only "safer" in that they are not sent to the server.
- The tunnel means the app is a **bearer of a remote session**. Treat the local listener as a public interface on the device (G1) and require the per-request credential.
- Do not disable certificate validation anywhere: if you ever terminate TLS on the local listener with a self-signed certificate, the only ways to make the WebView accept it (`onReceivedSslError` → `proceed()`, or a permissive `TrustManager`) are exactly what the docs say never to do. Prefer plain HTTP on loopback with a per-request secret, which is what the Android platform itself treats as a trustworthy origin.

---

## Top 5 things that could make this fail in practice

1. **Cleartext policy on API 28–36 silently blocks the initial navigation.** With `targetSdk ≥ 28` and no explicit opt-in, `http://127.0.0.1:<port>` is refused by `NetworkSecurityPolicy` (verified: Chromium's `AndroidNetworkLibrary.isCleartextPermitted(host)` calls straight into it). This is the most likely "it just shows a blank page / error" failure, it is version-dependent, and on API 37+ there is a documented implicit loopback exemption whose exact interaction with a `base-config` I could **not** verify. Fix: explicit `domain-config cleartextTrafficPermitted="true"` for `127.0.0.1`, `localhost`, `[::1]`, and test on API 28, 33, 34, 35/36 and 37.

2. **The background/lifecycle problem has no clean answer.** The cached-apps freezer "terminates any active TCP sockets maintained by the app" once all its processes are frozen (Android 11+, hardened in 14+), so background SSH cannot survive without a foreground service; `dataSync` is capped at 6 hours/24h on Android 15+ and cannot be started from `BOOT_COMPLETED`; the only type without runtime prerequisites is `specialUse`, which is Play-Console-reviewed; background FGS starts are broadly prohibited so the service must be started from a visible activity; and Doze "suspends network access" while the Play-policy escape hatch (`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`) is not on the acceptable-use list for an SSH tunnel. A "works reliably for a whole working day with the screen off" claim is the hardest part of this design, and it is a policy problem as much as a technical one.

3. **A hand-rolled HTTP/1.1 proxy written against the happy path will break real web apps.** The failure modes are concrete and each is a documented RFC requirement: buffering instead of flushing (kills SSE and long-poll), not parsing/generating `Transfer-Encoding: chunked`, delimiting a response by socket close (breaks keep-alive), dropping the `Upgrade: websocket` handshake headers or re-framing after `101` (kills WebSockets), ignoring `Expect: 100-continue` (stalls uploads), closing on half-close (breaks request-body signalling), one-connection-at-a-time accept loops (hangs a page with dozens of subresources), unbounded buffering (OOM under backpressure), and rewriting/omitting `Host`/`Origin` so the remote server's vhost or CSRF check rejects everything. Any absolute `wss://`/`https://` URL emitted by the remote UI bypasses the tunnel entirely.

4. **Session/cookie semantics are subtler than they look, and there is no ephemeral WebView profile.** `Secure` cookies over `http://127.0.0.1` do work in Chromium (verified in source: localhost is classified `kTrustworthy`, and RFC 6265bis explicitly permits localhost as a trusted host), but this is an implementation detail tagged with a `WARN_TENTATIVELY_ALLOWING_SECURE_SOURCE_SCHEME` warning; `SameSite=None` requires `Secure`; third-party cookies default to **disallowed** for `targetSdk ≥ 21` per WebView; `Domain=127.0.0.1` is a hazard, so emit host-only cookies; `localStorage` does nothing until you call `setDomStorageEnabled(true)`; and there is **no incognito mode** — the closest thing is an `androidx.webkit` named `Profile` that you must delete yourself, with `setProfile` constrained to "before doing anything else with WebView". Any plan that assumes "the cookie dies with the WebView" needs re-checking.

5. **A desktop-oriented web app in a phone-sized WebView needs a lot of wiring, and one piece cannot be fixed by wiring.** Viewport is only partly controllable (`setUseWideViewPort(true)` gives a wide viewport *only if the page declares no viewport width*); the UA can be overridden but changing it mid-load triggers a reload; uploads need `onShowFileChooser` ("The default behavior is that WebView will cancel all file requests"), downloads need `setDownloadListener`, fullscreen needs `onShowCustomView`/`onHideCustomView`, permission prompts are **denied by default** (`onPermissionRequest`), popups do nothing by default (`onCreateWindow` returns `false`), and Android 15's enforced edge-to-edge plus the Android 17 IME-visibility change make keyboard handling actively hostile to a desktop-style layout. And rich-text/`contenteditable` IME behaviour inside WebView is something I could **not** verify either way — budget for real-device testing with multiple IMEs.

---

## What I could NOT verify

Items below are either absent from official documentation, contradicted/ambiguous between sources, or verified only in source without a runtime test. Each needs an on-device experiment before it is relied on.

1. **Where the API-37 implicit localhost network-security config is implemented.** The documentation states the behaviour; I grepped AOSP `main` (`ApplicationConfig`, `NetworkSecurityConfig`, `ManifestConfigSource`, `XmlConfigSource`, `NetworkSecurityConfigProvider`) and found no localhost/loopback special-casing. So the doc's wording is citable but the implementation location is unconfirmed.
2. **Whether a `<base-config cleartextTrafficPermitted="false">` counts as "a configuration … defined for localhost"** on Android 17 (API 37)+ — i.e. whether the implicit cleartext-permitting localhost config survives an explicit restrictive base-config. Genuinely ambiguous in the docs; write the explicit `domain-config` instead.
3. **No empirical device/emulator test of `http://127.0.0.1` in WebView on any API level.** All of (A) is documentation + Chromium/AOSP source reasoning. I did not run an app, and I did not confirm the exact error surfaced to `onReceivedError` (`ERR_CLEARTEXT_NOT_PERMITTED` or otherwise) for a blocked loopback navigation.
4. **Whether Android WebView is in scope for Chrome's third-party-cookie deprecation (3PCD).** No authoritative statement found; only `setAcceptThirdPartyCookies` semantics are documented.
5. **Whether `SameSite=None; Secure` set from `http://127.0.0.1` is actually accepted rather than silently downgraded to `Lax`.** The spec (`secure-only-flag` is the gate) plus Chromium's `kTrustworthy` source classification strongly imply acceptance, but I did not test it and found no doc that says so in as many words.
6. **Whether loopback counts as a "local network address" for Local Network Protections / `ACCESS_LOCAL_NETWORK`** (Android 16 opt-in, mandatory for targetSdk 37+ from Android 17). The official page's impact table says "Accepting an incoming TCP connection — yes" but the whole page is framed around LAN, and loopback is never mentioned.
7. **Whether an unprivileged Android app can bind a port below 1024.** Not verified; assume privileged ports are unavailable and use an ephemeral high port.
8. **Whether WebView ever attempts HTTP/2 over cleartext (h2c) to an `http://` origin.** Not verified in Chromium source. An HTTP/1.1-only listener is expected to suffice; detect the h2c preface if you want certainty.
9. **`navigator.clipboard` behaviour in WebView.** `http://127.0.0.1` is a secure context per spec, but I found no Android/WebView documentation of the Clipboard API, and WebView's history of denying permission-gated web APIs by default (`onPermissionRequest`) makes this worth testing rather than assuming.
10. **Specific known WebView IME/`contenteditable`/`<textarea>` defects.** I did not locate citable issue-tracker entries, so I have deliberately made no bug claims. Related and unverified: whether Android 17's restored-IME behaviour change affects WebView specifically.
11. **Exact on-disk paths for WebView cookies and `localStorage`.** Google does not document them; only `setDataDirectorySuffix` is public API.
12. **Whether session cookies survive a process restart without an explicit `CookieManager.flush()`.** The safe assumption (they may) is what I recommend, but I found no statement either way.
13. **Presence/absence of a `WebStorage`-level guarantee equivalent to `flush()`** — `WebStorage.deleteAllData()` exists, but I did not verify its durability semantics or whether it interacts with a named `Profile`.
14. **Whether `ProfileStore`/`MULTI_PROFILE` is available on the WebView versions you will actually ship to.** The API is `@RequiresFeature(WebViewFeature.MULTI_PROFILE)` and must be feature-checked with `WebViewFeature.isFeatureSupported`; I did not establish the minimum WebView APK version that guarantees it on real devices.
15. **Play Console's actual review outcome** for a `specialUse` foreground service whose stated purpose is an SSH tunnel. The documentation only says such declarations "are reviewed"; I cannot predict approval.
16. **Chromium's background/hidden-page timer throttling behaviour for a WebView that is attached but not visible.** I asserted the consequence (don't rely on WebView-resident JS for liveness) from the freezer documentation, not from a Chromium timer-throttling citation.
