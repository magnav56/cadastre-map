# Cadastre Map

A Google Maps-style web app that shows Québec's cadastral lots and your location. Tap a lot to see its number, size and location. It's a web app that installs on iPhone and Android from the browser, with no app store, Mac, Apple developer account, API key or backend.

## Requirements

- [Node.js](https://nodejs.org/) 24 or newer
- A free [GitHub](https://github.com/) account, to host the app for your phone
- For the Android emulator only: [Android Studio](https://developer.android.com/studio), with `adb` on your `PATH`

## Run it on your computer

```powershell
npm install
npm run dev
```

Open <http://localhost:5173>. Lots appear once you zoom in to neighbourhood level.

To check the production build:

```powershell
npm run build
npm run preview
```

## Run it on the Android emulator

1. In Android Studio, open **Device Manager** and start a device that includes Chrome, such as one with Google Play.
2. In this folder, run:

   ```powershell
   npm run android
   ```

   This builds the app, forwards the emulator's `localhost` to your PC, and serves the app. Leave it running.

3. In the emulator, open Chrome and go to <http://localhost:4173>. Use `localhost`, not `10.0.2.2`, because Chrome only allows location on `localhost` or HTTPS.
4. Tap **Allow while visiting the site** when asked for your location.
5. In the emulator's toolbar, open **... (Extended controls) > Location**, search for a place in Québec, and select **Set location**.

   Or set it from a terminal, giving longitude first: `adb emu geo fix -71.208 46.812`

To install it in the emulator, open Chrome's **⋮** menu and select **Add to Home screen**, then **Install**.

If you restart the emulator, stop and rerun `npm run android`, because the port forwarding is lost.

## Put it on your phone

Phones only give web pages your location over HTTPS, so the app has to be hosted. GitHub Pages does this for free, and this repo already includes the deployment workflow.

### 1. Publish the app

1. Create a new repository on GitHub named `cadastre-map`. Leave it empty.

   On a free GitHub account, Pages needs a **public** repository. Your code is then public, but nothing about your location is: it stays on your phone.

2. In this folder, run the following, replacing `YOUR-USERNAME`:

   ```powershell
   git init -b main
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/YOUR-USERNAME/cadastre-map.git
   git push -u origin main
   ```

3. On GitHub, open the repository's **Settings > Pages** and set **Source** to **GitHub Actions**.
4. Open the **Actions** tab. If the first run failed because Pages wasn't enabled yet, open it and select **Re-run all jobs**.

The app is then live at `https://YOUR-USERNAME.github.io/cadastre-map/`. Every later push to `main` redeploys it.

### 2. Install it on Android

1. Open that URL in **Chrome** on your phone.
2. Tap the **⋮** menu, then **Add to Home screen**, then **Install**.
3. Open **Cadastre** from your home screen and allow location when asked.

If location doesn't work, check that location is on in your phone's settings, and that Chrome has location permission under **Settings > Apps > Chrome > Permissions**.

### 3. Install it on iPhone

1. Open that URL in **Safari** on your iPhone.
2. Tap **Share**, then **Add to Home Screen**, then **Add**.
3. Open **Cadastre** from your Home Screen and tap **Allow** when asked for your location.

If location doesn't work, check **Settings > Privacy & Security > Location Services**. Location Services must be on, and **Safari Websites** must be set to **While Using the App**.

## Using it

- The map centres on you when it opens. The button at the bottom right recentres it and follows you as you move.
- The layers button above it switches between the plan and satellite maps. The app remembers your choice.
- Tap a lot to highlight it and open a card at the bottom of the screen with:
  - its number. Lots starting with `PC-` are complementary plans, used for condos and other properties divided by floor.
  - its area and perimeter, calculated from the outline.
  - its municipality, MRC and region.
  - the nearest street address known to OpenStreetMap. This may belong to a neighbouring lot.

  Tap **×** to close the card.
- Pinch to zoom, and rotate with two fingers. Tap the compass to point north again.
- The arrow on your location dot shows where the phone is pointing. On iPhone, tap the map once and allow **Motion & Orientation Access** to turn it on. If the arrow looks wrong, move the phone in a figure 8 to recalibrate its compass.

## Limitations

- **Not a legal boundary.** The government data is indicative, and so are the area and perimeter calculated from it. Only a land surveyor's boundary determination establishes the true limit of a lot. Lots can also be visibly offset from the base map.
- **Renovated cadastre only.** The source layer covers the "cadastre rénové". Areas not yet renovated may show no lots. For official records, use [Infolot](https://www.quebec.ca/habitation-territoire/information-fonciere/cadastre/consulter-cadastre).
- **Location accuracy is limited by the phone.** The app smooths your location, but a browser can't reach better than the phone's own fix, typically a few metres outdoors and worse under trees or near buildings. Don't use it to place a boundary.
- **Internet required.** There is no offline mode.
- **Third-party services.** The app depends on the free services below, and none of them guarantees uptime. If the cadastre service is down, the app says so and the base map keeps working.

## Data and technology

| Part | Choice |
| --- | --- |
| Map engine | [MapLibre GL JS](https://maplibre.org/) |
| Base map | [OpenFreeMap](https://openfreemap.org/) "Liberty" style, using OpenStreetMap data |
| Satellite | [Esri World Imagery](https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9) |
| Cadastre | [`Cadastre_allege`](https://geo.environnement.gouv.qc.ca/donnees/rest/services/Reference/Cadastre_allege/MapServer) service, © Gouvernement du Québec |
| Municipality, MRC and region | [TerrAPI](https://geoegl.msp.gouv.qc.ca/apis/terrapi/), Gouvernement du Québec |
| Nearest address | [Nominatim](https://nominatim.org/), using OpenStreetMap data |
| Build | Vite and TypeScript |
| Hosting | GitHub Pages |

The Québec service publishes no explicit licence, only a copyright notice. This app is meant for personal use.

See [PLAN.md](PLAN.md) for the development plan.
