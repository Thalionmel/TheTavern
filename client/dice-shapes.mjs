import { BoxGeometry, TetrahedronGeometry, OctahedronGeometry, DodecahedronGeometry, IcosahedronGeometry, Vector3, Matrix4, Quaternion } from 'three';

export const supportedDice = new Set([4, 6, 8, 10, 12, 20]);
const cache = new Map();
const key = point => point.toArray().map(n => Math.round(n * 100000)).join(',');

export function dieShape(sides) {
  if (cache.has(sides)) return cache.get(sides);
  if (!supportedDice.has(sides)) return null;
  const vertices = [], polygons = [];
  if (sides === 10) {
    const height = 0.95, ring = height * (1 - Math.cos(Math.PI / 5)) / (1 + Math.cos(Math.PI / 5));
    vertices.push(new Vector3(0, height, 0), new Vector3(0, -height, 0));
    for (let i = 0; i < 10; i++) vertices.push(new Vector3(Math.cos(i * Math.PI / 5) * 0.8, i % 2 ? ring : -ring, Math.sin(i * Math.PI / 5) * 0.8));
    for (let i = 0; i < 10; i++) polygons.push([i % 2 ? 1 : 0, 2 + (i + 9) % 10, 2 + i, 2 + (i + 1) % 10]);
  } else {
    const constructors = { 4: TetrahedronGeometry, 6: BoxGeometry, 8: OctahedronGeometry, 12: DodecahedronGeometry, 20: IcosahedronGeometry };
    let source = sides === 6 ? new BoxGeometry(1.12, 1.12, 1.12) : new constructors[sides](0.79, 0);
    if (source.index) { const expanded = source.toNonIndexed(); source.dispose(); source = expanded; }
    const points = source.getAttribute('position'), indices = new Map(), planes = new Map();
    for (let i = 0; i < points.count; i += 3) {
      const triangle = [0, 1, 2].map(j => new Vector3().fromBufferAttribute(points, i + j));
      const normal = new Vector3().subVectors(triangle[1], triangle[0]).cross(new Vector3().subVectors(triangle[2], triangle[0])).normalize();
      const plane = `${key(normal)}:${Math.round(normal.dot(triangle[0]) * 100000)}`;
      if (!planes.has(plane)) planes.set(plane, new Set());
      for (const point of triangle) {
        if (!indices.has(key(point))) { indices.set(key(point), vertices.length); vertices.push(point); }
        planes.get(plane).add(indices.get(key(point)));
      }
    }
    polygons.push(...[...planes.values()].map(face => [...face]));
    source.dispose();
  }
  const faces = polygons.map(indices => {
    const center = indices.reduce((sum, index) => sum.add(vertices[index]), new Vector3()).divideScalar(indices.length);
    const normal = new Vector3().subVectors(vertices[indices[1]], vertices[indices[0]]).cross(new Vector3().subVectors(vertices[indices[2]], vertices[indices[0]])).normalize();
    if (normal.dot(center) < 0) normal.negate();
    const x = new Vector3().subVectors(vertices[indices[0]], center).normalize(), y = new Vector3().crossVectors(normal, x);
    indices.sort((a, b) => {
      const pa = vertices[a].clone().sub(center), pb = vertices[b].clone().sub(center);
      return Math.atan2(pa.dot(y), pa.dot(x)) - Math.atan2(pb.dot(y), pb.dot(x));
    });
    return { indices, center, normal, x, y, basis: new Matrix4().makeBasis(x, y, normal), value: 0 };
  });
  let next = 1;
  for (const face of faces) {
    if (face.value) continue;
    while (faces.some(other => other.value === next)) next++;
    face.value = next;
    const opposite = faces.find(other => !other.value && other.normal.dot(face.normal) < -0.9999);
    if (opposite) opposite.value = sides + 1 - next;
  }
  const shape = { sides, vertices, faces };
  cache.set(sides, shape);
  return shape;
}

// Rotate the labelled mesh by a symmetry of the solid before playback. The
// collision body and its trajectory stay unchanged; its upper face then reads
// the server's result. No result is generated or changed by the animation.
export function resultOffset(shape, bodyQuaternion, value) {
  const up = new Vector3(0, 1, 0.0001).normalize();
  const upper = shape.faces.reduce((best, face) => face.normal.clone().applyQuaternion(bodyQuaternion).dot(up) > best.normal.clone().applyQuaternion(bodyQuaternion).dot(up) ? face : best);
  const source = shape.faces.find(face => face.value === value);
  if (!source) throw new Error('The result does not fit this die.');
  return new Quaternion().setFromRotationMatrix(upper.basis.clone().multiply(source.basis.clone().transpose()));
}

export function traySize(count) {
  return { width: Math.max(6.8, Math.min(count, 5) * 1.85 + 1), depth: Math.max(4.5, Math.ceil(count / 5) * 1.8 + 1) };
}
