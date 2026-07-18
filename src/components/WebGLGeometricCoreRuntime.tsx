import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import type { WebGLModelVariant } from '../types/modelGeometry';
import { ModelGeometricEmblem } from './ModelGeometricEmblem';
import './WebGLGeometricCore.css';

export type WebGLLightMode = 'spot' | 'area' | 'target' | 'sun';
export type WebGLModelMode = 'render' | 'rotation' | 'texture';

export type WebGLGeometricCoreProps = {
  className?: string;
  ariaLabel?: string;
  paused?: boolean;
  intensity?: number;
  shadow?: number;
  lightMode?: WebGLLightMode;
  mode?: WebGLModelMode;
  /** Rotation-speed multiplier. A value of 1 is the designed default. */
  rotationSpeed?: number;
  /** Distinct editorial geometry topology displayed by the shared renderer. */
  variant?: WebGLModelVariant;
};

type RuntimeControls = Required<Pick<
  WebGLGeometricCoreProps,
  'paused' | 'intensity' | 'shadow' | 'lightMode' | 'mode' | 'rotationSpeed'
>>;

type VisualPalette = {
  facets: readonly [number, number, number, number];
  edge: number;
  wire: number;
  orbit: number;
  node: number;
  core: number;
  coreEdge: number;
  light: number;
  ground: number;
};

type ModelAssembly = {
  variant: WebGLModelVariant;
  group: THREE.Group;
  animate: (elapsed: number, pointerX: number, pointerY: number) => void;
};

type ModelMaterials = {
  facets: THREE.MeshStandardMaterial[];
  outline: THREE.MeshBasicMaterial;
  edge: THREE.LineBasicMaterial;
  dark: THREE.MeshStandardMaterial;
  light: THREE.MeshStandardMaterial;
  wire: THREE.LineBasicMaterial;
  glow: THREE.MeshStandardMaterial;
};

const DAY_PALETTE: VisualPalette = {
  facets: [0xe3e7e8, 0xaeb6ba, 0x515b60, 0x14191c],
  edge: 0x111619,
  wire: 0x30383d,
  orbit: 0x22292d,
  node: 0x11171a,
  core: 0x070a0c,
  coreEdge: 0xe4e8e9,
  light: 0xf0f3f3,
  ground: 0x4f5a60,
};

const NIGHT_PALETTE: VisualPalette = {
  facets: [0xdce2e4, 0x899499, 0x343d42, 0x0a0e10],
  edge: 0xd7dee0,
  wire: 0x9ba6ab,
  orbit: 0xb8c1c5,
  node: 0xe2e7e9,
  core: 0x030506,
  coreEdge: 0xf1f4f5,
  light: 0xf4f7f7,
  ground: 0x000000,
};

const ease = (current: number, target: number, amount: number) =>
  current + (target - current) * amount;

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));

const easeInCubic = (value: number) => value * value * value;
const easeOutBack = (value: number) => {
  const overshoot = 1.18;
  const shifted = value - 1;
  return 1 + (overshoot + 1) * shifted * shifted * shifted + overshoot * shifted * shifted;
};

const isNightTheme = () => {
  const root = document.documentElement;
  if (root.dataset.visualTheme) return root.dataset.visualTheme === 'night';
  return root.dataset.theme === 'dark';
};

function createOrbitGeometry(radiusX: number, radiusY: number, segments = 160) {
  const points: THREE.Vector3[] = [];
  for (let index = 0; index <= segments; index += 1) {
    const angle = (index / segments) * Math.PI * 2;
    points.push(new THREE.Vector3(Math.cos(angle) * radiusX, Math.sin(angle) * radiusY, 0));
  }
  return new THREE.BufferGeometry().setFromPoints(points);
}

function createDrawingTexture(hatchStrength: number) {
  const drawingCanvas = document.createElement('canvas');
  drawingCanvas.width = 256;
  drawingCanvas.height = 256;
  const context = drawingCanvas.getContext('2d');
  if (context) {
    context.fillStyle = '#eef0ef';
    context.fillRect(0, 0, 256, 256);
    let seed = 0x5f3759df;
    for (let index = 0; index < 2100; index += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const x = ((seed & 0xffff) / 0xffff) * 256;
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const y = ((seed & 0xffff) / 0xffff) * 256;
      const alpha = 0.018 + ((seed >>> 24) / 255) * 0.04;
      context.fillStyle = `rgba(21,27,30,${alpha})`;
      context.fillRect(x, y, 0.45 + ((seed >>> 16) & 1), 0.45);
    }
    context.lineWidth = 0.72;
    context.strokeStyle = `rgba(24,30,33,${hatchStrength})`;
    for (let offset = -256; offset <= 512; offset += 13) {
      context.beginPath();
      context.moveTo(offset, 0);
      context.lineTo(offset - 256, 256);
      context.stroke();
    }
    if (hatchStrength > 0.07) {
      context.strokeStyle = `rgba(24,30,33,${hatchStrength * 0.48})`;
      for (let offset = -256; offset <= 512; offset += 19) {
        context.beginPath();
        context.moveTo(offset, 0);
        context.lineTo(offset + 256, 256);
        context.stroke();
      }
    }
  }
  const texture = new THREE.CanvasTexture(drawingCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2.2, 2.45);
  return texture;
}

