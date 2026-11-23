// A phone screen's device in 3D (three.js): its body made here from deviceModel's numbers (an extruded rounded slab per
// half, its glass, its display, its buttons, an iPhone's island and camera plateau), the picture as the lit display's
// texture, lit by a room's reflections. It draws only when something changed (a new picture, a drag, a fold or turn on
// its way, a resize): no loop runs while it stands still, so a laptop without a graphics card keeps up.
//
// A Duo is two halves turning about its hinge, each `(180 - hinge) / 2` degrees, so a half-open one stands as a book
// facing you; shut, the whole turns a quarter to show its cover (on the left half's back, square corners on the hinge's
// side). A laptop stands half open on its side, tipped back so its lower half lies flat.
import {
  ACESFilmicToneMapping,
  Box3,
  CanvasTexture,
  Color,
  ExtrudeGeometry,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PMREMGenerator,
  Quaternion,
  Raycaster,
  Scene,
  Shape,
  ShapeGeometry,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  type BufferGeometry,
  type Material,
} from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { webgl } from "./webgl";
import { COVER_CAMERA, type Body, type DuoBody, type Panel, type PhoneBody, type Pose, uvOf } from "./deviceModel";

/** A rounded rectangle centred on the origin, each corner its own radius (upper left, upper right, lower right, lower left). */
export function rounded(width: number, height: number, radii: readonly [number, number, number, number], shape = new Shape()): Shape {
  const x = -width / 2;
  const y = -height / 2;
  const limit = Math.min(width, height) / 2;
  const [ul, ur, lr, ll] = radii.map((r) => Math.max(0.01, Math.min(r, limit))) as [number, number, number, number];
  shape.moveTo(x + ll, y);
  shape.lineTo(x + width - lr, y);
  shape.absarc(x + width - lr, y + lr, lr, -Math.PI / 2, 0, false);
  shape.lineTo(x + width, y + height - ur);
  shape.absarc(x + width - ur, y + height - ur, ur, 0, Math.PI / 2, false);
  shape.lineTo(x + ul, y + height);
  shape.absarc(x + ul, y + height - ul, ul, Math.PI / 2, Math.PI, false);
  shape.lineTo(x, y + ll);
  shape.absarc(x + ll, y + ll, ll, Math.PI, (3 * Math.PI) / 2, false);
  return shape;
}

/** Texture coordinates for a flat shape's vertices: `at` maps a vertex's (x, y) to its (u, v). */
function mapUv(geometry: BufferGeometry, at: (x: number, y: number) => [number, number]): BufferGeometry {
  const pos = geometry.getAttribute("position");
  const uv = geometry.getAttribute("uv");
  for (let i = 0; i < pos.count; i++) {
    const [u, v] = at(pos.getX(i), pos.getY(i));
    uv.setXY(i, u, v);
  }
  uv.needsUpdate = true;
  return geometry;
}

/** All four corners alike. */
const round = (r: number): Panel["radii"] => [r, r, r, r];


/** One slab: a rounded outline extruded `depth` deep, its edges rounded by `edge`, its front face at z = 0. */
function slab(width: number, height: number, radii: readonly [number, number, number, number], depth: number, edge: number): ExtrudeGeometry {
  const inset = radii.map((r) => Math.max(0.2, r - edge)) as unknown as [number, number, number, number];
  const g = new ExtrudeGeometry(rounded(width - edge * 2, height - edge * 2, inset), {
    depth: Math.max(0.1, depth - edge * 2),
    bevelEnabled: true,
    bevelSize: edge,
    bevelThickness: edge,
    bevelSegments: 5,
    curveSegments: 24,
  });
  g.translate(0, 0, -depth + edge);
  return g;
}

/** The materials one device's meshes share. */
function materials(body: Body) {
  return {
    frame: new MeshStandardMaterial({ color: body.finish.frame, metalness: 1, roughness: 0.26 }),
    back: new MeshPhysicalMaterial({ color: body.finish.back, metalness: 0.2, roughness: 0.55, clearcoat: 0.6, clearcoatRoughness: 0.4 }),
    glass: new MeshPhysicalMaterial({ color: 0x050506, metalness: 0, roughness: 0.08, clearcoat: 1 }),
    lens: new MeshPhysicalMaterial({ color: 0x0b0d12, metalness: 0.4, roughness: 0.1, clearcoat: 1 }),
    island: new MeshBasicMaterial({ color: 0x000000 }),
  };
}

