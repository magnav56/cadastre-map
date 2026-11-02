// The phone has already fused GPS, Wi-Fi and cell data by the time a fix reaches the browser.
// This Kalman filter removes what is left: jitter between fixes and the odd wild jump. It tracks
// position and velocity per axis, and trusts each fix according to its reported accuracy.

const METERS_PER_DEGREE = 111_320;
// How sharply the filter expects you to speed up or turn. Higher follows faster, lower is smoother.
const ACCELERATION_NOISE = 1; // m/s²
const SPEED_NOISE = 0.5; // m/s
// Squared distance from the estimate, in standard deviations, past which a fix is an outlier.
const OUTLIER_LIMIT = 16;
// A real move looks like outliers that keep agreeing, so stop rejecting after this many in a row.
const MAX_REJECTED_FIXES = 3;
// After this long without a fix, the estimate is worthless.
const MAX_GAP_SECONDS = 30;

class Axis {
  position: number;
  velocity = 0;
  // Covariance of position and velocity.
  pp: number;
  pv = 0;
  vv = 100;

  constructor(position: number, variance: number) {
    this.position = position;
    this.pp = variance;
  }

  predict(dt: number) {
    const q = ACCELERATION_NOISE ** 2;
    this.position += this.velocity * dt;
    this.pp += dt * (2 * this.pv + dt * this.vv) + (q * dt ** 4) / 4;
    this.pv += dt * this.vv + (q * dt ** 3) / 2;
    this.vv += q * dt ** 2;
  }

  positionError(measured: number, variance: number) {
    return (measured - this.position) ** 2 / (this.pp + variance);
  }

  measurePosition(measured: number, variance: number) {
    const gainP = this.pp / (this.pp + variance);
    const gainV = this.pv / (this.pp + variance);
    const error = measured - this.position;
    this.position += gainP * error;
    this.velocity += gainV * error;
    this.vv -= gainV * this.pv;
    this.pv *= 1 - gainP;
    this.pp *= 1 - gainP;
  }

  measureVelocity(measured: number, variance: number) {
    const gainP = this.pv / (this.vv + variance);
    const gainV = this.vv / (this.vv + variance);
    const error = measured - this.velocity;
    this.position += gainP * error;
    this.velocity += gainV * error;
    this.pp -= gainP * this.pv;
    this.pv *= 1 - gainV;
    this.vv *= 1 - gainV;
  }
}

interface State {
  east: Axis;
  north: Axis;
  metersPerDegreeLng: number;
  accuracy: number;
  timestamp: number;
  rejectedFixes: number;
}

export class LocationFilter {
  private state: State | null = null;

  update(fix: GeolocationPosition): GeolocationPosition {
    const { latitude, longitude, accuracy } = fix.coords;
    const dt = this.state ? (fix.timestamp - this.state.timestamp) / 1000 : Infinity;

    if (!this.state || dt > MAX_GAP_SECONDS) {
      this.state = start(fix);
      return fix;
    }
    const state = this.state;
    if (dt <= 0) return toPosition(state, fix); // A repeated or cached fix adds nothing.

    state.east.predict(dt);
    state.north.predict(dt);
    state.timestamp = fix.timestamp;

    const east = longitude * state.metersPerDegreeLng;
    const north = latitude * METERS_PER_DEGREE;
    // Accuracy is a radius, so each axis gets half of its variance.
    const variance = accuracy ** 2 / 2;

    const error = state.east.positionError(east, variance) + state.north.positionError(north, variance);
    if (error > OUTLIER_LIMIT && ++state.rejectedFixes < MAX_REJECTED_FIXES) {
      return toPosition(state, fix);
    }
    if (error > OUTLIER_LIMIT) {
      this.state = start(fix);
      return fix;
    }

    state.rejectedFixes = 0;
    state.accuracy = accuracy;
    state.east.measurePosition(east, variance);
    state.north.measurePosition(north, variance);

    // Speed comes from the Doppler shift of satellite signals, which is far cleaner than position.
    const velocity = groundVelocity(fix.coords);
    if (velocity) {
      state.east.measureVelocity(velocity.east, SPEED_NOISE ** 2);
      state.north.measureVelocity(velocity.north, SPEED_NOISE ** 2);
    }

    return toPosition(state, fix);
  }
}

function start(fix: GeolocationPosition): State {
  const { latitude, longitude, accuracy } = fix.coords;
  const metersPerDegreeLng = METERS_PER_DEGREE * Math.cos((latitude * Math.PI) / 180);
  const variance = accuracy ** 2 / 2;
  return {
    east: new Axis(longitude * metersPerDegreeLng, variance),
    north: new Axis(latitude * METERS_PER_DEGREE, variance),
    metersPerDegreeLng,
    accuracy,
    timestamp: fix.timestamp,
    rejectedFixes: 0,
  };
}

function groundVelocity({ speed, heading }: GeolocationCoordinates) {
  if (speed === null) return null;
  if (speed === 0) return { east: 0, north: 0 };
  if (heading === null || Number.isNaN(heading)) return null;
  const radians = (heading * Math.PI) / 180;
  return { east: speed * Math.sin(radians), north: speed * Math.cos(radians) };
}

function toPosition(state: State, fix: GeolocationPosition): GeolocationPosition {
  const { altitude, altitudeAccuracy, heading, speed } = fix.coords;
  // Keep the phone's own accuracy. The filter's variance would shrink well below it, but GPS
  // errors drift together rather than averaging out, so the circle would claim false precision.
  const coords = {
    latitude: state.north.position / METERS_PER_DEGREE,
    longitude: state.east.position / state.metersPerDegreeLng,
    accuracy: state.accuracy,
    altitude,
    altitudeAccuracy,
    heading,
    speed,
  };
  const { timestamp } = fix;
  return {
    coords: { ...coords, toJSON: () => coords },
    timestamp,
    toJSON: () => ({ coords, timestamp }),
  };
}
