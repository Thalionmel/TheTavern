import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion, Vector3 } from 'three';
import { dieShape, resultOffset, supportedDice } from '../client/dice-shapes.mjs';
import { simulateDice, frameAt } from '../client/dice-physics.mjs';

for (const sides of supportedDice) {
  test(`d${sides}: closed convex faces, unique values and result-preserving rotations`, () => {
    const model = dieShape(sides);
    assert.equal(model.faces.length, sides);
    assert.deepEqual(model.faces.map(face => face.value).sort((a, b) => a - b), Array.from({ length: sides }, (_, i) => i + 1));
    const edges = new Map();
    for (const face of model.faces) {
      for (const index of face.indices) assert.ok(Math.abs(model.vertices[index].clone().sub(face.center).dot(face.normal)) < 1e-5, 'face is planar');
      for (const vertex of model.vertices) assert.ok(vertex.clone().sub(face.center).dot(face.normal) < 1e-5, 'face points outward from a convex solid');
      face.indices.forEach((index, i) => { const edge = [index, face.indices[(i + 1) % face.indices.length]].sort((a, b) => a - b).join(':'); edges.set(edge, (edges.get(edge) ?? 0) + 1); });
    }
    assert.ok([...edges.values()].every(count => count === 2), 'every edge is shared by exactly two faces');
    for (const target of model.faces) {
      const body = new Quaternion().setFromUnitVectors(target.normal, new Vector3(0, 1, 0));
      for (let value = 1; value <= sides; value++) {
        const offset = resultOffset(model, body, value);
        for (const vertex of model.vertices) {
          const mapped = vertex.clone().applyQuaternion(offset);
          assert.ok(model.vertices.some(other => other.distanceTo(mapped) < 1e-5), `rotation preserves the collision solid for ${value}`);
        }
        const normal = model.faces.find(face => face.value === value).normal.clone().applyQuaternion(offset).applyQuaternion(body);
        assert.ok(normal.y > 0.9999, `visible face agrees with the server's ${value}`);
      }
    }
  });
}

test('physical playback handles 20 d20 and preserves every supplied result', async () => {
  const values = Array.from({ length: 20 }, (_, i) => i + 1);
  const playback = await simulateDice(20, values, { yieldFrame: async () => {} });
  assert.equal(playback.offsets.length, 20);
  assert.ok(playback.frames.length > 100);
  const final = playback.frames.at(-1), model = dieShape(20);
  for (let i = 0; i < 20; i++) {
    const position = new Vector3().fromArray(final, i * 7);
    assert.ok(Number.isFinite(position.y) && position.y > 0 && position.y < 4);
    assert.ok(Math.abs(position.x) < playback.size.width / 2 + 0.01);
    assert.ok(Math.abs(position.z) < playback.size.depth / 2 + 0.01);
    const body = new Quaternion().fromArray(final, i * 7 + 3);
    const actual = model.faces.find(face => face.value === values[i]).normal.clone().applyQuaternion(playback.offsets[i]).applyQuaternion(body);
    assert.ok(model.faces.every(face => actual.y >= face.normal.clone().applyQuaternion(body).y - 1e-5));
  }
  assert.deepEqual(values, Array.from({ length: 20 }, (_, i) => i + 1));
});

test('cancelled playback stops without creating an alternative result', async () => {
  assert.equal(await simulateDice(6, [3], { cancelled: () => true }), null);
  assert.equal(dieShape(37), null);
  await assert.rejects(simulateDice(6, [7]));
});

test('animation frames stay valid when the first browser timestamp predates setup or a frame is delayed', () => {
  assert.equal(frameAt(-8, 1 / 90, 200), 0);
  assert.equal(frameAt(0, 1 / 90, 200), 0);
  assert.equal(frameAt(100000, 1 / 90, 200), 199);
  assert.equal(frameAt(50, 1 / 100, 200), 5);
});
