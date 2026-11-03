import * as maplibregl from 'maplibre-gl';
import type {
  ErrorEvent,
  GeoJSONSource,
  MapMouseEvent,
  RasterTileSource,
  VectorTileSource,
} from 'maplibre-gl';
import { registerSW } from 'virtual:pwa-register';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { magvar } from 'magvar';
import 'maplibre-gl/dist/maplibre-gl.css';
import { watchCompass } from './compass';
import { LocationFilter } from './location-filter';
import { findNearestAddress, findPlace, formatArea, formatLength, measure } from './lot-details';
import type { Place } from './lot-details';
import {
  blocksIn,
  findSavedLot,
  loadDetails,
  loadLots,
  saveBlocks,
  saveDetails,
  tilesIn,
  type Lot,
  type SavedDetails,
} from './saved-lots';
import './style.css';

const BASEMAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const SATELLITE_TILES =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const CADASTRE_URL =
  'https://geo.environnement.gouv.qc.ca/donnees/rest/services/Reference/Cadastre_allege/MapServer';

// The service draws nothing past 1:30,000, which is tile zoom 14 at this tile size.
const CADASTRE_MIN_ZOOM = 14;
const TILE_SIZE = 512;
// Retina tiles: 1024px images at double DPI, displayed at 512px.
const CADASTRE_TILES =
  `${CADASTRE_URL}/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857` +
  `&size=${TILE_SIZE * 2},${TILE_SIZE * 2}&dpi=192&format=png32&transparent=true&f=image`;
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

// Lots in view are saved for offline use from this zoom, about one street wide on a phone.
const AUTO_SAVE_MIN_ZOOM = 15;
// "Save this area" covers the view from this zoom, which is a few kilometres across on a phone.
const SAVE_AREA_MIN_ZOOM = 12;
const SAVE_AREA_MAX_BLOCKS = 250;
const SAVED_LOTS_FONT = 'Noto Sans Bold';

// MapLibre 6 ships its worker as a separate file, which bundlers must be told about.
maplibregl.setWorkerUrl(workerUrl);
registerSW({ immediate: true });

const statusEl = document.querySelector<HTMLElement>('#status')!;
let locationError: string | null = null;
// True when the cadastre service can't be reached, so saved lots are shown in its place.
let cadastreUnreachable = false;
let notice: string | null = null;
let noticeTimer: number | undefined;

const usingSavedLots = () => !navigator.onLine || cadastreUnreachable;

const map = new maplibregl.Map({
  container: 'map',
  style: BASEMAP_STYLE,
  center: [-71.5, 47], // Québec, until the first location fix
  zoom: 6,
  attributionControl: { compact: true },
});

const geolocate = new maplibregl.GeolocateControl({
  positionOptions: { enableHighAccuracy: true },
  trackUserLocation: true,
  fitBoundsOptions: { maxZoom: 17 },
});

// The control has no hook for changing a fix, so wrap the handler it passes to watchPosition. That
// way the dot, the accuracy circle and the camera all use the filtered position.
const locationFilter = new LocationFilter();
const showFix = geolocate._onSuccess;
geolocate._onSuccess = (fix) => showFix(locationFilter.update(fix));

const headingArrow = document.createElement('div');
headingArrow.className = 'heading-arrow';
headingArrow.innerHTML = `
  <svg viewBox="0 0 20 14" width="20" height="14" aria-hidden="true">
    <path d="M10 2 18 12 10 9.5 2 12Z" />
  </svg>`;
let magneticHeading: number | null = null;
let declination: number | null = null;

// Rotating the dot itself keeps the arrow right as the map turns and tilts.
function updateHeadingArrow() {
  if (magneticHeading === null || declination === null) return;
  const dot = geolocate._userLocationDotMarker;
  if (!headingArrow.isConnected) {
    dot.getElement().append(headingArrow);
    dot.setRotationAlignment('map');
  }
  dot.setRotation(magneticHeading + declination);
}

watchCompass((heading) => {
  magneticHeading = heading;
  updateHeadingArrow();
});

map.addControl(new maplibregl.NavigationControl({ showZoom: false }), 'top-right');
map.addControl(geolocate, 'bottom-right');

let satellite = localStorage.getItem('basemap') === 'satellite';
const layersButton = document.createElement('button');