function addOutlinedMesh(
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  materials: ModelMaterials,
  edgeThreshold = 16,
) {
  const part = new THREE.Group();
  const outline = new THREE.Mesh(geometry, materials.outline);
  outline.scale.setScalar(1.025);
  outline.material.side = THREE.BackSide;
  const mesh = new THREE.Mesh(geometry, material);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, edgeThreshold), materials.edge);
  part.add(outline, mesh, edges);
  parent.add(part);
  return part;
}

function addWireGeometry(
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  material: THREE.LineBasicMaterial,
  threshold = 12,
) {
  const line = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, threshold), material);
  parent.add(line);
  geometry.dispose();
  return line;
}

function buildGptAssembly(materials: ModelMaterials): ModelAssembly {
  const group = new THREE.Group();
  const knot = new THREE.Group();
  const petals: THREE.Group[] = [];
  const shape = new THREE.Shape();
  shape.moveTo(-0.23, -0.7);
  shape.lineTo(0.25, -0.58);
  shape.lineTo(0.47, 0.02);
  shape.lineTo(0.18, 0.72);
  shape.lineTo(-0.21, 0.54);
  shape.lineTo(-0.08, 0.04);
  shape.closePath();
  for (let index = 0; index < 6; index += 1) {
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: 0.27,
      bevelEnabled: true,
      bevelSegments: 1,
      bevelSize: 0.045,
      bevelThickness: 0.045,
      curveSegments: 1,
    });
    geometry.center();
    const petal = addOutlinedMesh(knot, geometry, materials.facets[index % 4], materials, 22);
    const angle = (index / 6) * Math.PI * 2;
    petal.position.set(Math.cos(angle) * 0.84, Math.sin(angle) * 0.84, index % 2 ? -0.08 : 0.08);
    petal.rotation.z = angle - Math.PI / 2;
    petal.rotation.x = index % 2 ? -0.1 : 0.1;
    petals.push(petal);
  }
  const seed = addOutlinedMesh(
    knot,
    new THREE.CylinderGeometry(0.31, 0.31, 0.38, 6, 1, false),
    materials.dark,
    materials,
    8,
  );
  seed.rotation.x = Math.PI / 2;
  group.add(knot);
  addWireGeometry(group, new THREE.IcosahedronGeometry(2.02, 0), materials.wire).scale.set(1.08, 0.98, 0.82);
  return {
    variant: 'gpt',
    group,
    animate: (elapsed, pointerX, pointerY) => {
      knot.rotation.y = elapsed * 0.31 + pointerX * 0.25;
      knot.rotation.x = -0.12 + Math.sin(elapsed * 0.47) * 0.04 + pointerY * 0.14;
      seed.rotation.z = -elapsed * 0.42;
      petals.forEach((petal, index) => {
        petal.position.z = (index % 2 ? -0.08 : 0.08) + Math.sin(elapsed * 0.7 + index) * 0.018;
      });
    },
  };
}

function buildClaudeAssembly(materials: ModelMaterials): ModelAssembly {
  const group = new THREE.Group();
  const crown = new THREE.Group();
  const leaves: THREE.Group[] = [];
  for (let index = 0; index < 6; index += 1) {
    const leaf = addOutlinedMesh(
      crown,
      new THREE.TetrahedronGeometry(0.82, 0),
      materials.facets[(index + 1) % 4],
      materials,
      5,
    );
    const angle = (index / 6) * Math.PI * 2;
    leaf.scale.set(0.66, 1.4, 0.42);
    leaf.position.set(Math.cos(angle) * 0.84, Math.sin(angle) * 0.84, Math.sin(angle * 2) * 0.13);
    leaf.rotation.set(0.24 * Math.sin(angle), -0.22 * Math.cos(angle), angle - Math.PI / 2);
    leaves.push(leaf);
  }
  const core = addOutlinedMesh(crown, new THREE.IcosahedronGeometry(0.48, 0), materials.dark, materials, 8);
  core.rotation.z = Math.PI / 5;
  group.add(crown);
  const triangleCage = addWireGeometry(group, new THREE.OctahedronGeometry(2.16, 0), materials.wire, 5);
  triangleCage.rotation.set(0.24, 0.38, 0.1);
  return {
    variant: 'claude',
    group,
    animate: (elapsed, pointerX, pointerY) => {
      crown.rotation.y = elapsed * 0.24 + pointerX * 0.24;
      crown.rotation.x = -0.08 + pointerY * 0.12;
      leaves.forEach((leaf, index) => {
        const breath = 1 + Math.sin(elapsed * 0.62 + index * 0.7) * 0.025;
        leaf.scale.y = 1.4 * breath;
      });
      core.rotation.y = -elapsed * 0.4;
      triangleCage.rotation.z = 0.1 - elapsed * 0.035;
    },
  };
}

