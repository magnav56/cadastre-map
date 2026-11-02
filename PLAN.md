# Development plan

## Goal

See Québec's cadastral lots and your own location on a Google Maps-style map, on iPhone and Android, for free and for personal use. Anything beyond that is optional.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Phone delivery | One installable web app (PWA) for iOS and Android | Development happens on Windows. A native iOS app needs a Mac for Xcode and must be re-signed every 7 days without a paid Apple account. On Android, Chrome installs the PWA as a real app, so a separate native build adds nothing. |
| Map engine | MapLibre GL JS | Free, fast on phones, and supports smooth Google-style pinch, rotate and tilt. |
| Base map | OpenFreeMap "Liberty" | Needs no key or account. |
| Cadastre data | Live `Cadastre_allege` service | Free and public. Tested from Québec City, Montréal and Abitibi, and it allows browser requests, so no backend is needed. |
| Cadastre drawing | Server-drawn image tiles, tile size 512, at double DPI | Lot numbers come already drawn and sharp. A viewport at low zoom can exceed the service's 2,000-lot limit per request, which rules out drawing every polygon in the browser. |
| Lot selection | Point query on tap | Fetches only the tapped lot's outline for highlighting. |
| Hosting | GitHub Pages | Free HTTPS, which iOS requires for location. |

## Phase 1: Working app (done)

- [x] Project setup with Vite, TypeScript and MapLibre
- [x] Base map, cadastre overlay and live location
- [x] Tap a lot to highlight it and show its number
- [x] Layers button to switch between plan and satellite maps
- [x] Messages for zooming in, location denied and service unavailable
- [x] Home Screen metadata and icons
- [x] GitHub Pages workflow
- [x] Tested on the production build in Edge and in WebKit (Safari's engine) with an iPhone profile
- [x] Tested on the Android 16 emulator, in Chrome and installed as an app

## Phase 2: Real phone test (next)

- [ ] Deploy to GitHub Pages, following the README
- [ ] Install on iPhone from Safari and confirm the location prompt, following and the location dot
- [ ] Check the iPhone layout around the notch and home indicator
- [ ] Install on an Android phone from the hosted HTTPS URL, if you have one
- [ ] Walk a known property and judge how well lots line up with the map
- [ ] Open the app somewhere outside the tested cities and check rural coverage

Fix whatever this turns up before adding anything else.

## Phase 3: Optional improvements

In order of likely value:

1. **Search.** Find an address or lot number. Lot search can use the same service.
2. **Lot opacity slider.** Useful where lot numbers cover the map in dense areas.
3. **Coverage message.** Say when an area has no renovated cadastre, instead of showing an empty map.
4. **Offline use.** Save recently viewed tiles with a service worker. This is the largest item, because iOS limits browser storage.

## Risks

| Risk | Effect | Response |
| --- | --- | --- |
| The Environment ministry changes or restricts the service | Lots disappear | The URL is one constant in `src/main.ts`. The fallback is a small proxy on a free tier, or another government endpoint. |
| The service has no published licence | Access could be limited later | Personal, low-volume use only. Don't promote the app publicly. |
| OpenFreeMap is unavailable | No base map | Swap the style URL for another MapLibre-compatible style. |
| Esri restricts its free imagery | No satellite map; the plan map keeps working | The tile URL is one constant in `src/main.ts`. Keep use personal and low-volume. |
| iOS clears data for Home Screen apps | The location prompt may reappear | Harmless: the app stores nothing that matters. |