/** A rounded button `length` long on an edge, centred at `at` (z the middle of the body's depth), standing 0.6 mm out of it. */
function button(length: number, at: Vector3, sideways: boolean, material: Material): Mesh {
  const g = slab(1.2, length, [0.5, 0.5, 0.5, 0.5], 2.6, 0.5);
  g.translate(0, 0, 1.3);
  const m = new Mesh(g, material);
  m.position.copy(at);
  if (sideways) m.rotation.z = Math.PI / 2;
  return m;
}

/** A camera lens on a back at depth `z`, its centre at (`x`, `y`): a metal ring standing out, dark glass in it. */
function lens(to: Group, x: number, y: number, z: number, size: number, m: ReturnType<typeof materials>, geometries: BufferGeometry[]): void {
  const ring = slab(size, size, round(size / 2), 1.2, 0.5);
  const glass = new ShapeGeometry(rounded(size * 0.72, size * 0.72, round(size * 0.36)), 24);
  glass.rotateY(Math.PI);
  geometries.push(ring, glass);
  const r = new Mesh(ring, m.frame);
  r.position.set(x, y, z);
  const g = new Mesh(glass, m.lens);
  g.position.set(x, y, z - 1.22);
  to.add(r, g);
}

/** What `build` makes: the device's root, the meshes the picture lies on, and how to stand it. */
interface Built {
  readonly root: Group;
  readonly screens: Mesh[];
  readonly dispose: () => void;
  /** Stands it as `pose` (its hinge, and the display the picture goes on). */
  readonly stand: (pose: Pose) => void;
}

/** An iPhone, or a plain phone: one slab, its display at the front, an island, buttons, a camera plateau. */
function buildPhone(body: PhoneBody, screenMaterial: Material): Built {
  const m = materials(body);
  const { screen, bezel, depth } = body;
  const width = screen.width + bezel * 2;
  const height = screen.height + bezel * 2;
  const outer = screen.radii.map((r) => r + bezel) as unknown as [number, number, number, number];
  const root = new Group();
  const geometries: BufferGeometry[] = [];
  const add = (g: BufferGeometry, mat: Material, z = 0) => {
    geometries.push(g);
    const mesh = new Mesh(g, mat);
    mesh.position.z = z;
    root.add(mesh);
    return mesh;
  };
  add(slab(width, height, outer, depth, Math.min(1.6, depth / 2.4)), m.frame);
  add(new ShapeGeometry(rounded(width - 0.9, height - 0.9, outer.map((r) => r - 0.45) as unknown as Panel["radii"]), 24), m.glass, 0.02);
  const back = new ShapeGeometry(rounded(width - 1.2, height - 1.2, outer.map((r) => r - 0.6) as unknown as Panel["radii"]), 24);
  back.rotateY(Math.PI);
  add(back, m.back, -depth - 0.02);
  const display = add(new ShapeGeometry(rounded(screen.width, screen.height, screen.radii), 24), screenMaterial, 0.05);
  if (body.island !== undefined) {
    const { width: iw, height: ih, top } = body.island;
    const island = add(new ShapeGeometry(rounded(iw, ih, [ih / 2, ih / 2, ih / 2, ih / 2]), 16), m.island, 0.08);
    island.position.y = screen.height / 2 - top - ih / 2;
  }
  // The side button on the right, the action and volume buttons on the left (Apple's places, near enough).
  const side = depth / 2;
  root.add(button(17, new Vector3(width / 2, height * 0.14, -side), false, m.frame));
  root.add(button(7, new Vector3(-width / 2, height * 0.26, -side), false, m.frame));
  root.add(button(11, new Vector3(-width / 2, height * 0.17, -side), false, m.frame));
  root.add(button(11, new Vector3(-width / 2, height * 0.08, -side), false, m.frame));
  if (body.island !== undefined) {
    // The camera plateau across the back's top (seen from behind, the lenses at its left: the front's right), three
    // lenses on it.
    const plateau = add(slab(width - 3, 32, round(outer[0] - 1.5), 1.3, 0.6), m.back);
    plateau.position.set(0, height / 2 - 17.5, -depth);
    for (const [x, y] of [
      [width / 2 - 12, height / 2 - 10],
      [width / 2 - 12, height / 2 - 25],
      [width / 2 - 25, height / 2 - 17.5],
    ] as const) {
      lens(root, x, y, -depth - 1.3, 11, m, geometries);
    }
  } else {
    lens(root, width / 2 - 11, height / 2 - 11, -depth, 10, m, geometries);
  }
  mapUv(display.geometry, (x, y) => uvOf(x, y, screen, 0));
  let roll: Pose["roll"] = 0;
  return {
    root,
    screens: [display],
    stand: (pose) => {
      if (pose.roll === roll) return;
      roll = pose.roll;
      mapUv(display.geometry, (x, y) => uvOf(x, y, screen, roll));
    },
    dispose: () => {
      for (const g of geometries) g.dispose();
      root.traverse((o) => {
        if (o instanceof Mesh && !geometries.includes(o.geometry as BufferGeometry)) (o.geometry as BufferGeometry).dispose();
      });
      for (const mat of Object.values(m)) mat.dispose();
    },
  };
}

