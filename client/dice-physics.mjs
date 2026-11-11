import { World, Body, Vec3, Plane, ConvexPolyhedron } from 'cannon-es';
import { Quaternion } from 'three';
import { dieShape, resultOffset, traySize } from './dice-shapes.mjs';

const STEP = 1 / 90;
export function frameAt(elapsedMs, step, frameCount) {
  return Math.min(Math.max(elapsedMs / 1000 / step, 0), frameCount - 1);
}
export async function simulateDice(sides, values, { cancelled = () => false, yieldFrame = () => new Promise(resolve => setTimeout(resolve, 0)) } = {}) {
  const model = dieShape(sides), size = traySize(values.length);
  if (!model || !values.length || values.length > 20) throw new Error('Unsupported dice tray.');
  const world = new World({ gravity: new Vec3(0, -28, 0), allowSleep: true });
  world.defaultContactMaterial.friction = 0.55;
  world.defaultContactMaterial.restitution = 0.34;
  world.solver.iterations = 14;
  const plane = (position, rotation) => {
    const body = new Body({ mass: 0, shape: new Plane(), position: new Vec3(...position) });
    body.quaternion.setFromEuler(...rotation); world.addBody(body);
  };
  plane([0, 0, 0], [-Math.PI / 2, 0, 0]);
  plane([-size.width / 2, 0, 0], [0, Math.PI / 2, 0]);
  plane([size.width / 2, 0, 0], [0, -Math.PI / 2, 0]);
  plane([0, 0, -size.depth / 2], [0, 0, 0]);
  plane([0, 0, size.depth / 2], [0, Math.PI, 0]);
  const cols = Math.min(values.length, 5), rows = Math.ceil(values.length / cols);
  const bodies = values.map((value, i) => {
    if (!Number.isInteger(value) || value < 1 || value > sides) throw new Error('Invalid server result.');
    const shape = new ConvexPolyhedron({ vertices: model.vertices.map(p => new Vec3(p.x, p.y, p.z)), faces: model.faces.map(face => face.indices) });
    const body = new Body({ mass: 1, shape, linearDamping: 0.26, angularDamping: 0.26, sleepSpeedLimit: 0.22, sleepTimeLimit: 0.25 });
    body.position.set((i % cols - (cols - 1) / 2) * 1.7, 2.7 + (i % 3) * 0.5, (Math.floor(i / cols) - (rows - 1) / 2) * 1.7);
    body.quaternion.setFromEuler(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    body.velocity.set((Math.random() - 0.5) * 5, -1, (Math.random() - 0.5) * 3);
    body.angularVelocity.set(9 + Math.random() * 8, (Math.random() - 0.5) * 16, 6 + Math.random() * 9);
    world.addBody(body); return body;
  });
  const frames = [];
  for (let step = 0; step < 360; step++) {
    if (cancelled()) return null;
    world.step(STEP);
    frames.push(Float32Array.from(bodies.flatMap(body => [...body.position.toArray(), ...body.quaternion.toArray()])));
    if (step > 130 && bodies.every(body => body.sleepState === Body.SLEEPING)) break;
    if (step % 18 === 0) await yieldFrame();
  }
  const offsets = bodies.map((body, i) => resultOffset(model, new Quaternion(...body.quaternion.toArray()), values[i]));
  return { frames, offsets, step: STEP, size };
}