function applyBasemap() {
  const label = satellite ? 'Show plan map' : 'Show satellite map';
  layersButton.title = label;
  layersButton.setAttribute('aria-label', label);
  layersButton.setAttribute('aria-pressed', String(satellite));
  if (!map.getLayer('satellite')) return;

  map.setLayoutProperty('satellite', 'visibility', satellite ? 'visible' : 'none');
  // The service draws black lines and numbers with a white halo, which is hard to read on
  // imagery. Swapping these two inverts it to white on a dark halo.
  map.setPaintProperty('cadastre', 'raster-brightness-min', satellite ? 1 : 0);
  map.setPaintProperty('cadastre', 'raster-brightness-max', satellite ? 0 : 1);
  // Saved lots are drawn to match.
  map.setPaintProperty('saved-lots-line', 'line-color', satellite ? '#fff' : '#000');
  map.setPaintProperty('saved-lots-label', 'text-color', satellite ? '#fff' : '#000');
  map.setPaintProperty('saved-lots-label', 'text-halo-color', satellite ? '#000' : '#fff');
}

layersButton.type = 'button';
layersButton.className = 'layers-button';
layersButton.innerHTML = `
  <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
    <path d="M12 3 2 9l10 6 10-6-10-6Z" />
    <path d="m4.5 13.5-2.5 1.5 10 6 10-6-2.5-1.5-7.5 4.5-7.5-4.5Z" />
  </svg>`;
layersButton.addEventListener('click', () => {
  satellite = !satellite;
  localStorage.setItem('basemap', satellite ? 'satellite' : 'plan');
  applyBasemap();
});

const saveButton = document.createElement('button');
saveButton.type = 'button';
saveButton.className = 'save-button';
saveButton.title = 'Save this area for offline use';
saveButton.setAttribute('aria-label', saveButton.title);
saveButton.innerHTML = `
  <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
    <path d="M11 3h2v9.2l3.3-3.3 1.4 1.4L12 16l-5.7-5.7 1.4-1.4 3.3 3.3V3Z" />
    <path d="M4 15h2v4h12v-4h2v6H4v-6Z" />
  </svg>`;
saveButton.addEventListener('click', saveArea);

map.addControl(
  {
    onAdd() {
      const container = document.createElement('div');
      container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
      container.append(saveButton, layersButton);
      return container;
    },
    onRemove() {},
  },
  'bottom-right',
);
applyBasemap();

function updateStatus() {
  const zoomHint = map.getZoom() < CADASTRE_MIN_ZOOM - 0.5 ? 'Zoom in to see lots' : null;
  let offlineHint: string | null = null;
  if (usingSavedLots()) {
    offlineHint = navigator.onLine
      ? 'Cadastre service unavailable. Showing saved lots.'
      : 'Offline. Showing saved lots.';
  }
  const message = locationError ?? notice ?? offlineHint ?? zoomHint;
  statusEl.textContent = message;
  statusEl.hidden = !message;
}

// A message that replaces the usual status for a while, or until replaced.
function showNotice(text: string | null, seconds = 4) {
  notice = text;
  window.clearTimeout(noticeTimer);
  if (text && seconds) {
    noticeTimer = window.setTimeout(() => showNotice(null), seconds * 1000);
  }
  updateStatus();
}

// Draws saved lots in place of the live cadastre while it can't be reached.
async function showSavedLots() {
  const source = map.getSource<GeoJSONSource>('saved-lots');
  if (!source) return;
  const blocks = blocksIn(map.getBounds());
  if (map.getZoom() < CADASTRE_MIN_ZOOM - 0.5 || blocks.length > SAVE_AREA_MAX_BLOCKS) {
    source.setData(EMPTY);
    return;
  }
  source.setData({ type: 'FeatureCollection', features: await loadLots(blocks) });
}

function applyCadastreSource() {
  if (!map.getLayer('cadastre')) return;
  const saved = usingSavedLots();
  map.setLayoutProperty('cadastre', 'visibility', saved ? 'none' : 'visible');
  for (const layer of ['saved-lots-line', 'saved-lots-label']) {
    map.setLayoutProperty(layer, 'visibility', saved ? 'visible' : 'none');
  }
  if (saved) showSavedLots();
  updateStatus();
}

// Called when the connection returns, or the service answers again.
function cadastreReachable() {
  cadastreUnreachable = false;
  // Request again any tiles that failed while the service was unreachable.
  map.getSource<RasterTileSource>('cadastre')?.setTiles([CADASTRE_TILES]);
  applyCadastreSource();
}