function buildCodexAssembly(materials: ModelMaterials): ModelAssembly {
  const group = new THREE.Group();
  const vault = new THREE.Group();
  const frames: THREE.LineSegments[] = [];
  [2.35, 1.82, 1.34].forEach((size, index) => {
    const frameMaterial = materials.wire.clone();
    frameMaterial.userData.assemblyOwned = true;
    frameMaterial.opacity = 0.23 + index * 0.12;
    const sourceGeometry = new THREE.BoxGeometry(size, size, size);
    const edgeGeometry = new THREE.EdgesGeometry(sourceGeometry, 1);
    sourceGeometry.dispose();
    const frame = new THREE.LineSegments(
      edgeGeometry,
      frameMaterial,
    );
    frame.rotation.set(index * 0.13, index * -0.19, index * 0.09);
    vault.add(frame);
    frames.push(frame);
  });
  const block = addOutlinedMesh(vault, new THREE.BoxGeometry(0.94, 0.94, 0.94), materials.facets[3], materials, 1);
  block.rotation.set(-0.14, 0.28, 0.05);
  const windowPlane = new THREE.Mesh(new THREE.PlaneGeometry(0.58, 0.4), materials.light);
  windowPlane.position.set(0, 0, 0.486);
  block.add(windowPlane);
  const commandGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-0.12, 0.08, 0.498),
    new THREE.Vector3(-0.2, 0, 0.498),
    new THREE.Vector3(-0.12, -0.08, 0.498),
    new THREE.Vector3(0.05, -0.1, 0.498),
    new THREE.Vector3(0.14, 0.1, 0.498),
  ]);
  const command = new THREE.Line(commandGeometry, materials.wire);
  block.add(command);
  vault.scale.setScalar(1.16);
  group.add(vault);
  return {
    variant: 'codex',
    group,
    animate: (elapsed, pointerX, pointerY) => {
      vault.rotation.y = Math.sin(elapsed * 0.24) * 0.3 + pointerX * 0.16;
      vault.rotation.x = -0.08 + pointerY * 0.12;
      frames.forEach((frame, index) => {
        frame.rotation.y = index * -0.19 + elapsed * (index % 2 ? -0.08 : 0.055);
        frame.rotation.z = index * 0.09 + Math.sin(elapsed * 0.25 + index) * 0.025;
      });
      block.rotation.y = 0.28 + Math.sin(elapsed * 0.4) * 0.16;
    },
  };
}

function buildGeminiAssembly(materials: ModelMaterials): ModelAssembly {
  const group = new THREE.Group();
  const twin = new THREE.Group();
  const first = addOutlinedMesh(twin, new THREE.OctahedronGeometry(1.46, 0), materials.facets[0], materials, 6);
  first.scale.set(1.48, 0.43, 0.31);
  first.position.z = 0.43;
  first.rotation.z = Math.PI / 4;
  const second = addOutlinedMesh(twin, new THREE.OctahedronGeometry(1.46, 0), materials.facets[2], materials, 6);
  second.scale.set(0.43, 1.48, 0.31);
  second.position.z = -0.43;
  second.rotation.z = Math.PI / 4;
  const seam = new THREE.Mesh(new THREE.SphereGeometry(0.2, 20, 12), materials.glow);
  twin.add(seam);
  group.add(twin);
  const crossCage = addWireGeometry(group, new THREE.DodecahedronGeometry(2.04, 0), materials.wire, 6);
  crossCage.scale.z = 0.8;
  return {
    variant: 'gemini',
    group,
    animate: (elapsed, pointerX, pointerY) => {
      twin.rotation.y = elapsed * 0.22 + pointerX * 0.22;
      twin.rotation.x = pointerY * 0.12;
      first.rotation.y = elapsed * 0.18;
      second.rotation.y = -elapsed * 0.18;
      seam.scale.setScalar(1 + Math.sin(elapsed * 1.25) * 0.055);
      crossCage.rotation.z = elapsed * 0.035;
    },
  };
}

function buildAntigravityAssembly(materials: ModelMaterials): ModelAssembly {
  const group = new THREE.Group();
  const gyro = new THREE.Group();
  const body = addOutlinedMesh(
    gyro,
    new THREE.CylinderGeometry(0.58, 0.58, 1.48, 6, 1, false),
    materials.facets[2],
    materials,
    8,
  );
  const top = addOutlinedMesh(gyro, new THREE.ConeGeometry(0.58, 0.64, 6, 1, false), materials.facets[0], materials, 8);
  top.position.y = 1.04;
  const bottom = addOutlinedMesh(gyro, new THREE.ConeGeometry(0.58, 0.64, 6, 1, false), materials.dark, materials, 8);
  bottom.position.y = -1.04;
  bottom.rotation.z = Math.PI;
  const rings = [
    { radius: 1.48, tube: 0.018, rotation: new THREE.Euler(1.12, 0.16, 0.1) },
    { radius: 1.72, tube: 0.014, rotation: new THREE.Euler(0.42, 0.7, -0.34) },
    { radius: 1.92, tube: 0.012, rotation: new THREE.Euler(-0.52, 0.52, 0.54) },
  ].map((definition) => {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(definition.radius, definition.tube, 5, 96),
      materials.light,
    );
    ring.rotation.copy(definition.rotation);
    gyro.add(ring);
    return ring;
  });
  group.add(gyro);
  const baseArc = new THREE.Line(
    createOrbitGeometry(1.42, 0.3, 84),
    materials.wire,
  );
  baseArc.position.y = -1.84;
  baseArc.rotation.x = Math.PI / 2.8;
  group.add(baseArc);
  return {
    variant: 'antigravity',
    group,
    animate: (elapsed, pointerX, pointerY) => {
      gyro.position.y = Math.sin(elapsed * 0.75) * 0.045;
      gyro.rotation.y = elapsed * 0.18 + pointerX * 0.2;
      gyro.rotation.x = pointerY * 0.1;
      body.rotation.y = -elapsed * 0.31;
      rings[0].rotation.z = 0.1 + elapsed * 0.16;
      rings[1].rotation.y = 0.7 - elapsed * 0.11;
      rings[2].rotation.x = -0.52 + elapsed * 0.075;
    },
  };
}

