// Details shown when a lot is tapped: measurements from its outline, plus where it is.

// WGS84 ellipsoid.
const SEMI_MAJOR_AXIS = 6_378_137; // metres
const ECCENTRICITY_SQUARED = 0.006_694_379_990_14;
const TERRAPI_URL = 'https://geoegl.msp.gouv.qc.ca/apis/terrapi/locate';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';

type Position = GeoJSON.Position;

export interface Measurements {
  area: number; // square metres
  perimeter: number; // metres
}

export interface Place {
  municipality?: string;
  mrc?: string;
  region?: string;
}

function rings(geometry: GeoJSON.Geometry): Position[][][] {
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

// Lots are small, so a flat projection centred on the lot, using the ellipsoid's curvature there,
// is accurate to well under 0.1%. A spherical Earth would be about 0.25% off in Québec.
export function measure(geometry: GeoJSON.Geometry): Measurements {
  const polygons = rings(geometry);
  const lats = polygons.flat(2).map(([, lat]) => lat);
  const midLat = ((Math.min(...lats) + Math.max(...lats)) / 2) * (Math.PI / 180);
  const w = 1 - ECCENTRICITY_SQUARED * Math.sin(midLat) ** 2;
  const northSouthRadius = (SEMI_MAJOR_AXIS * (1 - ECCENTRICITY_SQUARED)) / w ** 1.5;
  const eastWestRadius = (SEMI_MAJOR_AXIS / Math.sqrt(w)) * Math.cos(midLat);
  const project = ([lng, lat]: Position) => [
    eastWestRadius * lng * (Math.PI / 180),
    northSouthRadius * lat * (Math.PI / 180),
  ];

  let area = 0;
  let perimeter = 0;
  for (const polygon of polygons) {
    polygon.forEach((ring, index) => {
      const points = ring.map(project);
      let twiceArea = 0;
      for (let i = 0; i < points.length - 1; i++) {
        const [x1, y1] = points[i];
        const [x2, y2] = points[i + 1];
        twiceArea += x1 * y2 - x2 * y1;
        perimeter += Math.hypot(x2 - x1, y2 - y1);
      }
      // The first ring is the outline; any others are holes.
      area += (index === 0 ? 1 : -1) * Math.abs(twiceArea / 2);
    });
  }
  return { area, perimeter };
}

const number = (value: number, digits = 0) =>
  value.toLocaleString('en-CA', { maximumFractionDigits: digits });

export function formatArea(squareMetres: number) {
  if (squareMetres >= 10_000) {
    return `${number(squareMetres / 10_000, 2)} ha (${number(squareMetres / 4_046.856, 2)} acres)`;
  }
  return `${number(squareMetres)} m² (${number(squareMetres * 10.7639)} sq ft)`;
}

export function formatLength(metres: number) {
  return `${number(metres)} m (${number(metres * 3.28084)} ft)`;
}

// Official municipality, MRC and region from the Québec government.
export async function findPlace(lng: number, lat: number, signal: AbortSignal): Promise<Place> {
  const params = new URLSearchParams({
    loc: `${lng},${lat}`,
    type: 'municipalites,mrc,regadmin',
    geometry: 'false',
  });
  const response = await fetch(`${TERRAPI_URL}?${params}`, { signal });
  if (!response.ok) throw new Error(`Place lookup failed: ${response.status}`);
  const result: GeoJSON.FeatureCollection = await response.json();
  const name = (type: string) =>
    result.features.find((f) => f.properties?.type === type)?.properties?.nom as string | undefined;
  return { municipality: name('municipalites'), mrc: name('mrc'), region: name('regadmin') };
}

// The closest address OpenStreetMap knows. It may belong to a neighbouring lot.
export async function findNearestAddress(lng: number, lat: number, signal: AbortSignal) {
  const params = new URLSearchParams({
    format: 'jsonv2',
    lat: String(lat),
    lon: String(lng),
    zoom: '18',
    addressdetails: '1',
    'accept-language': 'fr',
  });
  const response = await fetch(`${NOMINATIM_URL}?${params}`, { signal });
  if (!response.ok) throw new Error(`Address lookup failed: ${response.status}`);
  const result = await response.json();
  const { house_number: houseNumber, road } = result.address ?? {};
  if (!road) return null;
  return houseNumber ? `${houseNumber} ${road}` : road;
}