window.addEventListener('online', cadastreReachable);
window.addEventListener('offline', applyCadastreSource);

// While the live cadastre is hidden it makes no requests, so check now and then if it's back.
window.setInterval(async () => {
  if (!cadastreUnreachable || !navigator.onLine) return;
  try {
    const response = await fetch(`${CADASTRE_URL}?f=json`, { signal: AbortSignal.timeout(10_000) });
    if (response.ok) cadastreReachable();
  } catch {
    // Still unreachable.
  }
}, 30_000);

// While online, quietly save the lots on screen when zoomed in to street level.
let autoSaving = false;
async function autoSave() {
  if (autoSaving || usingSavedLots() || map.getZoom() < AUTO_SAVE_MIN_ZOOM) return;
  autoSaving = true;
  try {
    await saveBlocks(CADASTRE_URL, blocksIn(map.getBounds()));
  } catch (error) {
    console.warn('Could not save lots for offline use', error);
  } finally {
    autoSaving = false;
  }
}

async function fetchAll(urls: string[]) {
  for (let i = 0; i < urls.length; i += 6) {
    await Promise.allSettled(urls.slice(i, i + 6).map((url) => fetch(url)));
  }
}

// Fetching base map files puts them in the service worker's cache, so the map draws offline.
// The style, tile index, icons and fonts are fetched here too: the first visit loads them before
// the service worker is running, so they wouldn't be cached otherwise.
async function saveBasemapEssentials() {
  const style = map.getStyle();
  const urls = [BASEMAP_STYLE];
  for (const source of Object.values(style.sources)) {
    if ('url' in source && source.url) urls.push(source.url);
  }
  if (typeof style.sprite === 'string') {
    for (const suffix of ['.json', '.png', '@2x.json', '@2x.png']) urls.push(style.sprite + suffix);
  }
  const fonts = new Set([SAVED_LOTS_FONT]);
  for (const layer of style.layers) {
    if (layer.type !== 'symbol') continue;
    const textFont = layer.layout?.['text-font'];
    if (Array.isArray(textFont)) fonts.add(textFont.join(','));
  }
  if (style.glyphs) {
    for (const font of fonts) urls.push(style.glyphs.replace('{fontstack}', font).replace('{range}', '0-255'));
  }
  await fetchAll(urls);
}

async function saveBasemap(bounds: maplibregl.LngLatBounds) {
  await saveBasemapEssentials();
  const template = map.getSource<VectorTileSource>('openmaptiles')?.tiles?.[0];
  if (!template) return;
  const urls: string[] = [];
  for (let zoom = 0; zoom <= 14; zoom++) {
    for (const [x, y] of tilesIn(bounds, zoom)) {
      urls.push(template.replace('{z}', String(zoom)).replace('{x}', String(x)).replace('{y}', String(y)));
    }
  }
  await fetchAll(urls);
}

let savingArea = false;
async function saveArea() {
  if (savingArea) return;
  if (usingSavedLots()) {
    showNotice('Connect to the internet to save this area');
    return;
  }
  const bounds = map.getBounds();
  const blocks = blocksIn(bounds);
  if (map.getZoom() < SAVE_AREA_MIN_ZOOM || blocks.length > SAVE_AREA_MAX_BLOCKS) {
    showNotice('Zoom in closer to save this area');
    return;
  }

  savingArea = true;
  saveButton.disabled = true;
  try {
    await saveBlocks(CADASTRE_URL, blocks, {
      maxAgeDays: 1,
      onProgress: (done, total) =>
        showNotice(`Saving lots for offline use: ${Math.round((done / total) * 100)}%`, 0),
    });
    showNotice('Saving the map for offline use…', 0);
    await saveBasemap(bounds);
    // Ask the browser not to clear the saved data when the phone runs low on space.
    await navigator.storage?.persist?.();
    const count = (await loadLots(blocks)).length;
    showNotice(`Saved ${count.toLocaleString('en-CA')} lots in this area for offline use`, 6);
  } catch (error) {
    console.error(error);
    showNotice('Saving failed. Check your connection and try again.', 6);
  } finally {
    savingArea = false;
    saveButton.disabled = false;
  }
}

