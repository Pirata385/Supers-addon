// Small, allocation-light vector helpers. All functions return new objects.

/** @typedef {{x:number,y:number,z:number}} Vec3 */

export const ZERO = Object.freeze({ x: 0, y: 0, z: 0 });
export const UP = Object.freeze({ x: 0, y: 1, z: 0 });

/** @returns {Vec3} */
export function v3(x = 0, y = 0, z = 0) {
  return { x, y, z };
}
/** @param {Vec3} a @param {Vec3} b */
export function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
/** @param {Vec3} a @param {Vec3} b */
export function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
/** @param {Vec3} a @param {number} s */
export function scale(a, s) {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}
/** a + b * s */
export function addScaled(a, b, s) {
  return { x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s };
}
export function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
export function cross(a, b) {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
export function len(a) {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}
export function lenSq(a) {
  return a.x * a.x + a.y * a.y + a.z * a.z;
}
export function hlen(a) {
  return Math.sqrt(a.x * a.x + a.z * a.z);
}
export function dist(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
export function distSq(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}
/** @param {Vec3} a */
export function norm(a) {
  const l = len(a);
  return l > 1e-6 ? { x: a.x / l, y: a.y / l, z: a.z / l } : { x: 0, y: 0, z: 0 };
}
/** Horizontal (XZ) normalized direction. */
export function hnorm(a) {
  const l = Math.sqrt(a.x * a.x + a.z * a.z);
  return l > 1e-6 ? { x: a.x / l, y: 0, z: a.z / l } : { x: 0, y: 0, z: 0 };
}
export function lerp(a, b, t) {
  return a + (b - a) * t;
}
export function lerpV(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}
export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
export function floorV(a) {
  return { x: Math.floor(a.x), y: Math.floor(a.y), z: Math.floor(a.z) };
}
export function centerOf(blockLoc) {
  return { x: blockLoc.x + 0.5, y: blockLoc.y + 0.5, z: blockLoc.z + 0.5 };
}
export function rand(lo, hi) {
  return lo + Math.random() * (hi - lo);
}
export function randInt(lo, hi) {
  return Math.floor(lo + Math.random() * (hi - lo + 1));
}
export function randomUnit() {
  const u = Math.random() * 2 - 1;
  const t = Math.random() * Math.PI * 2;
  const r = Math.sqrt(1 - u * u);
  return { x: r * Math.cos(t), y: u, z: r * Math.sin(t) };
}
/** Right-hand horizontal perpendicular of a forward vector (player's right side). */
export function rightOf(forward) {
  const f = hnorm(forward);
  // Minecraft: yaw 0 faces +Z, right side is -X.
  return { x: -f.z, y: 0, z: f.x };
}
/** Unit direction from a rotation (pitch x, yaw y) in degrees, Minecraft convention. */
export function dirFromRotation(rot) {
  const pitch = (rot.x * Math.PI) / 180;
  const yaw = (rot.y * Math.PI) / 180;
  const c = Math.cos(pitch);
  return { x: -Math.sin(yaw) * c, y: -Math.sin(pitch), z: Math.cos(yaw) * c };
}
/** Angle in degrees between two vectors. */
export function angleBetween(a, b) {
  const d = dot(norm(a), norm(b));
  return (Math.acos(clamp(d, -1, 1)) * 180) / Math.PI;
}
export function key(loc) {
  return `${Math.floor(loc.x)},${Math.floor(loc.y)},${Math.floor(loc.z)}`;
}
export function fmt(v) {
  return `${v.x.toFixed(2)} ${v.y.toFixed(2)} ${v.z.toFixed(2)}`;
}
