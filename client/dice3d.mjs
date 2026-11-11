import * as THREE from 'three';
import { dieShape, traySize } from './dice-shapes.mjs';
import { simulateDice, frameAt } from './dice-physics.mjs';

const colors = ['#93493d', '#32604e', '#385b79', '#96713c', '#65547e'];
export class DiceTray {
  constructor(container, onUnavailable = () => {}) {
    this.container = container;
    this.onUnavailable = onUnavailable;
    this.generation = 0;
    this.resources = new Set();
    this.materials = new Map();
    this.models = new Map();
    this.dice = [];
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setClearColor(0x143a30, 0);
    this.renderer.domElement.setAttribute('aria-hidden', 'true');
    container.append(this.renderer.domElement);
    this.contextLost = event => { event.preventDefault(); onUnavailable(); };
    this.renderer.domElement.addEventListener('webglcontextlost', this.contextLost);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    this.scene.add(new THREE.HemisphereLight(0xfff4d8, 0x16362b, 2.3));
    const light = new THREE.DirectionalLight(0xffe6ba, 4);
    light.position.set(-4, 12, 6); light.castShadow = true;
    light.shadow.mapSize.set(1024, 1024);
    Object.assign(light.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9 });
    light.shadow.normalBias = 0.035;
    this.scene.add(light);
    this.table = new THREE.Group(); this.scene.add(this.table);
    this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(container);
    this.setTable(traySize(3));
    this.resize();
  }

  own(resource) { this.resources.add(resource); return resource; }
  setTable(size) {
    if (this.size?.width === size.width && this.size?.depth === size.depth) return;
    for (const object of [...this.table.children]) {
      object.geometry.dispose(); this.resources.delete(object.geometry);
      object.material.dispose(); this.resources.delete(object.material);
      this.table.remove(object);
    }
    this.size = size;
    const add = (geometry, color, position, roughness = 0.8) => {
      const mesh = new THREE.Mesh(this.own(geometry), this.own(new THREE.MeshStandardMaterial({ color, roughness })));
      mesh.position.set(...position); mesh.receiveShadow = true;
      this.table.add(mesh); return mesh;
    };
    const floor = add(new THREE.PlaneGeometry(size.width, size.depth), '#174537', [0, -0.02, 0]); floor.rotation.x = -Math.PI / 2;
    for (const z of [-1, 1]) add(new THREE.BoxGeometry(size.width + 0.24, 0.25, 0.13), '#b69250', [0, 0.06, z * (size.depth / 2 + 0.04)], 0.5);
    for (const x of [-1, 1]) add(new THREE.BoxGeometry(0.13, 0.25, size.depth + 0.24), '#b69250', [x * (size.width / 2 + 0.04), 0.06, 0], 0.5);
  }

  geometry(model) {
    if (this.models.has(model.sides)) return this.models.get(model.sides);
    const positions = [], normals = [], uv = [], geometry = new THREE.BufferGeometry();
    for (const [materialIndex, face] of model.faces.entries()) {
      const radius = Math.max(...face.indices.map(index => model.vertices[index].distanceTo(face.center)));
      const start = positions.length / 3;
      for (let j = 1; j < face.indices.length - 1; j++) {
        for (const index of [face.indices[0], face.indices[j], face.indices[j + 1]]) {
          const point = model.vertices[index], offset = point.clone().sub(face.center);
          positions.push(...point.toArray()); normals.push(...face.normal.toArray());
          uv.push(0.5 + offset.dot(face.x) / (2 * radius), 0.5 + offset.dot(face.y) / (2 * radius));
        }
      }
      geometry.addGroup(start, positions.length / 3 - start, materialIndex);
    }
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    this.own(geometry); this.models.set(model.sides, geometry); return geometry;
  }

  material(model, face, color) {
    const key = `${model.sides}:${face.value}:${color}`;
    if (this.materials.has(key)) return this.materials.get(key);
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
    const context = canvas.getContext('2d');
    context.fillStyle = color; context.fillRect(0, 0, 128, 128);
    context.strokeStyle = '#e4c58a'; context.lineWidth = 1.5;
    const radius = Math.max(...face.indices.map(index => model.vertices[index].distanceTo(face.center)));
    context.beginPath();
    face.indices.forEach((index, i) => {
      const point = model.vertices[index].clone().sub(face.center);
      const x = 64 + point.dot(face.x) / radius * 59, y = 64 - point.dot(face.y) / radius * 59;
      if (i) context.lineTo(x, y); else context.moveTo(x, y);
    });
    context.closePath(); context.stroke();
    context.fillStyle = '#fff1cd';
    if (model.sides === 6) {
      const patterns = { 1: [[0, 0]], 2: [[-1, -1], [1, 1]], 3: [[-1, -1], [0, 0], [1, 1]], 4: [[-1, -1], [-1, 1], [1, -1], [1, 1]], 5: [[-1, -1], [-1, 1], [0, 0], [1, -1], [1, 1]], 6: [[-1, -1], [-1, 0], [-1, 1], [1, -1], [1, 0], [1, 1]] };
      // Square UV axes run along a diagonal; keep pips well inside the face.
      for (const [x, y] of patterns[face.value]) { context.beginPath(); context.arc(64 + x * 19, 64 + y * 19, 6, 0, 2 * Math.PI); context.fill(); }
    } else {
      context.font = `bold ${[4, 8, 20].includes(model.sides) ? 40 : 48}px Georgia`;
      context.textAlign = 'center'; context.textBaseline = 'middle';
      context.fillText(String(face.value), 64, 65);
      if ([6, 9].includes(face.value)) { context.fillRect(55, 87, 18, 2); }
    }
    const texture = this.own(new THREE.CanvasTexture(canvas)); texture.colorSpace = THREE.SRGBColorSpace;
    const material = this.own(new THREE.MeshStandardMaterial({ map: texture, roughness: 0.43, metalness: 0.14 }));
    this.materials.set(key, material); return material;
  }

  clearDice() { for (const mesh of this.dice) this.scene.remove(mesh); this.dice = []; }
  makeDice(model, values) {
    this.clearDice();
    this.dice = values.map((_, i) => {
      const mesh = new THREE.Mesh(this.geometry(model), model.faces.map(face => this.material(model, face, colors[i % colors.length])));
      mesh.castShadow = mesh.receiveShadow = true; this.scene.add(mesh); return mesh;
    });
  }

  resize() {
    if (this.disposed) return;
    const { width, height } = this.container.getBoundingClientRect();
    if (!width || !height) return;
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    const span = Math.max(this.size.width / this.camera.aspect, this.size.depth * 0.94) + 2;
    const distance = span / (2 * Math.tan(THREE.MathUtils.degToRad(19)));
    this.camera.position.set(0, distance * 0.88, distance * 0.48); this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix(); this.render();
  }
  render() { if (!this.disposed) this.renderer.render(this.scene, this.camera); }
  stop() { this.generation++; cancelAnimationFrame(this.frame); this.frame = null; }

  async show(roll, { animate = false, onComplete = () => {} } = {}) {
    this.stop(); const generation = this.generation;
    const sides = Number(roll.expression.match(/d(\d+)/)?.[1]);
    const model = dieShape(sides);
    if (this.playback?.id !== roll.id) this.playback = null;
    if (!model) { this.clearDice(); this.render(); return false; }
    this.setTable(traySize(roll.results.length));
    if (!animate) {
      this.makeDice(model, roll.results);
      const cols = Math.min(roll.results.length, 5), rows = Math.ceil(roll.results.length / cols);
      for (const [i, mesh] of this.dice.entries()) {
        const source = model.faces.find(face => face.value === roll.results[i]);
        mesh.quaternion.setFromUnitVectors(source.normal, new THREE.Vector3(0, 1, 0));
        const lowest = Math.min(...model.vertices.map(vertex => vertex.clone().applyQuaternion(mesh.quaternion).y));
        mesh.position.set((i % cols - (cols - 1) / 2) * 1.65, -lowest + 0.01, (Math.floor(i / cols) - (rows - 1) / 2) * 1.65);
      }
      this.resize(); onComplete(); return true;
    }
    const playback = this.playback?.value ?? await simulateDice(sides, roll.results, { cancelled: () => this.disposed || generation !== this.generation });
    if (!playback || this.disposed || generation !== this.generation) return false;
    this.playback = { id: roll.id, value: playback };
    this.makeDice(model, roll.results); this.resize();
    const started = performance.now(), q = new THREE.Quaternion(), target = new THREE.Quaternion();
    const draw = now => {
      if (this.disposed || generation !== this.generation) return;
      const index = frameAt(now - started, playback.step, playback.frames.length), lower = Math.floor(index), blend = index - lower;
      const first = playback.frames[lower], second = playback.frames[Math.min(lower + 1, playback.frames.length - 1)];
      this.dice.forEach((mesh, i) => {
        const offset = i * 7;
        mesh.position.set(...[0, 1, 2].map(axis => THREE.MathUtils.lerp(first[offset + axis], second[offset + axis], blend)));
        q.fromArray(first, offset + 3); target.fromArray(second, offset + 3);
        mesh.quaternion.copy(q.slerp(target, blend).multiply(playback.offsets[i]));
      });
      this.render();
      if (index < playback.frames.length - 1) this.frame = requestAnimationFrame(draw);
      else { this.frame = null; onComplete(); }
    };
    this.frame = requestAnimationFrame(draw); return true;
  }

  reset() { this.stop(); this.playback = null; this.clearDice(); this.render(); }
  dispose() {
    if (this.disposed) return;
    this.stop(); this.disposed = true; this.observer.disconnect();
    this.renderer.domElement.removeEventListener('webglcontextlost', this.contextLost);
    for (const resource of this.resources) resource.dispose();
    this.resources.clear(); this.materials.clear(); this.models.clear();
    this.playback = null;
    this.renderer.dispose(); this.renderer.forceContextLoss(); this.renderer.domElement.remove();
    this.clearDice();
  }
}