map.on('load', () => {
  map.addSource('satellite', {
    type: 'raster',
    tiles: [SATELLITE_TILES],
    tileSize: 256,
    maxzoom: 19,
    attribution: 'Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community',
  });
  map.addLayer({
    id: 'satellite',
    type: 'raster',
    source: 'satellite',
    layout: { visibility: 'none' },
  });

  map.addSource('cadastre', {
    type: 'raster',
    tiles: [CADASTRE_TILES],
    tileSize: TILE_SIZE,
    minzoom: CADASTRE_MIN_ZOOM,
    attribution: '© Gouvernement du Québec',
  });
  map.addLayer({ id: 'cadastre', type: 'raster', source: 'cadastre' });

  map.addSource('saved-lots', {
    type: 'geojson',
    data: EMPTY,
    attribution: '© Gouvernement du Québec',
  });
  map.addLayer({
    id: 'saved-lots-line',
    type: 'line',
    source: 'saved-lots',
    layout: { visibility: 'none' },
    paint: { 'line-width': 1 },
  });
  map.addLayer({
    id: 'saved-lots-label',
    type: 'symbol',
    source: 'saved-lots',
    layout: {
      visibility: 'none',
      'text-field': ['get', 'NO_LOT'],
      'text-font': [SAVED_LOTS_FONT],
      'text-size': 12,
    },
    paint: { 'text-halo-width': 1.5 },
  });

  map.addSource('selected-lot', { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'selected-lot-fill',
    type: 'fill',
    source: 'selected-lot',
    paint: { 'fill-color': '#1a73e8', 'fill-opacity': 0.2 },
  });
  map.addLayer({
    id: 'selected-lot-line',
    type: 'line',
    source: 'selected-lot',
    paint: { 'line-color': '#1a73e8', 'line-width': 3 },
  });

  applyBasemap();
  applyCadastreSource();
  geolocate.trigger();

  // Once the service worker is running, make sure the map itself can open offline.
  if (navigator.onLine) {
    navigator.serviceWorker?.ready.then(saveBasemapEssentials).catch(console.warn);
  }
});

map.on('zoom', updateStatus);

map.on('moveend', () => {
  if (usingSavedLots()) showSavedLots();
  else autoSave();
});

map.on('error', (e: ErrorEvent & { sourceId?: string }) => {
  if (e.sourceId !== 'cadastre' || cadastreUnreachable) return;
  cadastreUnreachable = true;
  applyCadastreSource();
});

geolocate.on('geolocate', ({ coords }) => {
  locationError = null;
  updateStatus();
  // Phones report magnetic north, which is about 15° from the map's north in Québec.
  declination = magvar(coords.latitude, coords.longitude);
  updateHeadingArrow();
});

geolocate.on('error', (e) => {
  locationError =
    e.code === GeolocationPositionError.PERMISSION_DENIED
      ? 'Location is off. Allow it for this app in your phone settings.'
      : 'Could not get your location';
  updateStatus();
});

let lotQuery: AbortController | null = null;
const sheet = document.querySelector<HTMLElement>('#lot-sheet')!;
const sheetContent = document.querySelector<HTMLElement>('#lot-sheet-content')!;

// Lift the map's bottom buttons and credits above the sheet while it's open.
new ResizeObserver(() => {
  const height = sheet.hidden ? 0 : sheet.offsetHeight;
  document.documentElement.style.setProperty('--sheet-height', `${height}px`);
}).observe(sheet);

function showSheet(content: HTMLElement, tapped: maplibregl.Point) {
  sheetContent.replaceChildren(content);
  sheet.hidden = false;
  // Pan the tapped lot into view if the sheet now covers it.
  const visibleBottom = map.getContainer().clientHeight - sheet.offsetHeight;
  if (tapped.y > visibleBottom - 40) map.panBy([0, tapped.y - visibleBottom / 2]);
}

function closeSheet() {
  lotQuery?.abort();
  sheet.hidden = true;
  selectLot(null);
}

document.querySelector('#lot-sheet-close')!.addEventListener('click', closeSheet);