function buildGithubAssembly(materials: ModelMaterials): ModelAssembly {
  const group = new THREE.Group();
  const lensNode = new THREE.Group();
  const shell = addOutlinedMesh(
    lensNode,
    new THREE.DodecahedronGeometry(1.34, 0),
    materials.facets[2],
    materials,
    8,
  );
  shell.scale.set(1.18, 0.92, 0.78);
  shell.rotation.x = 0.08;
  const lenses: THREE.Group[] = [];
  const apertureGlints: THREE.Mesh[] = [];
  [-0.54, 0.54].forEach((x) => {
    const lens = addOutlinedMesh(
      lensNode,
      new THREE.RingGeometry(0.19, 0.36, 12, 1),
      materials.light,
      materials,
      4,
    );
    lens.position.set(x, 0.16, 1.12);
    const aperture = new THREE.Mesh(new THREE.CircleGeometry(0.185, 12), materials.dark);
    aperture.position.set(x, 0.16, 1.115);
    lensNode.add(aperture);
    const glint = new THREE.Mesh(new THREE.CircleGeometry(0.047, 10), materials.glow);
    glint.position.set(x - 0.045, 0.205, 1.125);
    lensNode.add(glint);
    apertureGlints.push(glint);
    lenses.push(lens);
  });
  const bridge = addOutlinedMesh(lensNode, new THREE.BoxGeometry(0.5, 0.12, 0.12), materials.facets[1], materials, 1);
  bridge.position.set(0, 0.16, 1.08);
  [-1, 1].forEach((direction) => {
    const fin = addOutlinedMesh(
      lensNode,
      new THREE.BoxGeometry(0.44, 0.12, 0.18),
      materials.facets[1],
      materials,
      1,
    );
    fin.position.set(direction * 1.36, 0.04, 0.34);
    fin.rotation.z = direction * -0.18;
  });
  group.add(lensNode);
  const octagonalCage = addWireGeometry(group, new THREE.BoxGeometry(3.18, 2.32, 1.52), materials.wire, 1);
  octagonalCage.rotation.set(0.08, 0.12, Math.PI / 12);
  const railGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-2.15, 0.72, 0), new THREE.Vector3(2.15, 0.72, 0),
    new THREE.Vector3(-2.15, -0.58, 0), new THREE.Vector3(2.15, -0.58, 0),
  ]);
  const rails = new THREE.LineSegments(railGeometry, materials.wire);
  group.add(rails);
  return {
    variant: 'github',
    group,
    animate: (elapsed, pointerX, pointerY) => {
      lensNode.rotation.y = Math.sin(elapsed * 0.3) * 0.32 + pointerX * 0.14;
      lensNode.rotation.x = -0.03 + pointerY * 0.08;
      lenses.forEach((lens, index) => {
        lens.position.x = (index ? 0.54 : -0.54) + pointerX * 0.035;
        lens.position.y = 0.16 - pointerY * 0.028;
      });
      apertureGlints.forEach((glint, index) => {
        glint.position.x = (index ? 0.54 : -0.54) - 0.045 + pointerX * 0.055;
        glint.position.y = 0.205 - pointerY * 0.045;
        glint.scale.setScalar(0.92 + Math.sin(elapsed * 0.8 + index * Math.PI) * 0.08);
      });
      octagonalCage.rotation.z = Math.PI / 12 + Math.sin(elapsed * 0.22) * 0.035;
      rails.position.x = Math.sin(elapsed * 0.18) * 0.04;
    },
  };
}

function buildModelAssembly(variant: WebGLModelVariant, materials: ModelMaterials): ModelAssembly {
  switch (variant) {
    case 'claude': return buildClaudeAssembly(materials);
    case 'codex': return buildCodexAssembly(materials);
    case 'gemini': return buildGeminiAssembly(materials);
    case 'antigravity': return buildAntigravityAssembly(materials);
    case 'github': return buildGithubAssembly(materials);
    case 'gpt':
    default: return buildGptAssembly(materials);
  }
}

function disposeAssembly(assembly: ModelAssembly) {
  const geometries = new Set<THREE.BufferGeometry>();
  const ownedMaterials = new Set<THREE.Material>();
  assembly.group.traverse((object) => {
    if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.LineSegments) {
      geometries.add(object.geometry);
      const candidates = Array.isArray(object.material) ? object.material : [object.material];
      candidates.forEach((material) => {
        if (material.userData.assemblyOwned) ownedMaterials.add(material);
      });
    }
  });
  geometries.forEach((geometry) => geometry.dispose());
  ownedMaterials.forEach((material) => material.dispose());
  assembly.group.removeFromParent();
}

function StaticRuntimeFallback({ variant }: { variant: WebGLModelVariant }) {
  return (
    <span className="webgl-core-fallback-model" aria-hidden="true">
      <ModelGeometricEmblem kind={variant} />
    </span>
  );
}

