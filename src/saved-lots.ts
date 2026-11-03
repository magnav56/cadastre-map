// Lots saved on the phone, so they can be drawn and tapped without internet.
//
// Lots are saved in blocks: map tiles at zoom 15, about 800 m across in Québec. A lot that
// crosses a block edge is saved in each block it touches.

import { createStore, get, getMany, set } from 'idb-keyval';
import type { LngLat, LngLatBounds } from 'maplibre-gl';
import type { Place } from './lot-details';

const BLOCK_ZOOM = 15;
const PAGE_SIZE = 2000; // the service's limit per request
const DAY = 24 * 60 * 60 * 1000;

export type Lot = GeoJSON.Feature<
  GeoJSON.Polygon | GeoJSON.MultiPolygon,
  { NO_LOT: string; OBJECTID: number }
>;

interface SavedBlock {
  saved: number; // time saved, in ms
  lots: Lot[];
}

export interface SavedDetails {
  place?: Place;
  address?: string | null;
}

const store = createStore('cadastre-map', 'saved');
const blockKey = ([x, y]: Block) => `lots/${BLOCK_ZOOM}/${x}/${y}`;
const detailsKey = (lot: Lot) => `details/${lot.properties.OBJECTID}`;

type Block = [x: number, y: number];

// Standard 256-pixel web map tiles, the scheme OpenFreeMap also uses.
function tileAt(lng: number, lat: number, zoom: number): Block {
  const n = 2 ** zoom;
  const latRad = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  const x = Math.floor(((lng + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return [x, y];
}

export function tilesIn(bounds: LngLatBounds, zoom: number): Block[] {
  const [west, north] = tileAt(bounds.getWest(), bounds.getNorth(), zoom);
  const [east, south] = tileAt(bounds.getEast(), bounds.getSouth(), zoom);
  const tiles: Block[] = [];
  for (let x = west; x <= east; x++) for (let y = north; y <= south; y++) tiles.push([x, y]);
  return tiles;
}

const blockAt = (lng: number, lat: number) => tileAt(lng, lat, BLOCK_ZOOM);
export const blocksIn = (bounds: LngLatBounds) => tilesIn(bounds, BLOCK_ZOOM);

function blockBounds([x, y]: Block) {
  const n = 2 ** BLOCK_ZOOM;
  const lng = (i: number) => (i / n) * 360 - 180;
  const lat = (j: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * j) / n))) * 180) / Math.PI;
  return [lng(x), lat(y + 1), lng(x + 1), lat(y)];
}

async function downloadBlock(serviceUrl: string, block: Block, signal?: AbortSignal) {
  const lots: Lot[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const params = new URLSearchParams({
      geometry: blockBounds(block).join(','),
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: 'NO_LOT,OBJECTID',
      outSR: '4326',
      geometryPrecision: '6', // about 0.1 m, which cuts the size by about 40%
      orderByFields: 'OBJECTID',
      resultOffset: String(offset),
      resultRecordCount: String(PAGE_SIZE),
      f: 'geojson',
    });
    const response = await fetch(`${serviceUrl}/0/query?${params}`, { signal });
    if (!response.ok) throw new Error(`Lot download failed: ${response.status}`);
    const page: GeoJSON.FeatureCollection = await response.json();
    lots.push(...(page.features as Lot[]));
    if (page.features.length < PAGE_SIZE) return lots;
  }
}

// Saves the blocks not already saved within maxAgeDays. Returns how many lots were saved.
export async function saveBlocks(
  serviceUrl: string,
  blocks: Block[],
  { maxAgeDays = 30, signal, onProgress }: {
    maxAgeDays?: number;
    signal?: AbortSignal;
    onProgress?: (done: number, total: number) => void;
  } = {},
) {
  const existing = await getMany<SavedBlock | undefined>(blocks.map(blockKey), store);
  const stale = blocks.filter((_, i) => !existing[i] || Date.now() - existing[i]!.saved > maxAgeDays * DAY);
  let saved = 0;
  let done = blocks.length - stale.length;
  onProgress?.(done, blocks.length);
  for (const block of stale) {
    const lots = await downloadBlock(serviceUrl, block, signal);
    await set(blockKey(block), { saved: Date.now(), lots } satisfies SavedBlock, store);
    saved += lots.length;
    onProgress?.(++done, blocks.length);
  }
  return saved;
}

export async function loadLots(blocks: Block[]) {
  const saved = await getMany<SavedBlock | undefined>(blocks.map(blockKey), store);
  const lots = new Map<number, Lot>();
  for (const block of saved) for (const lot of block?.lots ?? []) lots.set(lot.properties.OBJECTID, lot);
  return [...lots.values()];
}

function insideRing([x, y]: number[], ring: GeoJSON.Position[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function contains(lot: Lot, point: number[]) {
  const polygons = lot.geometry.type === 'Polygon' ? [lot.geometry.coordinates] : lot.geometry.coordinates;
  return polygons.some(
    ([outline, ...holes]) => insideRing(point, outline) && !holes.some((hole) => insideRing(point, hole)),
  );
}

export async function findSavedLot({ lng, lat }: LngLat) {
  const block = await get<SavedBlock>(blockKey(blockAt(lng, lat)), store);
  return block?.lots.find((lot) => contains(lot, [lng, lat])) ?? null;
}

// Municipality and address looked up while online, kept for when the lot is tapped offline.
export const loadDetails = (lot: Lot) => get<SavedDetails>(detailsKey(lot), store);

export async function saveDetails(lot: Lot, details: SavedDetails) {
  const current = await loadDetails(lot);
  await set(detailsKey(lot), { ...current, ...details }, store);
}