async function findLot({ lng, lat }: maplibregl.LngLat, signal: AbortSignal) {
  const params = new URLSearchParams({
    geometry: `${lng},${lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'NO_LOT,OBJECTID',
    outSR: '4326',
    f: 'geojson',
  });
  const response = await fetch(`${CADASTRE_URL}/0/query?${params}`, { signal });
  if (!response.ok) throw new Error(`Lot query failed: ${response.status}`);
  const result: GeoJSON.FeatureCollection = await response.json();
  return (result.features[0] as Lot | undefined) ?? null;
}

function selectLot(lot: Lot | null) {
  map.getSource<GeoJSONSource>('selected-lot')?.setData(lot ?? EMPTY);
}

function detailRow(list: HTMLElement, label: string, value: string) {
  const term = document.createElement('dt');
  const detail = document.createElement('dd');
  term.textContent = label;
  detail.textContent = value;
  list.append(term, detail);
  return detail;
}

// Fills in as the lookups return, so the lot number and size show straight away. Offline, the
// municipality and address come from the last time the lot was tapped online, if it was.
function lotDetails(lot: Lot, { lng, lat }: maplibregl.LngLat, offline: boolean, signal: AbortSignal) {
  const number = lot.properties.NO_LOT;
  const content = document.createElement('div');
  content.className = 'lot-details';

  const title = document.createElement('h2');
  title.textContent = `Lot ${number}`;
  content.append(title);

  if (offline) {
    const note = document.createElement('p');
    note.className = 'offline-note';
    note.textContent = 'Saved copy, shown while offline.';
    content.append(note);
  }

  if (number.startsWith('PC-')) {
    const note = document.createElement('p');
    note.textContent =
      'Complementary plan, used for condos and other properties divided by floor. The size is the whole building lot.';
    content.append(note);
  }

  const list = document.createElement('dl');
  content.append(list);
  const { area, perimeter } = measure(lot.geometry);
  detailRow(list, 'Area', formatArea(area));
  detailRow(list, 'Perimeter', formatLength(perimeter));

  const place = detailRow(list, 'Municipality', 'Loading…');
  const region = detailRow(list, 'Region', 'Loading…');
  const address = detailRow(list, 'Nearest address', 'Loading…');
  const missing = offline ? 'Needs internet' : 'Unavailable';

  const showPlace = (found: Place) => {
    place.textContent = found.municipality ?? 'Unknown';
    if (found.mrc && found.mrc !== found.municipality) place.textContent += `, MRC ${found.mrc}`;
    region.textContent = found.region ?? 'Unknown';
  };
  const showAddress = (found: string | null) => (address.textContent = found ?? 'None nearby');

  const showSaved = async (which: keyof SavedDetails) => {
    const saved = await loadDetails(lot).catch(() => undefined);
    if (signal.aborted) return;
    if (which === 'place') {
      if (saved?.place) showPlace(saved.place);
      else place.textContent = region.textContent = missing;
    } else if (saved && 'address' in saved) {
      showAddress(saved.address ?? null);
    } else {
      address.textContent = missing;
    }
  };

  if (offline) {
    showSaved('place');
    showSaved('address');
    return content;
  }

  const placeLookup = findPlace(lng, lat, signal);
  const addressLookup = findNearestAddress(lng, lat, signal);
  placeLookup.then(showPlace, () => {
    if (!signal.aborted) showSaved('place');
  });
  addressLookup.then(showAddress, () => {
    if (!signal.aborted) showSaved('address');
  });

  // Keep what was found, for when this lot is tapped offline.
  Promise.allSettled([placeLookup, addressLookup]).then(([foundPlace, foundAddress]) => {
    const details: SavedDetails = {};
    if (foundPlace.status === 'fulfilled') details.place = foundPlace.value;
    if (foundAddress.status === 'fulfilled') details.address = foundAddress.value;
    if (Object.keys(details).length) saveDetails(lot, details).catch(console.warn);
  });

  return content;
}

map.on('click', async (e: MapMouseEvent) => {
  if (map.getZoom() < CADASTRE_MIN_ZOOM - 0.5) return;

  lotQuery?.abort();
  const query = (lotQuery = new AbortController());

  let offline = usingSavedLots();
  let lot: Lot | null = null;
  if (!offline) {
    try {
      lot = await findLot(e.lngLat, query.signal);
    } catch (error) {
      if (query.signal.aborted) return;
      console.error(error);
      cadastreUnreachable = true;
      applyCadastreSource();
      offline = true;
    }
  }
  if (offline) lot = await findSavedLot(e.lngLat);
  if (query.signal.aborted) return;

  if (lot) {
    selectLot(lot);
    showSheet(lotDetails(lot, e.lngLat, offline, query.signal), e.point);
  } else {
    closeSheet();
    if (offline) showNotice("This lot isn't saved on your phone");
  }
});
