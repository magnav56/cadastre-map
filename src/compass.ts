// How much of each new reading to take. Sensors fire about 60 times a second, so this settles in
// a fraction of a second without passing on the shake of a hand.
const SMOOTHING = 0.15;

type CompassEvent = DeviceOrientationEvent & {
  webkitCompassHeading?: number;
  webkitCompassAccuracy?: number;
};

// Calls back with the direction the phone faces, in degrees clockwise from magnetic north. Never
// calls back on a phone without a usable compass.
export function watchCompass(onHeading: (heading: number) => void) {
  let smoothed: number | null = null;

  const onOrientation = (event: CompassEvent) => {
    const heading = readHeading(event);
    if (heading === null) return;
    // Turn the short way round, so going from 359° to 1° doesn't spin through 180°.
    const turn = ((heading - (smoothed ?? heading) + 540) % 360) - 180;
    smoothed = ((smoothed ?? heading) + turn * SMOOTHING + 360) % 360;
    onHeading(smoothed);
  };

  window.addEventListener('deviceorientationabsolute', onOrientation);
  window.addEventListener('deviceorientation', onOrientation);
  askPermissionOnFirstTap();
}

function screenAngle() {
  return screen.orientation?.angle ?? 0;
}

// Judges each event by what it carries rather than guessing the platform: since version 151,
// Chrome on Android also has requestPermission, so its presence no longer means iOS.
function readHeading(event: CompassEvent) {
  if (typeof event.webkitCompassHeading === 'number') {
    // iOS reports accuracy -1 when it has no heading.
    if ((event.webkitCompassAccuracy ?? 0) < 0) return null;
    return (event.webkitCompassHeading + screenAngle()) % 360;
  }
  // Relative orientation has an arbitrary north that resets when the sensors restart.
  if (!event.absolute) return null;
  return headingFromAngles(event.alpha, event.beta, event.gamma);
}

// The usual 360 - alpha only holds for a phone lying flat: it can be 90° out held upright. Instead,
// rotate the phone's axes into east and north. Lying flat, the top of the screen shows where the
// phone points. Upright, the top points at the sky and the back of the phone shows it. Adding the
// two gives the same direction at every tilt in between.
function headingFromAngles(alpha: number | null, beta: number | null, gamma: number | null) {
  if (alpha === null || beta === null || gamma === null) return null;
  const toRadians = Math.PI / 180;
  const [sinA, cosA] = [Math.sin(alpha * toRadians), Math.cos(alpha * toRadians)];
  const [sinB, cosB] = [Math.sin(beta * toRadians), Math.cos(beta * toRadians)];
  const [sinG, cosG] = [Math.sin(gamma * toRadians), Math.cos(gamma * toRadians)];

  const right = { east: cosA * cosG - sinA * sinB * sinG, north: cosG * sinA + cosA * sinB * sinG };
  const top = { east: -cosB * sinA, north: cosA * cosB };
  const back = { east: -cosG * sinA * sinB - cosA * sinG, north: cosA * cosG * sinB - sinA * sinG };

  // The top of the screen is the side of the phone in landscape.
  const angle = screenAngle() * toRadians;
  const up = {
    east: Math.cos(angle) * top.east + Math.sin(angle) * right.east,
    north: Math.cos(angle) * top.north + Math.sin(angle) * right.north,
  };

  const east = up.east + back.east;
  const north = up.north + back.north;
  if (Math.hypot(east, north) < 0.1) return null;
  return ((Math.atan2(east, north) / toRadians) + 360) % 360;
}

// iOS only gives compass access from a tap, and location starts without one.
function askPermissionOnFirstTap() {
  const orientationEvent = window.DeviceOrientationEvent as
    | { requestPermission?: () => Promise<PermissionState> }
    | undefined;
  if (!orientationEvent?.requestPermission) return;

  let asking = false;
  const ask = async () => {
    if (asking) return;
    asking = true;
    try {
      await orientationEvent.requestPermission!();
      window.removeEventListener('touchend', ask, true);
      window.removeEventListener('click', ask, true);
    } catch {
      // The browser didn't count this touch as a tap, for example the end of a pan. Try the next.
    }
    asking = false;
  };
  window.addEventListener('touchend', ask, true);
  window.addEventListener('click', ask, true);
}
