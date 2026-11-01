# youDl landing page brief

## Product statement

User: “the exxtension is for downloading videos from youtube and other video sites but localy its personal not a third party service its for privacy”

Evidence from the repository: youDl is a browser extension plus a Native Messaging Host that runs yt-dlp on the user's machine. The browser launches the host on demand over standard input/output; the normal connection opens no local network port and needs no manually started server. The extension supports Chrome, Edge, Brave, and Firefox in developer mode. The installed extension is not listed in the Chrome Web Store or AMO. YouTube pages have an in-player control; URLs can also be pasted into the popup. Other-site support depends on yt-dlp and the website.

## Creative brief

The user asked for “a stylish landing page” with “a space for downloading the extension and see demo images too.” No references, assets preference, scroll order, feeling curve, or unique interaction were supplied. Creative choices below are authored from the request and existing product documentation. The design uses the existing dark slate and electric blue product palette. Demo media uses the user-supplied browser screenshot plus clearly identified interface previews made for this page.

1. **Vibe / references:** authored decision: assured, private, technical, editorial. Reference: the existing youDl interface in `scrensht.png` and `designSystem-Out/Design.md`.
2. **Visitor journey:** recognize the familiar video-save need; understand the local-only route; see the extension in context; inspect its controls; download the personal-use bundle and follow setup steps.
3. **Energy:** quiet typographic opening; a clear, memorable local-route interaction; calm, useful product demos; direct installation close.
4. **Feeling curve:**
   - Opening: curiosity, created by a sparse title page and a direct privacy promise.
   - Local route: relief, created by the browser-to-native-host-to-disk path lighting up while the cloud remains outside it.
   - In use: clarity, created by the actual popup and in-player workflow.
   - Demo gallery: confidence, created by concrete controls and visible download states.
   - Install: resolve, created by a real bundle and concise setup instructions.
5. **Peak:** “I watched the signal travel from my browser to my own computer, and it never went to a cloud.” Act: Local route.
6. **Signature move:** a visitor-operated route trace with selectable Browser, This computer, and Your files stops. The connection animates locally through Native Messaging and labels each hop; the crossed-out cloud never lights up.
7. **Aesthetic range:** authored decision: premium-minimal with a technical editorial character.
8. **Structure:** authored decision: distinct editorial chapters, because the product needs short explanations and accurate setup details. A continuous world would make the practical details feel like scenery.
9. **Existing assets:** `scrensht.png`, extension icons, existing popup HTML/CSS, repository README, and design tokens. No generated imagery.

## Journey and score

| Beat | Device | Why |
|---|---|---|
| Title page / recognition | Type-led flow, then cue | An unhurried title page establishes the product without placing media behind the promise. |
| Local route / turn | Bespoke route trace plus reveal | The path makes the privacy claim visible and gives the visitor agency. |
| In use / substance | Parallax inside the separate media column and reveal | The real screenshot stays legible while its framing shifts subtly. |
| Demo / range | Horizontal pan through three labeled product states | The visitor can inspect the popup, in-player control, and progress view. |
| Install / commitment | Flow with a persistent, resolved download panel | The bundle and setup steps are the final practical action. |

**Grammar:** chaptered editorial. The page uses a type-only title page, separate media columns, distinct section grounds, and a setup colophon. The other seven grammars fit less well: filmic one-shot would obscure the practical install information in one camera ride; live surface makes an explainer feel like a tool; continuous world needs one physical place rather than a privacy explanation and gallery; typographic poster is a single moment rather than a product journey; gallery/catalog treats features as objects instead of explaining the trust model; split stage makes the entire page a continuous comparison, which this product does not need; rhythmic cutlist makes the setup feel rushed.

**Feeling curve (written before the score):** curiosity → relief → clarity → confidence → resolve. The local-route interaction is the single peak and gets the most visual emphasis. The typographic opening is intentionally quiet, not dead scroll.

**Peak sentence:** “I watched the signal travel from my browser to my own computer, and it never went to a cloud.” Act: Local route.

**Tell-someone sentence:** “It’s the site where you can trace a video download from your browser to your own disk, with the cloud crossed out.”

## Fingerprint gate

Registry was empty before this build, so there were no prior rows to compare. Planned fingerprint: chaptered editorial; slim folio index; text-only title page; flow/reveal/parallax/pan chapters; download colophon; interactive local-route trace.

## Silence

The first screen is deliberately media-free. Its quiet gives the privacy route its turn. The demo imagery begins after the title page.

## Limits

The supplied screenshot shows the extension working on YouTube. The page describes other websites conditionally: yt-dlp support varies by site, and the user can paste a URL. The bundle is an unpacked personal-use download because this project is not published in browser marketplaces.