/** The crease between the inner display's halves: what the hinge takes of its width, each side. */
const CREASE = 0.04;

/**
 * An iPhone Duo: each half a slab turning about the hinge (a vertical line at x = 0 on the displays' plane), the inner
 * display's halves on their fronts, the cover display on the left half's back.
 */
function buildDuo(body: DuoBody, screenMaterial: Material): Built {
  const m = materials(body);
  const { inner, cover, bezel, depth } = body;
  const half = inner.width / 2;
  const width = half + bezel;
  const height = inner.height + bezel * 2;
  const R = inner.radii[0] + bezel;
  const geometries: BufferGeometry[] = [];
  const root = new Group();
  const content = new Group();
  root.add(content);
  const halves = { left: new Group(), right: new Group() };
  content.add(halves.left, halves.right);
  const add = (to: Group, g: BufferGeometry, mat: Material, x: number, z: number) => {
    geometries.push(g);
    const mesh = new Mesh(g, mat);
    mesh.position.set(x, 0, z);
    to.add(mesh);
    return mesh;
  };
  const edge = Math.min(1.5, depth / 2.2);
  const screens: Mesh[] = [];
  for (const side of ["left", "right"] as const) {
    const g = halves[side];
    // Rounded on the outer side, nearly square on the hinge's.
    const sign = side === "left" ? -1 : 1;
    const radii: Panel["radii"] = side === "left" ? [R, 1.2, 1.2, R] : [1.2, R, R, 1.2];
    const cx = sign * (width / 2);
    add(g, slab(width, height, radii, depth, edge), m.frame, cx, 0);
    // The glass runs to the hinge line itself, so no metal shows between the halves at the crease.
    const glassRadii: Panel["radii"] = side === "left" ? [R - 0.4, 0.01, 0.01, R - 0.4] : [0.01, R - 0.4, R - 0.4, 0.01];
    add(g, new ShapeGeometry(rounded(width - 0.4, height - 0.8, glassRadii), 24), m.glass, sign * ((width - 0.4) / 2), 0.02);
    const sr: Panel["radii"] = side === "left" ? [inner.radii[0], 0.01, 0.01, inner.radii[3]] : [0.01, inner.radii[1], inner.radii[2], 0.01];
    const sw = half - CREASE;
    screens.push(add(g, new ShapeGeometry(rounded(sw, inner.height, sr), 24), screenMaterial, sign * (CREASE + sw / 2), 0.05));
  }
  // The cover display and its glass on the left half's back, facing away; its square corners at the hinge.
  const coverGlass = new ShapeGeometry(rounded(width - 0.8, height - 0.8, [1.2, R - 0.4, R - 0.4, 1.2]), 24);
  coverGlass.rotateY(Math.PI);
  add(halves.left, coverGlass, m.glass, -width / 2, -depth - 0.02);
  const coverShape = new ShapeGeometry(rounded(cover.width, cover.height, cover.radii), 24);
  coverShape.rotateY(Math.PI);
  // Centred on the half's back, its hinge side nearest the hinge: seen shut, the hinge is on the left.
  const coverX = -(width / 2);
  const coverMesh = add(halves.left, coverShape, screenMaterial, coverX, -depth - 0.05);
  // The cover's camera, a punch hole near its upper outer corner (where its picture leaves room for it).
  const hole = new ShapeGeometry(rounded(COVER_CAMERA.size * cover.width, COVER_CAMERA.size * cover.width, round(COVER_CAMERA.size * cover.width)), 24);
  hole.rotateY(Math.PI);
  const camera = add(halves.left, hole, m.island, 0, -depth - 0.08);
  // Seen shut its picture's right is the half's outer side: local x runs the other way.
  camera.position.set(coverX - (COVER_CAMERA.x - 0.5) * cover.width, (0.5 - COVER_CAMERA.y) * cover.height, -depth - 0.08);
  // The side button on the right half's outer edge, the volume buttons on its top.
  halves.right.add(button(14, new Vector3(width, height * 0.1, -depth / 2), false, m.frame));
  const volume = button(9, new Vector3(width * 0.55, height / 2, -depth / 2), true, m.frame);
  halves.right.add(volume);
  // The cameras on the right half's back, its upper outer corner.
  lens(halves.right, width - 11, height / 2 - 11, -depth, 10, m, geometries);
  lens(halves.right, width - 11, height / 2 - 24, -depth, 10, m, geometries);

  const [leftScreen, rightScreen] = screens as [Mesh, Mesh];
  let shown: { panel: Pose["panel"]; roll: Pose["roll"] } | undefined;
  const inverse = new Vector3();
  const bounds = new Box3();
  const map = (pose: Pose) => {
    if (shown?.panel === pose.panel && shown.roll === pose.roll) return;
    shown = { panel: pose.panel, roll: pose.roll };
    // The inner display's halves lie where they do open, the crease at x = 0.
    mapUv(leftScreen.geometry, (x, y) => uvOf(x + leftScreen.position.x, y, inner, pose.roll));
    mapUv(rightScreen.geometry, (x, y) => uvOf(x + rightScreen.position.x, y, inner, pose.roll));
    // The cover, seen shut from its side: its local x runs the other way (it faces back).
    mapUv(coverMesh.geometry, (x, y) => uvOf(-x, y, cover, pose.roll));
    leftScreen.visible = rightScreen.visible = pose.panel === "inner";
    coverMesh.visible = pose.panel === "cover";
    camera.visible = pose.panel === "cover";
  };
  return {
    root,
    screens: [leftScreen, rightScreen, coverMesh],
    stand: (pose) => {
      map(pose);
      const turn = ((180 - Math.min(180, Math.max(0, pose.hinge))) * Math.PI) / 360;
      halves.left.rotation.y = turn;
      halves.right.rotation.y = -turn;
      // Shutting, the whole turns to show its cover: none from half open (130°) to open, a quarter shut.
      const shut = Math.min(1, Math.max(0, (turn - (25 * Math.PI) / 180) / ((65 * Math.PI) / 180)));
      content.rotation.y = (shut * Math.PI) / 2;
      // Centred on itself, as it now stands.
      content.position.set(0, 0, 0);
      root.updateMatrixWorld(true);
      bounds.setFromObject(content, true);
      bounds.getCenter(inverse);
      content.position.sub(inverse);
    },
    dispose: () => {
      for (const g of geometries) g.dispose();
      root.traverse((o) => {
        if (o instanceof Mesh && !geometries.includes(o.geometry as BufferGeometry)) (o.geometry as BufferGeometry).dispose();
      });
      for (const mat of Object.values(m)) mat.dispose();
    },
  };
}

