# Copy Check

A library plugin for Experience Workspace (da.live) that checks the copy in the selected block, or in the whole page, and lets the author apply a correction in place. Sapling supplies grammar and spelling. The site config supplies the brand terms. The governance agent keeps the verdict.

Implements the design plan *Copy Check: a Sapling extension for Experience Workspace*, version 0.1.

![Copy Check in Experience Workspace: the selected Tabs activity block, checked by Sapling, with in-place fixes](docs/images/block-view.png)

## What authors see

**Block view.** Place the cursor in a block (above, the *Tabs activity* block on the WKND Adventures home page) and click **Check block**. Each finding names its cell, marks the words, shows the suggestion and says where it comes from: Sapling, the site's house style, or a built-in check. **Apply** writes the fix straight into the block; undo works as usual. Nothing is checked as you type.

**Page view.** **Check page** covers every block, every run of default content, and the fields authors forget: the page title, the meta description and alt text. It shows counts by severity (never a score), what a check will cost in characters, and ends with the hand-off to a governance check.

![Page view: the fields authors forget, then every block and run of copy with counts by severity](docs/images/page-view.png)

| Findings in another block | Settings (administrators) |
| --- | --- |
| ![A finding with its suggestion, Apply and Ignore](docs/images/findings.png) | ![Settings: key status, provider, endpoint, usage meter, canvas agent and apply-all policy](docs/images/settings.png) |

With the canvas agent installed (step 3 of setup), **Apply** on a finding in another block selects that block for the author and fixes it in place. Without it, as on the site above, the button reads **Apply and reload**, and clicking into the block first fixes it in place instead.

Like Block Source, Copy Check is an App Builder app. A small broker on Adobe App Builder holds the Sapling key, and the plugin never sees it. The same app also serves the plugin, so a site needs no copy of it.

```
 Experience Workspace                                   App Builder (I/O Runtime)
 ┌──────────────────────────────────────┐
 │ editor ◄─ SDK port ─► library plugin │──► copy-check/api ──► Sapling (POST /api/v1/edits only,
 │  (sendHTML replace,   copy-check.js  │      │                  HttpExponentialBackoff)
 │   liveDocument)                      │      ├─ checks the DA token ─► admin.da.live
 └──────────────────────────────────────┘      ├─ aio-lib-files: encrypted key, site dictionary
                                               └─ aio-lib-state: usage meter, rate limits, cache
```

| Path | What it is |
| --- | --- |
| `plugin/tools/copy-check/` | The plugin: `copy-check.html`, the panel controller `copy-check.js`, and `lib/` (units and run index, findings, terms, local rules, providers, cache, apply). `aio app deploy` publishes it to the app's static hosting. |
| `plugin/test/` | Plugin tests (node:test + linkedom). |
| `broker/` | The App Builder project: the `copy-check/api` web action, and static hosting for the plugin (`hooks/build-static.js`). |
| `broker/test/` | Broker tests with a fake DA admin and Sapling, plus one run of the real `HttpExponentialBackoff`. |
| `dev/` | Mock Experience Workspace host, mock DA Admin and mock Sapling, and a local server for the broker action. |

## Gate zero: can the plugin replace a span in place?

**Yes, per block.** The current DA App SDK (`https://da.live/nx/utils/sdk.js`) and the canvas host (`adobe/da-live` `blocks/canvas/ew-panel-extensions/iframe-protocol.js`, documented in `adobe/da-nx` `docs/sdk-messaging.md`) provide:

| Capability | What it gives the plugin |
| --- | --- |
| `subscribeLiveDocument` (`capabilities.liveDocument === 1`) | The full live `<main>` HTML on every change, plus `selection.blockIndex`: the zero-based ordinal of the selected block, counting every block except `metadata` and `section-metadata`. |
| `sendHTML(html, { replace: true, expected })` (`capabilities.sendHTMLReplace === 1`) | Replaces the **selected block** (or, outside a block, the enclosing paragraph, heading or list) as one editor transaction, so it is one undo. `expected: { html, blockIndex }` makes the host refuse with `STALE_LIVE` or `WRONG_SELECTION` if the document or selection moved. |
| `saveDocument()` | Persists the live editor before a source write. |
| DA Admin `POST /source/...` with `If-Match` | Conditional source writes; the write notifies collab (`syncadmin`), which reloads open editors. |

So the product is **route A** (in place) for the selected block, with **route B** (guarded source write) as the fallback:

- **Route A** applies when the finding's block is the selected block. The plugin rebuilds that block's HTML from the exact snapshot it mapped against, and sends one guarded replace. The cursor is kept and undo works.
- **A finding in another block** still goes straight into its block: **Apply** selects the block for the author, then replaces it in place. The panel cannot move the editor's selection itself, but the canvas can. Experience Workspace's quick-edit script in the canvas turns a press on a block (`[data-block-index]`) into `NODE_SELECT`, and the editor selects that block. Copy Check's canvas agent (step 3 of setup) dispatches that press for the block's `data-block-index`, which the live document reports. The panel waits for the editor to report the new selection before the guarded replace. A nested block selects, and replaces, its outermost block, as the host does. Without the agent, the author clicks into the block first, or uses **Apply and reload** (route B).
- **Route B** applies to default content, the metadata block, block findings on a site without the canvas agent, and hosts without `sendHTMLReplace`. Page-wide "apply all" fixes each block in place (selecting it first), then writes the rest in one source write. Steps: `saveDocument()`, read the source with its ETag, re-validate every finding against that exact text, write with `If-Match`. On a 412 it re-reads, re-maps, and reports what could no longer be applied. It never overwrites. If the same text appears in more than one unit and those copies moved since the check, the finding is skipped as ambiguous rather than applied to the wrong copy. After a write, further applies stay disabled until the editor has reloaded with the corrected text, so a stale editor is never saved over the write.
- The `expected` guard only accepts a non-negative block index, so default content cannot be replaced in place safely. That is why default content uses route B.
- **Route C** (report only) is never the product. Advisory findings with nothing to apply (for example "best in class") are shown, but every finding that has a replacement can be applied.

## Setup

### 1. Deploy the app (broker and plugin)

Sites normally use the shared deployment at `https://28538-copycheck.adobeio-static.net` and can skip to step 2. To run your own copy:

```sh
cd broker
cp .env.example .env            # set COPYCHECK_ENCRYPTION_KEY (see the comment in the file)
npm install
aio login && aio app use        # select the org, project and workspace
aio app deploy
```

This deploys the action and the plugin together:

- Plugin: `https://{namespace}.adobeio-static.net/copy-check.html`
- API: `https://{namespace}.adobeio-static.net/api/v1/web/copy-check/api` (also at `https://{namespace}.adobeioruntime.net/api/v1/web/copy-check/api`)

The build hook copies `plugin/tools/copy-check/` as-is (no bundling) and writes the API URL into the plugin's `copy-check-broker` meta tag. So the plugin only ever sends the author's IMS token to the broker it was deployed with: the broker URL cannot come from site config or the page URL. One deployment serves every site, and the site comes from the DA SDK context.

| Variable / input | Where | Purpose |
| --- | --- | --- |
| `COPYCHECK_ENCRYPTION_KEY` | `.env` (required) | 32 random bytes, base64. Wraps the per-site data keys that encrypt each site's Sapling key (AES-256-GCM envelope encryption, bound to `{org}/{site}`). Rotating it makes stored keys unreadable, so admins must set them again. |
| `ALLOWED_ENDPOINT_HOSTS` | `app.config.yaml` | Provider hosts the broker may call. Add a self-hosted Sapling host here. It is not a general proxy: only `POST /api/v1/edits` is ever called. |
| `DEFAULT_MONTHLY_BUDGET` / `MAX_MONTHLY_BUDGET` | `app.config.yaml` | Characters per site per month when the site sets none, and a ceiling no site can exceed. |
| `USER_REQUESTS_PER_MINUTE` / `USER_CHARS_PER_MINUTE` | `app.config.yaml` | Per-user rate limit. |
| `DA_ADMIN_URL` | `app.config.yaml` | Where callers are validated. |

### 2. Add the panel to the site config (`https://da.live/config#/{org}/{site}/`)

Nothing goes into the site's code repository.

**library** sheet, one row:

| title | path | experience |
| --- | --- | --- |
| Copy Check | `https://28538-copycheck.adobeio-static.net/copy-check.html` | dialog |

That is the shared deployment (App Builder project **CopyCheck**, workspace Production, org Adobe Production Demo - AGS050). A self-hosted copy uses its own `https://{namespace}.adobeio-static.net/copy-check.html`.

**data** sheet (pointers, not secrets):

| key | value | notes |
| --- | --- | --- |
| `copycheck.provider` | `sapling` | |
| `copycheck.endpoint` | `https://api.sapling.ai` | Or the self-hosted host (must be in `ALLOWED_ENDPOINT_HOSTS`). |
| `copycheck.budget` | `5000000` | Characters a month. Match the Sapling spend alert. |
| `copycheck.language` | `en-AU` | Maps to Sapling `lang` + `variety`. |
| `copycheck.applyall` | `spelling, term-case` | Classes "Apply all safe fixes" may apply: `spelling`, `grammar`, `style`, `term-case`, `term-wording`. |
| `copycheck.skipblocks` | `product-specs, embed` | Blocks whose values a connected system owns. Never sent or changed. |
| `copycheck.protect` | `\b[A-Z]{3}-\d{4}\b` | Pattern for product codes and similar. Masked before sending; findings touching a match are dropped. |
| `copycheck.governance` | `Run a governance check on {path}` | The prompt the handoff places in chat. |

