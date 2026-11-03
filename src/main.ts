import * as maplibregl from 'maplibre-gl';
import type { ErrorEvent, GeoJSONSource, MapMouseEvent } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { magvar } from 'magvar';
import 'maplibre-gl/dist/maplibre-gl.css';
import { watchCompass } from './compass';
import { LocationFilter } from './location-filter';
import { findNearestAddress, findPlace, formatArea, formatLength, measure } from './lot-details';
import './style.css';

const BASEMAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const SATELLITE_TILES =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const CADASTRE_URL =
  'https://geo.environnement.gouv.qc.ca/donnees/rest/services/Reference/Cadastre_allege/MapServer';

// The service draws nothing past 1:30,000, which is tile zoom 14 at this tile size.
const CADASTRE_MIN_ZOOM = 14;
const TILE_SIZE = 512;
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

// MapLibre 6 ships its worker as a separate file, which bundlers must be told about.
maplibregl.setWorkerUrl(workerUrl);

const statusEl = document.querySelector<HTMLElement>('#status')!;
let locationError: string | null = null;
let cadastreError: string | null = null;

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

map.addControl(
  {
    onAdd() {
      const container = document.createElement('div');
      container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
      container.append(layersButton);
      return container;
    },
    onRemove() {},
  },
  'bottom-right',
);
applyBasemap();

function updateStatus() {
  const zoomHint = map.getZoom() < CADASTRE_MIN_ZOOM - 0.5 ? 'Zoom in to see lots' : null;
  const message = locationError ?? cadastreError ?? zoomHint;
  statusEl.textContent = message;
  statusEl.hidden = !message;
}

map.on('load', () => {
  // Retina tiles: 1024px images at double DPI, displayed at 512px.
  const tiles =
    `${CADASTRE_URL}/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857` +
    `&size=${TILE_SIZE * 2},${TILE_SIZE * 2}&dpi=192&format=png32&transparent=true&f=image`;

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
    tiles: [tiles],
    tileSize: TILE_SIZE,
    minzoom: CADASTRE_MIN_ZOOM,
    attribution: '© Gouvernement du Québec',
  });
  map.addLayer({ id: 'cadastre', type: 'raster', source: 'cadastre' });

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
  updateStatus();
  geolocate.trigger();
});

map.on('zoom', updateStatus);

map.on('error', (e: ErrorEvent & { sourceId?: string }) => {
  if (e.sourceId !== 'cadastre') return;
  cadastreError = 'Cadastre service unavailable';
  updateStatus();
});

map.on('data', (e) => {
  if (e.dataType === 'source' && e.sourceId === 'cadastre' && e.tile) {
    cadastreError = null;
    updateStatus();
  }
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
    outFields: 'NO_LOT',
    outSR: '4326',
    f: 'geojson',
  });
  const response = await fetch(`${CADASTRE_URL}/0/query?${params}`, { signal });
  if (!response.ok) throw new Error(`Lot query failed: ${response.status}`);
  const result: GeoJSON.FeatureCollection = await response.json();
  return result.features[0] ?? null;
}

function selectLot(lot: GeoJSON.Feature | null) {
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

// Fills in slowly as the lookups return, so the lot number and size show straight away.
function lotDetails(lot: GeoJSON.Feature, { lng, lat }: maplibregl.LngLat, signal: AbortSignal) {
  const number = String(lot.properties?.NO_LOT ?? '');
  const content = document.createElement('div');
  content.className = 'lot-details';

  const title = document.createElement('h2');
  title.textContent = `Lot ${number}`;
  content.append(title);

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
  findPlace(lng, lat, signal)
    .then((found) => {
      place.textContent = found.municipality ?? 'Unknown';
      if (found.mrc && found.mrc !== found.municipality) place.textContent += `, MRC ${found.mrc}`;
      region.textContent = found.region ?? 'Unknown';
    })
    .catch(() => {
      if (signal.aborted) return;
      place.textContent = 'Unavailable';
      region.textContent = 'Unavailable';
    });

  const address = detailRow(list, 'Nearest address', 'Loading…');
  findNearestAddress(lng, lat, signal)
    .then((found) => (address.textContent = found ?? 'None nearby'))
    .catch(() => {
      if (!signal.aborted) address.textContent = 'Unavailable';
    });

  return content;
}

map.on('click', async (e: MapMouseEvent) => {
  if (map.getZoom() < CADASTRE_MIN_ZOOM - 0.5) return;

  lotQuery?.abort();
  const query = (lotQuery = new AbortController());

  try {
    const lot = await findLot(e.lngLat, query.signal);
    if (lot) {
      selectLot(lot);
      showSheet(lotDetails(lot, e.lngLat, query.signal), e.point);
    } else {
      closeSheet();
    }
    cadastreError = null;
  } catch (error) {
    if (query.signal.aborted) return;
    console.error(error);
    cadastreError = 'Cadastre service unavailable';
  }
  updateStatus();
});