/** How quickly a fold, a turn or a fit settles (a critically damped spring's rate, per second). */
const SETTLE = 9;
/** How far a drag turns the device: degrees per pixel. */
const DRAG = 0.4;
/** How far it may tip forward or back. */
const PITCH_LIMIT = 80;
/** How far a laptop is tipped back: its lower half nearly flat, seen from a little above. */
const LAPTOP_TILT = 40;

/** What a stage shows and how: set by the view, read each frame. */
export interface StageInput {
  readonly body: Body;
  readonly pose: Pose;
}

/**
 * A device stage on `canvas`: `set` gives it the body and pose, `picture` the canvas holding the newest picture (drawn
 * on `changed`), drags turn it (`turnBy`), `face` brings it back to face you. Throws where WebGL can't start.
 */
export function createStage(canvas: HTMLCanvasElement) {
  // A software renderer (no graphics card) draws at one pixel per CSS pixel, without antialiasing: it keeps up then.
  const found = webgl();
  if (found === "none") throw new Error("no WebGL");
  const software = found === "software";
  const renderer = new WebGLRenderer({ canvas, antialias: !software, alpha: true, powerPreference: "low-power" });
  renderer.setPixelRatio(software ? 1 : Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, 0.04).texture;
  room.dispose();
  pmrem.dispose();
  scene.environment = environment;
  const camera = new PerspectiveCamera(24, 1, 10, 5000);
  const screenMaterial = new MeshBasicMaterial({ color: new Color(0x000000), toneMapped: false });
  // The picture as the display's texture: drawn into `scaled` no larger than the view draws it (a 2853 × 2007 Duo
  // picture uploaded whole each frame is what makes a renderer fall behind), so it needs no mipmaps.
  let texture: CanvasTexture | undefined;
  let source: HTMLCanvasElement | undefined;
  const scaled = document.createElement("canvas");
  const scaledContext = scaled.getContext("2d");
  let stale = false;
  const refresh = () => {
    stale = false;
    if (source === undefined || source.width === 0 || source.height === 0 || scaledContext === null) return;
    const buffer = renderer.getDrawingBufferSize(new Vector2());
    const k = Math.min(1, Math.max(buffer.x, buffer.y) / Math.max(source.width, source.height));
    const w = Math.max(1, Math.round(source.width * k));
    const h = Math.max(1, Math.round(source.height * k));
    if (scaled.width !== w || scaled.height !== h) {
      scaled.width = w;
      scaled.height = h;
      // A texture of another size is made anew.
      texture?.dispose();
      texture = undefined;
    }
    scaledContext.imageSmoothingQuality = "medium";
    scaledContext.drawImage(source, 0, 0, w, h);
    if (texture === undefined) {
      texture = new CanvasTexture(scaled);
      texture.colorSpace = SRGBColorSpace;
      texture.generateMipmaps = false;
      texture.minFilter = LinearFilter;
      screenMaterial.map = texture;
      screenMaterial.color.set(0xffffff);
      screenMaterial.needsUpdate = true;
    } else {
      texture.needsUpdate = true;
    }
  };
  let built: Built | undefined;
  let builtFor: Body | undefined;
  /** The user's turn of the device, and the turn it settles to. */
  const turn = { yaw: 0, pitch: 0 };
  const turnTo = { yaw: 0, pitch: 0 };
  /** The pose as drawn, and the pose it settles to. */
  let hinge = 180;
  let pose: Pose | undefined;
  let roll = 0;
  let rollTo = 0;
  let laptop = 0;
  let distance = 400;
  let distanceTo = 400;
  let fitted = false;
  const holder = new Group();
  const rollGroup = new Group();
  holder.add(rollGroup);
  scene.add(holder);
  let frame: number | null = null;
  let last = 0;
  let size = { width: 1, height: 1 };

  const fit = () => {
    if (built === undefined) return;
    // The device's size as it will stand facing you (a laptop tipped back as it will be): fits the view with a margin.
    const turned = holder.quaternion.clone();
    holder.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), ((pose?.laptop ? -LAPTOP_TILT : 0) * Math.PI) / 180);
    holder.updateMatrixWorld(true);
    const box = new Box3().setFromObject(holder, true);
    holder.quaternion.copy(turned);
    holder.updateMatrixWorld(true);
    const s = box.getSize(new Vector3());
    const aspect = size.width / size.height;
    const fov = (camera.fov * Math.PI) / 180;
    const fitH = s.y / 2 / Math.tan(fov / 2);
    const fitW = s.x / 2 / Math.tan(fov / 2) / aspect;
    distanceTo = Math.max(fitH, fitW) * 1.12 + s.z / 2;
  };

  const step = (now: number) => {
    frame = null;
    const dt = Math.min(0.05, last === 0 ? 1 / 60 : (now - last) / 1000);
    last = now;
    const k = 1 - Math.exp(-SETTLE * dt);
    const still = { moving: false };
    const ease = (from: number, to: number) => {
      const next = from + (to - from) * k;
      if (Math.abs(to - next) <= 0.05) return to;
      still.moving = true;
      return next;
    };
    if (pose !== undefined && built !== undefined) {
      hinge = ease(hinge, pose.hinge);
      built.stand({ ...pose, hinge });
    }
    roll = ease(roll, rollTo);
    laptop = ease(laptop * 100, (pose?.laptop ? 1 : 0) * 100) / 100;
    turn.yaw = ease(turn.yaw, turnTo.yaw);
    turn.pitch = ease(turn.pitch, turnTo.pitch);
    distance = ease(distance, distanceTo);
    rollGroup.rotation.z = (roll * Math.PI) / 180;
    // A laptop is tipped back so its lower half lies flat (its halves at ±25° from upright).
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (turn.yaw * Math.PI) / 180);
    q.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), ((turn.pitch - laptop * LAPTOP_TILT) * Math.PI) / 180));
    holder.quaternion.copy(q);
    camera.position.set(0, 0, distance);
    camera.lookAt(0, 0, 0);
    if (stale) refresh();
    renderer.render(scene, camera);
    if (still.moving) frame = requestAnimationFrame(step);
    else last = 0;
  };
  const draw = () => {
    frame ??= requestAnimationFrame(step);
  };

  return {
    /** The body and pose to show; a new body is built, a new pose is moved to. */
    set(input: StageInput) {
      if (input.body !== builtFor) {
        if (built !== undefined) {
          rollGroup.remove(built.root);
          built.dispose();
        }
        built = input.body.kind === "duo" ? buildDuo(input.body, screenMaterial) : buildPhone(input.body, screenMaterial);
        builtFor = input.body;
        rollGroup.add(built.root);
        // A new device stands as it is at once: nothing to move from.
        hinge = input.pose.hinge;
        roll = rollTo = input.pose.roll;
        laptop = input.pose.laptop ? 1 : 0;
        built.stand(input.pose);
      }
      // The short way round to the new roll.
      const d = ((((input.pose.roll - rollTo) % 360) + 540) % 360) - 180;
      rollTo += d;
      pose = input.pose;
      // Fit to the pose it is going to.
      const b = built;
      if (b === undefined) return;
      const was = rollGroup.rotation.z;
      b.stand(input.pose);
      rollGroup.rotation.z = (rollTo * Math.PI) / 180;
      fit();
      b.stand({ ...input.pose, hinge });
      rollGroup.rotation.z = was;
      if (!fitted) distance = distanceTo;
      fitted = true;
      draw();
    },
    /** The canvas the picture is drawn into: its texture follows it. */
    picture(next: HTMLCanvasElement | undefined) {
      source = next;
      if (next === undefined) {
        texture?.dispose();
        texture = undefined;
        screenMaterial.map = null;
        screenMaterial.color.set(0x000000);
        screenMaterial.needsUpdate = true;
      } else {
        refresh();
      }
      draw();
    },
    /** A new picture is in the canvas: copied once, as the next frame draws, however many came since. */
    changed() {
      stale = true;
      draw();
    },
    resize(width: number, height: number) {
      size = { width: Math.max(1, width), height: Math.max(1, height) };
      renderer.setSize(size.width, size.height, false);
      camera.aspect = size.width / size.height;
      camera.updateProjectionMatrix();
      fit();
      distance = distanceTo;
      refresh();
      draw();
    },
    /** A drag of `dx`, `dy` pixels turns it; at once, as the pointer moves. */
    turnBy(dx: number, dy: number) {
      turnTo.yaw += dx * DRAG;
      turnTo.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, turnTo.pitch + dy * DRAG));
      turn.yaw = turnTo.yaw;
      turn.pitch = turnTo.pitch;
      draw();
    },
    /** Back to facing you, fitted. */
    face() {
      // The short way round.
      turnTo.yaw = 0;
      turn.yaw = ((((turn.yaw % 360) + 540) % 360) - 180);
      turnTo.pitch = 0;
      fit();
      draw();
    },
    /** Whether it is turned away from facing you. */
    turned: () => Math.abs(turnTo.yaw % 360) > 0.5 || Math.abs(turnTo.pitch) > 0.5,
    /**
     * The picture's point under the viewport point (`x`, `y` from 0 to 1, from the top left), as fractions of the
     * picture (0 to 1 from its top left); null off the lit display.
     */
    pick(x: number, y: number): { x: number; y: number } | null {
      if (built === undefined) return null;
      const ray = new Raycaster();
      ray.setFromCamera(new Vector2(x * 2 - 1, 1 - y * 2), camera);
      const hit = ray.intersectObjects(built.screens.filter((s) => s.visible), false)[0];
      if (hit?.uv === undefined) return null;
      return { x: Math.min(1, Math.max(0, hit.uv.x)), y: Math.min(1, Math.max(0, 1 - hit.uv.y)) };
    },
    /** Whether the renderer is a software one (no graphics card): the view then starts flat. */
    software: () => software,
    dispose() {
      if (frame !== null) cancelAnimationFrame(frame);
      built?.dispose();
      texture?.dispose();
      screenMaterial.dispose();
      environment.dispose();
      renderer.dispose();
    },
  };
}

export type Stage = ReturnType<typeof createStage>;