**terms** sheet (the house style layer, maintained by the customer):

| term | type | replacement | note |
| --- | --- | --- | --- |
| AEM | use carefully | Adobe Experience Manager | Spell out on first use |
| best in class | do not use | | Not an approved claim |
| click here | do not use | the link text | Accessibility |
| Edge Delivery Services | approved | | Capitalise all three words |

Types: `approved` flags any other casing or spacing. `do not use` flags every use. `use carefully` flags the first use on the page, unless the replacement appears earlier.

### 3. Let Copy Check select blocks for authors (recommended)

Add this line to the site's `scripts/scripts.js`, outside any function, and commit it to `main`:

```js
if (window.top !== window) import('https://28538-copycheck.adobeio-static.net/agent.js').catch(() => {});
```

It loads only when the page is shown inside a frame, such as the Experience Workspace canvas, so site visitors never load it. It answers only the Copy Check panel in the same browser tab, for this site. It changes nothing on the page: it presses on the block that needs a fix, exactly as the author would. The agent reaches the panel through a hidden `bridge.html` from Copy Check's own origin and a `BroadcastChannel` (the same transport as Block Source's agent).

Without it, **Apply** on a finding in another block becomes **Apply and reload** (saved through the source). Clicking into the block first still fixes it in place. Settings shows whether the agent is connected.

### 4. Set the Sapling key

Create the key at sapling.ai with a service mailbox. A site administrator (anyone who can write the site config) opens the plugin, goes to **Settings**, and pastes the key. The broker validates it with one short call before it replaces the old key, so rotation has no gap. It stores the key encrypted under `keys/{org}/{site}.json` in the app's private file storage (envelope encryption: a fresh data key per record, wrapped by `COPYCHECK_ENCRYPTION_KEY`, bound to the site). The panel then shows only the last four characters. Set a spend alert in the Sapling account to match `copycheck.budget`.

## How it works

