import * as maplibregl from 'maplibre-gl';
import type { ErrorEvent, GeoJSONSource, MapMouseEvent } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';

const BASEMAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
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

map.addControl(new maplibregl.NavigationControl({ showZoom: false }), 'top-right');
map.addControl(geolocate, 'bottom-right');

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

geolocate.on('geolocate', () => {
  locationError = null;
  updateStatus();
});

geolocate.on('error', (e) => {
  locationError =
    e.code === GeolocationPositionError.PERMISSION_DENIED
      ? 'Location is off. Allow it for this app in your phone settings.'
      : 'Could not get your location';
  updateStatus();
});

let lotQuery: AbortController | null = null;
const popup = new maplibregl.Popup({ closeOnClick: false, focusAfterOpen: false });

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

map.on('click', async (e: MapMouseEvent) => {
  if (map.getZoom() < CADASTRE_MIN_ZOOM - 0.5) return;

  lotQuery?.abort();
  const query = (lotQuery = new AbortController());

  try {
    const lot = await findLot(e.lngLat, query.signal);
    popup.remove();
    selectLot(lot);
    if (lot) popup.setLngLat(e.lngLat).setText(`Lot ${lot.properties?.NO_LOT}`).addTo(map);
    cadastreError = null;
  } catch (error) {
    if (query.signal.aborted) return;
    console.error(error);
    cadastreError = 'Cadastre service unavailable';
  }
  updateStatus();
});

popup.on('close', () => selectLot(null));