export function WebGLGeometricCore({
  className = '',
  ariaLabel = '动态三维几何模型 / Interactive 3D geometry',
  paused = false,
  intensity = 62,
  shadow = 34,
  lightMode = 'spot',
  mode = 'render',
  rotationSpeed = 1,
  variant = 'gpt',
}: WebGLGeometricCoreProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const refreshRef = useRef<() => void>(() => undefined);
  const swapVariantRef = useRef<(next: WebGLModelVariant) => void>(() => undefined);
  const controlsRef = useRef<RuntimeControls>({
    paused,
    intensity: clamp(intensity, 0, 100),
    shadow: clamp(shadow, 0, 90),
    lightMode,
    mode,
    rotationSpeed: clamp(rotationSpeed, 0, 3),
  });
  const [webGLFailed, setWebGLFailed] = useState(false);

  controlsRef.current = {
    paused,
    intensity: clamp(intensity, 0, 100),
    shadow: clamp(shadow, 0, 90),
    lightMode,
    mode,
    rotationSpeed: clamp(rotationSpeed, 0, 3),
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host || webGLFailed) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: true,
        powerPreference: 'high-performance',
        premultipliedAlpha: true,
      });
    } catch {
      setWebGLFailed(true);
      return;
    }

    const canvas = renderer.domElement;
    canvas.className = 'webgl-geometric-core-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.tabIndex = -1;
    host.appendChild(canvas);
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(27, 1, 0.1, 40);
    camera.position.set(0, 0.08, 13);

    const root = new THREE.Group();
    const continuousCage = new THREE.Group();
    const modelSlot = new THREE.Group();
    const nodeAssembly = new THREE.Group();
    scene.add(root);
    root.add(continuousCage, modelSlot, nodeAssembly);

    const paperTexture = createDrawingTexture(0.035);
    const hatchTexture = createDrawingTexture(0.105);
    const facetMaterials = DAY_PALETTE.facets.map((color) => new THREE.MeshStandardMaterial({
      color,
      metalness: 0.025,
      roughness: 0.88,
      flatShading: true,
      side: THREE.DoubleSide,
      transparent: true,
      map: paperTexture,
    }));
    const outlineMaterial = new THREE.MeshBasicMaterial({
      color: DAY_PALETTE.edge,
      side: THREE.BackSide,
      transparent: true,
      opacity: 0.94,
      depthWrite: false,
    });
    const edgeMaterial = new THREE.LineBasicMaterial({ color: DAY_PALETTE.edge, transparent: true, opacity: 0.9 });
    const wireMaterial = new THREE.LineBasicMaterial({
      color: DAY_PALETTE.wire,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
    });
    const darkMaterial = new THREE.MeshStandardMaterial({
      color: DAY_PALETTE.core,
      metalness: 0.025,
      roughness: 0.84,
      flatShading: true,
    });
    const lightMaterial = new THREE.MeshStandardMaterial({
      color: DAY_PALETTE.light,
      metalness: 0.1,
      roughness: 0.34,
      flatShading: true,
    });
    const glowMaterial = new THREE.MeshStandardMaterial({
      color: DAY_PALETTE.light,
      emissive: DAY_PALETTE.light,
      emissiveIntensity: 0.2,
      roughness: 0.22,
      metalness: 0.08,
    });
    const modelMaterials: ModelMaterials = {
      facets: facetMaterials,
      outline: outlineMaterial,
      edge: edgeMaterial,
      dark: darkMaterial,
      light: lightMaterial,
      wire: wireMaterial,
      glow: glowMaterial,
    };

    const commonWireMaterial = wireMaterial.clone();
    commonWireMaterial.opacity = 0.12;
    const outerWire = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(2.72, 0)),
      commonWireMaterial,
    );
    outerWire.scale.set(1.05, 0.98, 1.02);
    continuousCage.add(outerWire);
    const offsetWireMaterial = commonWireMaterial.clone();
    offsetWireMaterial.opacity = 0.07;
    const offsetWire = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.DodecahedronGeometry(2.42, 0)),
      offsetWireMaterial,
    );
    offsetWire.rotation.set(0.22, 0.38, 0.14);
    continuousCage.add(offsetWire);

    const orbitMaterials = [0.46, 0.28, 0.2].map((opacity) => new THREE.LineBasicMaterial({
      color: DAY_PALETTE.orbit,
      transparent: true,
      opacity,
      depthWrite: false,
    }));
    const orbitDefinitions = [
      { x: 3.08, y: 1.78, rotation: new THREE.Euler(1.28, 0.05, -0.08) },
      { x: 2.9, y: 1.38, rotation: new THREE.Euler(0.48, 0.54, -0.42) },
      { x: 2.78, y: 1.53, rotation: new THREE.Euler(-0.48, 0.66, 0.58) },
    ] as const;
    const orbitLines = orbitDefinitions.map((definition, index) => {
      const line = new THREE.Line(createOrbitGeometry(definition.x, definition.y), orbitMaterials[index]);
      line.rotation.copy(definition.rotation);
      continuousCage.add(line);
      return line;
    });

    const accentCurve = new THREE.CubicBezierCurve3(
      new THREE.Vector3(-1.36, -2.28, 0.1),
      new THREE.Vector3(-0.5, -2.62, 0.2),
      new THREE.Vector3(0.5, -2.62, 0.2),
      new THREE.Vector3(1.36, -2.28, 0.1),
    );
    const accentMaterial = new THREE.MeshBasicMaterial({ color: DAY_PALETTE.edge });
    const accent = new THREE.Mesh(new THREE.TubeGeometry(accentCurve, 36, 0.018, 5, false), accentMaterial);
    continuousCage.add(accent);

    const nodeMaterial = new THREE.MeshStandardMaterial({ color: DAY_PALETTE.node, metalness: 0.02, roughness: 0.8 });
    const nodeGeometry = new THREE.SphereGeometry(0.055, 12, 8);
    const nodes = orbitDefinitions.map(() => {
      const node = new THREE.Mesh(nodeGeometry, nodeMaterial);
      nodeAssembly.add(node);
      return node;
    });

    const groundCanvas = document.createElement('canvas');
    groundCanvas.width = 128;
    groundCanvas.height = 128;
    const groundContext = groundCanvas.getContext('2d');
    if (groundContext) {
      const gradient = groundContext.createRadialGradient(64, 64, 3, 64, 64, 62);
      gradient.addColorStop(0, 'rgba(255,255,255,.84)');
      gradient.addColorStop(0.42, 'rgba(255,255,255,.42)');
      gradient.addColorStop(1, 'rgba(255,255,255,0)');
      groundContext.fillStyle = gradient;
      groundContext.fillRect(0, 0, 128, 128);
    }
    const groundTexture = new THREE.CanvasTexture(groundCanvas);
    const groundMaterial = new THREE.SpriteMaterial({
      color: DAY_PALETTE.ground,
      map: groundTexture,
      transparent: true,
      opacity: 0.1,
      depthWrite: false,
    });
    const ground = new THREE.Sprite(groundMaterial);
    ground.scale.set(3.65, 0.78, 1);
    ground.position.set(0, -2.38, -0.42);
    root.add(ground);

    const lightTarget = new THREE.Object3D();
    lightTarget.position.set(0, -0.12, 0);
    scene.add(lightTarget);
    const ambientLight = new THREE.HemisphereLight(0xf5f7f7, 0x20272b, 1.42);
    const spotLight = new THREE.SpotLight(0xffffff, 4.2, 24, Math.PI / 7, 0.42, 1.2);
    spotLight.position.set(-4.2, 5.4, 7.2);
    spotLight.target = lightTarget;
    const areaLight = new THREE.RectAreaLight(0xeaf0f1, 0, 5.5, 4.1);
    areaLight.position.set(-3.4, 3.8, 5.6);
    areaLight.lookAt(0, 0, 0);
    const targetLight = new THREE.PointLight(0xf4f7f7, 0, 18, 1.5);
    targetLight.position.set(0.7, 0.4, 5.2);
    const sunLight = new THREE.DirectionalLight(0xf8f9f8, 0);
    sunLight.position.set(-5.8, 7.4, 4.8);
    sunLight.target = lightTarget;
    const rimLight = new THREE.DirectionalLight(0x9fabb0, 2.2);
    rimLight.position.set(4.8, -1.2, 3.4);
    scene.add(ambientLight, spotLight, areaLight, targetLight, sunLight, rimLight);

    let activeAssembly = buildModelAssembly(variant, modelMaterials);
    modelSlot.add(activeAssembly.group);
    host.dataset.renderedVariant = activeAssembly.variant;
    host.dataset.transitionState = 'settled';
    let targetVariant: WebGLModelVariant | null = null;
    let transitionElapsed = 0;
    let transitionSwapped = false;
    let targetPointerX = 0;
    let targetPointerY = 0;
    let pointerX = 0;
    let pointerY = 0;
    let renderedWidth = 0;
    let renderedHeight = 0;
    let visible = true;
    let disposed = false;
    let reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let lastTime = performance.now();
    let elapsed = 0;
    let lastControlSignature = '';

    const applySceneProfile = (profileVariant: WebGLModelVariant) => {
      const profile = {
        gpt: { outer: true, offset: true, orbits: [true, true, true], nodes: [true, true, true] },
        claude: { outer: false, offset: false, orbits: [false, true, true], nodes: [false, true, true] },
        codex: { outer: false, offset: false, orbits: [false, false, false], nodes: [false, false, false] },
        gemini: { outer: false, offset: true, orbits: [true, false, true], nodes: [true, false, true] },
        antigravity: { outer: false, offset: false, orbits: [true, true, true], nodes: [true, true, true] },
        github: { outer: false, offset: false, orbits: [true, false, false], nodes: [true, false, false] },
      }[profileVariant];
      outerWire.visible = profile.outer;
      offsetWire.visible = profile.offset;
      orbitLines.forEach((line, index) => { line.visible = profile.orbits[index]; });
      nodes.forEach((node, index) => { node.visible = profile.nodes[index]; });
    };

    const replaceAssembly = (nextVariant: WebGLModelVariant) => {
      disposeAssembly(activeAssembly);
      activeAssembly = buildModelAssembly(nextVariant, modelMaterials);
      modelSlot.add(activeAssembly.group);
      host.dataset.renderedVariant = nextVariant;
      applySceneProfile(nextVariant);
    };

    const requestVariant = (nextVariant: WebGLModelVariant) => {
      if (nextVariant === activeAssembly.variant && !targetVariant) return;
      if (reduceMotion) {
        targetVariant = null;
        replaceAssembly(nextVariant);
        activeAssembly.group.scale.setScalar(1);
        activeAssembly.group.rotation.z = 0;
        host.dataset.transitionState = 'settled';
        return;
      }
      host.dataset.transitionState = 'switching';
      targetVariant = nextVariant;
      transitionElapsed = 0;
      transitionSwapped = false;
    };

    const applyControls = () => {
      const controls = controlsRef.current;
      const signature = [
        controls.intensity,
        controls.shadow,
        controls.lightMode,
        controls.mode,
        isNightTheme() ? 'night' : 'day',
      ].join(':');
      if (signature === lastControlSignature) return controls;
      lastControlSignature = signature;
      const intensityFactor = controls.intensity / 100;
      const isRotationMode = controls.mode === 'rotation';
      const isTextureMode = controls.mode === 'texture';
      facetMaterials.forEach((material) => {
        material.map = isTextureMode ? hatchTexture : paperTexture;
        material.opacity = isRotationMode ? 0.78 : 1;
        material.roughness = isTextureMode ? 0.96 : 0.88;
        material.needsUpdate = true;
      });
      outlineMaterial.opacity = isRotationMode ? 1 : isTextureMode ? 0.98 : 0.94;
      edgeMaterial.opacity = isRotationMode ? 1 : isTextureMode ? 0.96 : 0.9;
      wireMaterial.opacity = isRotationMode ? 0.62 : isTextureMode ? 0.4 : 0.48;
      commonWireMaterial.opacity = isRotationMode ? 0.18 : isTextureMode ? 0.1 : 0.12;
      offsetWireMaterial.opacity = isRotationMode ? 0.12 : isTextureMode ? 0.055 : 0.07;
      orbitMaterials.forEach((material, index) => {
        const normalOpacity = [0.46, 0.28, 0.2][index];
        material.opacity = isRotationMode ? normalOpacity * 1.42 : isTextureMode ? normalOpacity * 0.62 : normalOpacity;
      });
      ambientLight.intensity = 0.48 + intensityFactor * 1.16;
      rimLight.intensity = 0.35 + intensityFactor * 2.2;
      spotLight.intensity = controls.lightMode === 'spot' ? 1 + intensityFactor * 5.2 : 0;
      areaLight.intensity = controls.lightMode === 'area' ? 1.4 + intensityFactor * 7.5 : 0;
      targetLight.intensity = controls.lightMode === 'target' ? 1.2 + intensityFactor * 8.2 : 0;
      sunLight.intensity = controls.lightMode === 'sun' ? 0.9 + intensityFactor * 4.4 : 0;
      glowMaterial.emissiveIntensity = 0.06 + intensityFactor * 0.3;
      renderer.toneMappingExposure = (isNightTheme() ? 0.72 : 0.88) + intensityFactor * 0.34;
      const shadowFactor = controls.shadow / 90;
      groundMaterial.opacity = shadowFactor * (isNightTheme() ? 0.56 : 0.38);
      ground.scale.set(3.3 + shadowFactor * 0.55, 0.66 + shadowFactor * 0.18, 1);
      return controls;
    };

    const updatePalette = () => {
      const palette = isNightTheme() ? NIGHT_PALETTE : DAY_PALETTE;
      facetMaterials.forEach((material, index) => material.color.setHex(palette.facets[index]));
      outlineMaterial.color.setHex(palette.edge);
      edgeMaterial.color.setHex(palette.edge);
      wireMaterial.color.setHex(palette.wire);
      commonWireMaterial.color.setHex(palette.wire);
      offsetWireMaterial.color.setHex(palette.wire);
      darkMaterial.color.setHex(palette.core);
      lightMaterial.color.setHex(palette.light);
      glowMaterial.color.setHex(palette.light);
      glowMaterial.emissive.setHex(palette.light);
      orbitMaterials.forEach((material) => material.color.setHex(palette.orbit));
      nodeMaterial.color.setHex(palette.node);
      accentMaterial.color.setHex(palette.edge);
      groundMaterial.color.setHex(palette.ground);
      lastControlSignature = '';
      applyControls();
    };

    const setNodePosition = (node: THREE.Mesh, orbitIndex: number, angle: number) => {
      const definition = orbitDefinitions[orbitIndex];
      node.position.set(Math.cos(angle) * definition.x, Math.sin(angle) * definition.y, 0);
      node.position.applyEuler(definition.rotation);
    };

    const updateTransition = (delta: number) => {
      if (!targetVariant) return;
      transitionElapsed += delta;
      const collapseDuration = 0.22;
      const revealDuration = 0.42;
      if (!transitionSwapped && transitionElapsed <= collapseDuration) {
        const progress = transitionElapsed / collapseDuration;
        const scale = Math.max(0.025, 1 - easeInCubic(progress));
        activeAssembly.group.scale.setScalar(scale);
        activeAssembly.group.rotation.z = progress * 0.5;
        return;
      }
      if (!transitionSwapped) {
        replaceAssembly(targetVariant);
        transitionSwapped = true;
        activeAssembly.group.scale.setScalar(0.025);
        activeAssembly.group.rotation.z = -0.38;
      }
      const revealProgress = Math.min(1, (transitionElapsed - collapseDuration) / revealDuration);
      activeAssembly.group.scale.setScalar(Math.max(0.025, easeOutBack(revealProgress)));
      activeAssembly.group.rotation.z = -0.38 * (1 - revealProgress);
      if (revealProgress >= 1) {
        activeAssembly.group.scale.setScalar(1);
        activeAssembly.group.rotation.z = 0;
        targetVariant = null;
        host.dataset.transitionState = 'settled';
      }
    };

    const render = (time: number) => {
      if (disposed || !visible) return;
      const controls = applyControls();
      const rawDelta = Math.max(0, (time - lastTime) / 1000);
      const delta = Math.min(rawDelta, 0.05);
      lastTime = time;
      if (!reduceMotion && !controls.paused) elapsed += delta * controls.rotationSpeed;
      // Scene switching must track wall time rather than animation time. This
      // keeps the 640 ms transition honest on integrated GPUs and during
      // resize/capture frames without letting the regular rotation jump.
      updateTransition(Math.min(rawDelta, 0.25));
      pointerX = ease(pointerX, targetPointerX, reduceMotion ? 0.28 : 0.075);
      pointerY = ease(pointerY, targetPointerY, reduceMotion ? 0.28 : 0.075);
      activeAssembly.animate(reduceMotion ? 0.42 : elapsed, pointerX, pointerY);
      continuousCage.rotation.y = (reduceMotion ? 0.18 : -elapsed * 0.045) + pointerX * 0.1;
      continuousCage.rotation.x = pointerY * 0.05;
      outerWire.rotation.z = reduceMotion ? 0.1 : elapsed * 0.025;
      offsetWire.rotation.y = 0.38 + (reduceMotion ? 0 : elapsed * 0.06);
      orbitLines[0].rotation.z = orbitDefinitions[0].rotation.z + (reduceMotion ? 0 : elapsed * 0.018);
      if (controls.lightMode === 'target') {
        targetLight.position.x = 0.7 + pointerX * 2.5;
        targetLight.position.y = 0.4 - pointerY * 1.8;
      }
      nodes.forEach((node, index) => {
        const velocity = 0.18 + index * 0.055;
        setNodePosition(node, index, (reduceMotion ? index * 2.1 : elapsed * velocity) + index * 2.1);
      });
      renderer.render(scene, camera);
    };

    const startRendering = () => {
      renderer.setAnimationLoop(reduceMotion || !visible ? null : render);
      render(performance.now());
    };
    const resizeObserver = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const width = Math.max(1, Math.round(entry.contentRect.width));
      const height = Math.max(1, Math.round(entry.contentRect.height));
      if (width === renderedWidth && height === renderedHeight) return;
      renderedWidth = width;
      renderedHeight = height;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.65));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      render(performance.now());
    });
    const onPointerMove = (event: PointerEvent) => {
      const bounds = host.getBoundingClientRect();
      const centerX = bounds.left + bounds.width / 2;
      const centerY = bounds.top + bounds.height / 2;
      const dx = (event.clientX - centerX) / Math.max(bounds.width * 0.72, 280);
      const dy = (event.clientY - centerY) / Math.max(bounds.height * 0.72, 240);
      if (Math.abs(dx) <= 1.25 && Math.abs(dy) <= 1.25) {
        targetPointerX = THREE.MathUtils.clamp(dx, -1, 1);
        targetPointerY = THREE.MathUtils.clamp(dy, -1, 1);
      } else {
        targetPointerX = 0;
        targetPointerY = 0;
      }
      if (reduceMotion) render(performance.now());
    };
    const resetPointer = () => {
      targetPointerX = 0;
      targetPointerY = 0;
      if (reduceMotion) render(performance.now());
    };
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onMotionPreferenceChange = (event: MediaQueryListEvent) => {
      reduceMotion = event.matches;
      if (reduceMotion && targetVariant) {
        replaceAssembly(targetVariant);
        targetVariant = null;
        host.dataset.transitionState = 'settled';
      }
      startRendering();
    };
    const themeObserver = new MutationObserver(() => {
      updatePalette();
      if (reduceMotion) render(performance.now());
    });
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      startRendering();
    }, { rootMargin: '120px' });
    const onContextLost = (event: Event) => {
      event.preventDefault();
      if (!disposed) setWebGLFailed(true);
    };

    refreshRef.current = () => {
      lastControlSignature = '';
      applyControls();
      render(performance.now());
    };
    swapVariantRef.current = requestVariant;
    applySceneProfile(activeAssembly.variant);
    updatePalette();
    resizeObserver.observe(host);
    intersectionObserver.observe(host);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-visual-theme'],
    });
    motionQuery.addEventListener('change', onMotionPreferenceChange);
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerout', resetPointer, { passive: true });
    canvas.addEventListener('webglcontextlost', onContextLost);
    startRendering();

    return () => {
      disposed = true;
      refreshRef.current = () => undefined;
      swapVariantRef.current = () => undefined;
      renderer.setAnimationLoop(null);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      themeObserver.disconnect();
      motionQuery.removeEventListener('change', onMotionPreferenceChange);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerout', resetPointer);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      disposeAssembly(activeAssembly);
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.LineSegments) {
          object.geometry.dispose();
        }
      });
      [
        ...facetMaterials,
        outlineMaterial,
        edgeMaterial,
        wireMaterial,
        commonWireMaterial,
        offsetWireMaterial,
        darkMaterial,
        lightMaterial,
        glowMaterial,
        ...orbitMaterials,
        accentMaterial,
        nodeMaterial,
        groundMaterial,
      ].forEach((material) => material.dispose());
      paperTexture.dispose();
      hatchTexture.dispose();
      groundTexture.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      delete host.dataset.renderedVariant;
      delete host.dataset.transitionState;
      canvas.remove();
    };
  }, [webGLFailed]);

  useEffect(() => {
    refreshRef.current();
  }, [paused, intensity, shadow, lightMode, mode, rotationSpeed]);

  useEffect(() => {
    swapVariantRef.current(variant);
  }, [variant]);

  return (
    <div
      ref={hostRef}
      className={`webgl-geometric-core webgl-variant-${variant} ${webGLFailed ? 'is-fallback' : ''} ${className}`.trim()}
      role="img"
      aria-label={ariaLabel}
    >
      <span className="webgl-core-ambient" aria-hidden="true" />
      {webGLFailed ? <StaticRuntimeFallback variant={variant} /> : null}
    </div>
  );
}