- **Live document** (`lib/units.js`). The SDK's live HTML is the editor's live-preview rendering. Section metadata arrives as classes on the section `<div>`, every block carries `data-block-index` (its editor position), and the page metadata block is removed. So every `<div>` under `<main>` is a section whatever its classes, and blocks are counted in document order, nested blocks included, to match `selection.blockIndex`. The page title and description are read from the saved page when the page is checked.
- **Text units** (`lib/units.js`). One paragraph, heading or list item of default content (`p:4`, `h1:0`, `li:2`), one text element of one cell (`cards:2:1`, `cards:2:1.1` for a cell's second paragraph, `cards.1:…` for the second cards block), one image's alt text (`…:alt`), one link's text (`…:a:0`), and `meta:title` / `meta:description`. A correction can never cross a unit. Never sent: block names and classes, section metadata, code and preformatted text, and skipped blocks. URLs, bare domains, emails, paths and `copycheck.protect` matches inside a unit are masked with same-length placeholders before sending, so offsets still line up.
- **Run index** (`lib/runs.js`). Whitespace is collapsed, and every character maps back to its text node (or alt attribute). A collapsed space remembers the whole source whitespace it stands for. A span that crosses formatting, a link or a `<br>` cannot be rejoined, so it is dropped and counted, never guessed.
- **Findings** (`lib/findings.js`). One model for every source. Severity is by field: spelling in an H1, the title or the meta description is `must`. Results are ranked by severity, then page order. There is never a score.
- **Providers** (`plugin/tools/copy-check/lib/providers.js`, `broker/lib/providers/`). Sapling runs through the broker. House style terms and built-in rules (link text, mismatched link destinations, missing alt text, missing description, repeated words, very long sentences) run in the browser for free, and keep working when the provider does not.
- **Cost control**. Checks run only on request, including the free local checks. Findings are a snapshot of the last check; editing a unit drops its findings and flags it "changed since the check". Each unit is sent once per distinct text, under a SHA-256 content-hash id: no page path, no block names, no author identity. There are two caches, both scoped to the site and the provider endpoint: the browser's, and a site-wide cache in the broker keyed on a hash the broker computes itself, so one author cannot poison another's results. The broker reserves characters against the site's monthly budget (in `aio-lib-state`) before calling Sapling. `aio-lib-state` has no atomic increment, so two checks that start at the same instant can overshoot the cap by at most one request (60,000 characters) each. It bills conservatively: text that may have reached the provider counts, even if the answer was lost, and only refusals (bad key, spent quota, connection never made) are refunded. It hard-stops with the reset date. The page view shows how many characters a check will send.
- **Failure modes**. With no key, the budget spent, or the provider down, the panel says so and the term checks still run. When the provider is unavailable, cached findings are shown with their age, with a retry. A concurrent edit makes route A refuse (`STALE_LIVE`), and makes route B re-read and report what was not applied.
- **Handoff**. The page view ends with "N things to fix. When they are clear, send this page for a governance check." Its button places a prompt in the EW chat (`actions.setPrompt`). The plugin never passes, fails, or blocks publish.

## Local development

```bash
npm install && (cd broker && npm install)
npm run dev          # mock host + DA on :3400, mock Sapling on :3401
npm run dev:broker   # the broker action on :8790, in-memory state, key from broker/.env
open http://127.0.0.1:3400/dev/host.html            # admin (dev-admin token)
open http://127.0.0.1:3400/dev/host.html?as=author  # author
open http://127.0.0.1:3400/dev/host.html?agent=0    # a site without the canvas agent
open http://127.0.0.1:3400/dev/host.html?legacy=1   # host without liveDocument/sendHTMLReplace
```

In Settings, set the key `dev-sapling-key-1234`. `dev/broker-server.mjs` invokes the real action handler the way I/O Runtime does (`__ow_method`, `__ow_path`, base64 body). The mock host implements the real port protocol: the ready handshake, `liveDocument`/`liveSelection`, the guarded replace, `saveDocument`, `setPrompt`, and a collab-style reload when the source changes. Below the editor, a mock canvas (`dev/canvas.html`) renders the live document, loads the agent as a site would, and emulates quick-edit's `NODE_SELECT`. The host runs on `127.0.0.1`, the plugin on `localhost` and the canvas on `[::1]`. That makes all three cross-site, as `da.live`, the plugin and the canvas are in Experience Workspace, which matters because `BroadcastChannel` is partitioned by top-level site and cross-site ancestry. Its log strip shows every protocol event. On localhost only, the plugin accepts `?broker=` (pointing at localhost) instead of the stamped meta tag, and exposes its state as `window.copyCheckState`.

To run against real `aio-lib-state` and `aio-lib-files`, use `aio app dev` in `broker/` and open the plugin with `?broker=` set to its localhost URL.

Tests:

```bash
npm test               # plugin and broker
npm run test:plugin    # units, run index, terms, rules, policy, apply routes A/B, provider, cache
npm run test:broker    # caller validation, key handling, budget, billing with retries, rate limit, cache, allow list
```

## Plan coverage

| Phase | Status |
| --- | --- |
| 0. Gate zero | Done. Answer above. |
| 1. Shell, broker with key and budget, units and run index, block view, Sapling, local term layer, apply one finding | Done |
| 2. Page view; alt text, link text and metadata checks; caching by content hash; apply all with the policy; usage meter | Done |
| 3. Provider interface, custom dictionary, governance handoff | Interface, site dictionary (authors add, admins remove) and handoff done. A second engine (WProofreader) is not built: add `broker/lib/providers/wproofreader.js` and register it in `providers/index.js`. |
| 4. Self-hosted endpoint, multilingual, site-wide scan with approval | Self-hosted endpoint works today (`copycheck.endpoint` plus `ALLOWED_ENDPOINT_HOSTS`). Per-unit language and the site-wide scan are not built. |

Items to validate (§17), as far as code can answer them:

1. Gate zero: answered above.
2. The SDK exposes the selected block's ordinal and the full live HTML. The plugin maps positions itself, from that HTML.
3. Alt text arrives as the `alt` attribute of `<img>` in both live and source HTML. Link targets arrive as `href`. Both have their own units.
4. Payload and latency: Sapling accepts up to 100,000 characters per call and recommends chunks of at most 4,000. The broker sends one request per unit, splitting units over 4,000 characters at sentence ends, with 4 in flight. The plugin batches at most 100 units or 40,000 characters per broker call. Real latency still needs measuring.
5. Language is per site (`copycheck.language`). A mixed-language page would need a per-unit language; not built.
6. Undo: route A is one editor transaction, so normal undo works. Route B relies on the DA version history.

Known gaps:

- Selecting a block for the author needs the canvas agent line in the site's `scripts.js`. The SDK has no action for it.
- Default content and metadata always use route B, which reloads the editor: the host's stale-document guard only works inside a block.
