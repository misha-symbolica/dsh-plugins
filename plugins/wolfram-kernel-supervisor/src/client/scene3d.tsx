/**
 * Native rendering of a wolfram_show Graphics3D as a rotatable three.js scene.
 *
 * The kernel (kernel/Scene3D.wl) walks the Graphics3DBox IR into a JSON scene
 * ("dsh-graphics3d/0": plot range, BoxRatios, ViewPoint, lights, ticks, and a
 * flat list of elements — sphere / cylinder / cone / cuboid / tube / polyhedron /
 * mesh / line / point / arrow / text / group / complex). This module turns that
 * JSON into three.js objects and reproduces the front end's look:
 *
 *  - Wolfram coordinates stay as they are (z up: the camera's up vector is
 *    ViewVertical); the root group is translated/scaled so the bounding box is
 *    Mathematica's normalized box (longest side 1, centred) in which ViewPoint is
 *    expressed. ViewAngle -> Automatic fits the projected box corners.
 *  - Shading is done in gamma space (ColorManagement off), every light carries
 *    intensity pi (three >= r155 divides Lambert irradiance by pi, Mathematica
 *    sums light colour x cos theta), Specularity[s, n] is classic Phong so the
 *    Blinn lobe gets shininess 4n and a damped specular colour.
 *  - ImageScaled light positions are camera-fixed points in the projected box
 *    (x right, y up; z from the back for directional lights, from the front for
 *    point lights — measured), aimed at the box centre; re-placed every frame.
 *  - Text and tick labels are DOM (CSS2DRenderer): crisp, themed by CSS.
 *
 * Measured facts and the standalone prototype: recipes/wolfram-graphics3d-native-scenes.md,
 * experiments/graphics3d/viewer.html. Manipulate re-renders call `setScene` with
 * a new JSON: the geometry is rebuilt, camera and controls persist.
 */

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'

// ---------------------------------------------------------------- scene JSON types (loosely validated)

type Vec3 = [number, number, number]
interface Style {
  color?: number[]
  opacity?: number
  specular?: { color: number[], exponent: number } | null
  edge?: { color: number[], opacity?: number } | null
  pointSize?: { scaled?: number, absolute?: number }
  thickness?: { scaled?: number, absolute?: number }
  arrowheads?: number | null
  glow?: number[] | null
}
interface Element {
  type: string
  style: Style
  [key: string]: unknown
}
interface Complex extends Element {
  type: 'complex'
  coords: Vec3[]
  vertexNormals?: Vec3[]
  vertexColors?: number[][]
  children: Element[]
}
interface LightPos { imageScaled?: number[], scaled?: number[], scene?: number[] }
interface Light { type: string, color: number[], from?: LightPos | null, to?: LightPos | null, angle?: number }
export interface Scene3D {
  format: string
  range: [number, number][]
  boxRatios: number[] | null
  view: { point: number[], vertical: number[], angle: number | null, center: number[] | null, projection: string }
  boxed: boolean
  axes: boolean[]
  ticks: { major: { pos: number, label: string }[], minor: number[] }[] | null
  axesLabel: (string | null)[] | null
  lighting: Light[]
  background: number[] | null
  imageSize: [number, number | null] | null
  elements: Element[]
  unsupported: string[]
}

export function isScene3D(value: unknown): value is Scene3D {
  const v = value as Partial<Scene3D> | null
  return !!v && typeof v === 'object' && typeof v.format === 'string' && v.format.startsWith('dsh-graphics3d/') && Array.isArray(v.range) && Array.isArray(v.elements)
}

// ---------------------------------------------------------------- the renderer

/** three >= r155 divides Lambert irradiance by pi; Mathematica sums light colour x cos theta. */
const LIGHT = Math.PI
/** Empirical damping of Specularity highlights (the front end's Specularity[White, 3] barely shows). */
const SPECULAR = 0.35

const col = (c: number[] | undefined, fallback: Vec3): THREE.Color => {
  const v = c ?? fallback
  return new THREE.Color(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0)
}
const v3 = (p: number[]): THREE.Vector3 => new THREE.Vector3(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0)

export interface SceneRendererOptions {
  width: number
  height: number
  /** CSS colour for the box, ticks and default text. */
  ink: string
}

/**
 * Owns the WebGL renderer, the camera, the controls and the current scene
 * graph for one <div>. `setScene` replaces the geometry while the camera stays.
 */
export class SceneRenderer {
  private readonly renderer: THREE.WebGLRenderer
  private readonly labels: CSS2DRenderer
  private readonly three = new THREE.Scene()
  private readonly camera: THREE.PerspectiveCamera
  /** Created in setScene, AFTER camera.up is set: OrbitControls bakes `camera.up` into a private
   *  quaternion in its constructor, so controls built for the default y-up camera orbit a z-up one
   *  with swapped axes (vertical drag spun the plot around z — the first live bug). */
  private controls: OrbitControls | null = null
  private root: THREE.Group | null = null
  private box: THREE.Group | null = null
  private tickGroup: THREE.Group | null = null
  private lights: { light: THREE.Light, spec: Light }[] = []
  private scene: Scene3D | null = null
  private frame: { extent: Vec3, center: Vec3, boxScale: Vec3, half: Vec3, corners: THREE.Vector3[], longest: number } | null = null
  private disposed = false
  private ink: string
  private width: number
  private height: number

  constructor(readonly container: HTMLDivElement, options: SceneRendererOptions) {
    THREE.ColorManagement.enabled = false
    this.width = options.width; this.height = options.height; this.ink = options.ink
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace
    this.renderer.setPixelRatio(window.devicePixelRatio || 1)
    this.renderer.setSize(options.width, options.height)
    this.renderer.domElement.style.display = 'block'
    container.appendChild(this.renderer.domElement)
    this.labels = new CSS2DRenderer()
    this.labels.setSize(options.width, options.height)
    Object.assign(this.labels.domElement.style, { position: 'absolute', top: '0', left: '0', pointerEvents: 'none' })
    container.appendChild(this.labels.domElement)
    this.camera = new THREE.PerspectiveCamera(35, options.width / options.height, 0.01, 100)
    this.renderer.setAnimationLoop(() => this.render())
  }

  dispose(): void {
    this.disposed = true
    this.renderer.setAnimationLoop(null)
    this.controls?.dispose()
    this.clearGraph()
    this.renderer.dispose()
    this.renderer.domElement.remove()
    this.labels.domElement.remove()
  }

  resize(width: number, height: number): void {
    this.width = width; this.height = height
    this.renderer.setSize(width, height)
    this.labels.setSize(width, height)
    this.camera.aspect = width / height
    this.fitCamera(false)
  }

  /** Whether a scene has been loaded (a later setScene keeps the camera). */
  get loaded(): boolean { return this.scene !== null }

  /** The current frame as a PNG data URL (for "open in a new tab"). */
  snapshot(): string { this.render(); return this.renderer.domElement.toDataURL('image/png') }

  private clearGraph(): void {
    for (const g of [this.root, this.box, this.tickGroup]) if (g) { this.three.remove(g); disposeTree(g) }
    for (const { light } of this.lights) { this.three.remove(light); if ('target' in light && light.target instanceof THREE.Object3D) this.three.remove(light.target) }
    this.three.clear()
    this.root = this.box = this.tickGroup = null
    this.lights = []
  }

  /** Load a scene; `keepCamera` (Manipulate re-render) leaves the camera where the user put it. */
  setScene(scene: Scene3D, keepCamera: boolean): void {
    if (this.disposed) return
    this.clearGraph()
    this.scene = scene
    const range = scene.range
    const extent = range.map(([a, b]) => Math.max(b - a, 1e-12)) as Vec3
    const center = range.map(([a, b]) => (a + b) / 2) as Vec3
    const ratios = (scene.boxRatios ?? extent) as Vec3
    const maxRatio = Math.max(...ratios)
    const boxScale = extent.map((e, i) => ((ratios[i] as number) / maxRatio) / e) as Vec3
    const half = ratios.map(r => (r / maxRatio) / 2) as Vec3
    const corners: THREE.Vector3[] = []
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) corners.push(new THREE.Vector3(sx * half[0], sy * half[1], sz * half[2]))
    this.frame = { extent, center, boxScale, half, corners, longest: Math.max(...extent) }

    const root = new THREE.Group()
    root.scale.set(boxScale[0], boxScale[1], boxScale[2])
    root.position.set(-center[0] * boxScale[0], -center[1] * boxScale[1], -center[2] * boxScale[2])
    const builder = new Builder(this.frame, this.width, this.ink)
    for (const e of scene.elements) { const o = builder.build(e, null); if (o) root.add(o) }
    this.three.add(root)
    this.root = root
    root.updateMatrixWorld(true)

    this.three.background = scene.background ? col(scene.background, [1, 1, 1]) : null

    const box = new THREE.Group()
    if (scene.boxed) {
      const geo = new THREE.BoxGeometry(2 * half[0], 2 * half[1], 2 * half[2])
      box.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: new THREE.Color(this.ink), transparent: true, opacity: 0.6 })))
    }
    this.three.add(box)
    this.box = box

    for (const spec of scene.lighting) {
      const c = col(spec.color, [1, 1, 1])
      let light: THREE.Light
      if (spec.type === 'ambient') light = new THREE.AmbientLight(c, LIGHT)
      else if (spec.type === 'directional') { const l = new THREE.DirectionalLight(c, LIGHT); this.three.add(l.target); light = l }
      else if (spec.type === 'point') light = new THREE.PointLight(c, LIGHT, 0, 0)
      else if (spec.type === 'spot') { const l = new THREE.SpotLight(c, LIGHT, 0, spec.angle ?? Math.PI / 6, 0, 0); this.three.add(l.target); light = l }
      else continue
      this.three.add(light)
      this.lights.push({ light, spec })
    }

    if (!keepCamera || this.controls === null) {
      this.camera.up.copy(v3(scene.view.vertical).normalize())
      this.camera.position.copy(v3(scene.view.point))
      this.camera.lookAt(0, 0, 0)
      // (Re)build the controls now that `up` is final: a fresh camera needs a fresh orbit frame.
      this.controls?.dispose()
      this.controls = new OrbitControls(this.camera, this.renderer.domElement)
      this.controls.enableDamping = false
      this.controls.target.set(0, 0, 0)
      this.controls.addEventListener('change', () => { this.drawAxes(); this.render() })
      this.controls.update()
    }
    this.fitCamera(!keepCamera)
    this.tickGroup = new THREE.Group()
    this.three.add(this.tickGroup)
    this.drawAxes()
    this.render()
  }

  /** ViewAngle -> Automatic: the smallest fov that keeps every box corner in view (only on a fresh camera). */
  private fitCamera(refit: boolean): void {
    if (!this.frame || !this.scene) return
    if (refit) {
      this.camera.updateMatrixWorld()
      const inv = this.camera.matrixWorldInverse
      let need = 0
      for (const c of this.frame.corners) {
        const p = c.clone().applyMatrix4(inv)
        const d = -p.z
        if (d <= 0) continue
        need = Math.max(need, Math.atan(Math.abs(p.y) / d), Math.atan(Math.abs(p.x) / d / this.camera.aspect))
      }
      // Room for tick labels outside the box (Mathematica's ImagePadding) when axes are drawn.
      const margin = this.scene.ticks && this.scene.axes.some(Boolean) ? 1.3 : 1.05
      this.camera.fov = this.scene.view.angle ? THREE.MathUtils.radToDeg(this.scene.view.angle) : THREE.MathUtils.radToDeg(2 * need) * margin
    }
    this.camera.updateProjectionMatrix()
  }

  private lightPoint(spec: LightPos | null | undefined, fromFront: boolean): THREE.Vector3 {
    if (!spec || !this.frame || !this.root) return new THREE.Vector3(0, 0, 0)
    if (spec.imageScaled) {
      const v = spec.imageScaled
      this.camera.updateMatrixWorld()
      const inv = this.camera.matrixWorldInverse
      const min = new THREE.Vector3(Infinity, Infinity, Infinity), max = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
      for (const c of this.frame.corners) { const p = c.clone().applyMatrix4(inv); min.min(p); max.max(p) }
      // camera space looks down -z: back of the box = min.z, front = max.z. Directional lights count depth
      // from the back (documented), point lights from the front (measured, 2026-09-21).
      const z0 = fromFront ? max.z : min.z
      const p = new THREE.Vector3(min.x + (v[0] ?? 0) * (max.x - min.x), min.y + (v[1] ?? 0) * (max.y - min.y), z0 + (v[2] ?? 0) * (max.z - min.z))
      return p.applyMatrix4(this.camera.matrixWorld)
    }
    if (spec.scaled) return v3(spec.scaled.map((f, i) => (this.frame!.center[i] as number) - (this.frame!.extent[i] as number) / 2 + f * (this.frame!.extent[i] as number))).applyMatrix4(this.root.matrixWorld)
    return v3(spec.scene ?? [0, 0, 0]).applyMatrix4(this.root.matrixWorld)
  }

  private updateLights(): void {
    for (const { light, spec } of this.lights) {
      if (light instanceof THREE.AmbientLight) continue
      const directional = light instanceof THREE.DirectionalLight
      const from = this.lightPoint(spec.from, !directional)
      if (directional || light instanceof THREE.SpotLight) {
        const to = spec.to ? this.lightPoint(spec.to, false) : new THREE.Vector3(0, 0, 0)
        const dir = from.clone().sub(to).normalize()
        light.position.copy(to.clone().add(dir.multiplyScalar(directional ? 10 : from.distanceTo(to))));
        (light as THREE.DirectionalLight | THREE.SpotLight).target.position.copy(to)
      } else light.position.copy(from)
    }
  }

  /** Ticks on the box edges that project farthest from the centre (the AxesEdge -> Automatic feel). */
  private drawAxes(): void {
    const scene = this.scene, frame = this.frame, group = this.tickGroup
    if (!scene || !frame || !group) return
    group.clear()
    if (!scene.ticks) return
    this.camera.updateMatrixWorld()
    const project = (v: THREE.Vector3) => v.clone().project(this.camera)
    const c0 = project(new THREE.Vector3(0, 0, 0))
    const lineMat = new THREE.LineBasicMaterial({ color: new THREE.Color(this.ink) })
    for (let axis = 0; axis < 3; axis++) {
      if (!scene.axes[axis]) continue
      const others = [0, 1, 2].filter(a => a !== axis) as [number, number]
      let best: { mid: THREE.Vector3 } | null = null, bestD = -1
      for (const s1 of [-1, 1]) for (const s2 of [-1, 1]) {
        const mid = new THREE.Vector3()
        mid.setComponent(others[0], s1 * (frame.half[others[0]] as number))
        mid.setComponent(others[1], s2 * (frame.half[others[1]] as number))
        const p = project(mid), d = Math.hypot(p.x - c0.x, p.y - c0.y)
        if (d > bestD) { bestD = d; best = { mid } }
      }
      if (!best) continue
      const tick = scene.ticks[axis]
      if (!tick) continue
      const toBox = (v: number) => (v - (frame.center[axis] as number)) * (frame.boxScale[axis] as number)
      const outward = best.mid.clone().normalize()
      const pts: THREE.Vector3[] = []
      for (const t of tick.major) {
        const a = best.mid.clone(); a.setComponent(axis, toBox(t.pos))
        pts.push(a, a.clone().add(outward.clone().multiplyScalar(0.02)))
        group.add(labelObject(t.label, a.clone().add(outward.clone().multiplyScalar(0.06)), this.ink, 10))
      }
      for (const m of tick.minor) { const a = best.mid.clone(); a.setComponent(axis, toBox(m)); pts.push(a, a.clone().add(outward.clone().multiplyScalar(0.01))) }
      group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), lineMat))
      const label = scene.axesLabel?.[axis]
      if (label) group.add(labelObject(label, best.mid.clone().add(outward.clone().multiplyScalar(0.14)), this.ink, 11))
    }
  }

  private render(): void {
    if (this.disposed) return
    this.updateLights()
    this.renderer.render(this.three, this.camera)
    this.labels.render(this.three, this.camera)
  }
}

function labelObject(text: string, position: THREE.Vector3, ink: string, fontSize: number): CSS2DObject {
  const div = document.createElement('div')
  div.textContent = text
  Object.assign(div.style, { color: ink, fontSize: `${fontSize}px`, whiteSpace: 'nowrap', pointerEvents: 'none', fontFamily: 'inherit' })
  const label = new CSS2DObject(div)
  label.position.copy(position)
  return label
}

function disposeTree(object: THREE.Object3D): void {
  object.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.geometry) m.geometry.dispose()
    const mat = (m as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
    if (Array.isArray(mat)) mat.forEach(x => x.dispose()); else mat?.dispose()
    if (o instanceof CSS2DObject) o.element.remove()
  })
}

// ---------------------------------------------------------------- element builders

class Builder {
  private disc: THREE.Texture | undefined
  constructor(private readonly frame: { longest: number }, private readonly widthPx: number, private readonly ink: string) {}

  private surface(style: Style, opts: { flat?: boolean, vertexColors?: boolean } = {}): THREE.MeshPhongMaterial {
    const spec = style.specular
    const m = new THREE.MeshPhongMaterial({
      color: opts.vertexColors ? new THREE.Color(1, 1, 1) : col(style.color, [1, 1, 1]),
      side: THREE.DoubleSide,
      transparent: (style.opacity ?? 1) < 1,
      opacity: style.opacity ?? 1,
      flatShading: !!opts.flat,
      vertexColors: !!opts.vertexColors,
      // Mathematica's exponent is classic Phong; Blinn's half-vector lobe needs ~4x and is normalized by (n/2+1)/pi.
      specular: spec ? col(spec.color, [1, 1, 1]).multiplyScalar(SPECULAR / (2 * spec.exponent + 1)) : new THREE.Color(0, 0, 0),
      shininess: spec ? 4 * spec.exponent : 30,
      emissive: style.glow ? col(style.glow, [0, 0, 0]) : new THREE.Color(0, 0, 0),
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    })
    return m
  }
  private lineMat(style: { color?: number[], opacity?: number }): THREE.LineBasicMaterial {
    return new THREE.LineBasicMaterial({ color: col(style.color, [0, 0, 0]), transparent: (style.opacity ?? 1) < 1, opacity: style.opacity ?? 1 })
  }
  private scaled(spec: { scaled?: number, absolute?: number } | undefined, fallback: number): number {
    if (!spec) return fallback
    if (spec.scaled != null) return spec.scaled * this.frame.longest
    if (spec.absolute != null) return spec.absolute / 72 * this.frame.longest / 5
    return fallback
  }

  build(e: Element, complex: Complex | null): THREE.Object3D | null {
    switch (e.type) {
      case 'sphere': return this.sphere(e)
      case 'cylinder': return this.cylinderLike(e, false)
      case 'cone': return this.cylinderLike(e, true)
      case 'cuboid': return this.cuboid(e)
      case 'tube': return this.tube(e, complex, undefined)
      case 'polyhedron': return this.polyhedron(e)
      case 'mesh': return this.mesh(e, complex)
      case 'line': return this.line(e, complex)
      case 'point': return this.point(e, complex)
      case 'arrow': return this.arrow(e, complex)
      case 'text': return this.text(e)
      case 'group': return this.group(e, complex)
      case 'complex': return this.complex(e as Complex)
      default: return null
    }
  }

  private aligned(geometry: THREE.BufferGeometry, p1: number[], p2: number[], material: THREE.Material): THREE.Mesh {
    const a = v3(p1), b = v3(p2), dir = b.clone().sub(a)
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.copy(a.clone().add(b).multiplyScalar(0.5))
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize())
    return mesh
  }
  private sphere(e: Element): THREE.Object3D {
    const g = new THREE.Group()
    const geo = new THREE.SphereGeometry(e.radius as number, 32, 16)
    const mat = this.surface(e.style)
    for (const c of e.centers as number[][]) { const m = new THREE.Mesh(geo, mat); m.position.set(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0); g.add(m) }
    return g
  }
  private cylinderLike(e: Element, cone: boolean): THREE.Object3D {
    const g = new THREE.Group()
    const mat = this.surface(e.style)
    const r = e.radius as number
    for (const [p1, p2] of e.segments as [number[], number[]][]) {
      const len = v3(p2).sub(v3(p1)).length()
      const geo = cone ? new THREE.ConeGeometry(r, len, 32) : new THREE.CylinderGeometry(r, r, len, 32)
      g.add(this.aligned(geo, p1, p2, mat))
    }
    return g
  }
  private cuboid(e: Element): THREE.Object3D {
    const min = e.min as number[], max = e.max as number[]
    const size = max.map((x, i) => x - (min[i] as number))
    const geo = new THREE.BoxGeometry(size[0], size[1], size[2])
    const m = new THREE.Mesh(geo, this.surface(e.style, { flat: true }))
    m.position.set((min[0] as number) + (size[0] as number) / 2, (min[1] as number) + (size[1] as number) / 2, (min[2] as number) + (size[2] as number) / 2)
    const g = new THREE.Group(); g.add(m)
    if (e.style.edge) { const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), this.lineMat(e.style.edge)); edges.position.copy(m.position); g.add(edges) }
    return g
  }
  private paths(e: Element, complex: Complex | null): number[][][] {
    const paths = e.paths as number[][][] | number[][]
    if (e.idx && complex) return (paths as number[][]).map(p => p.map(i => complex.coords[i] as number[]))
    return paths as number[][][]
  }
  private tube(e: Element, complex: Complex | null, radiusOverride: number | undefined): THREE.Object3D {
    const g = new THREE.Group()
    const radius = radiusOverride ?? (e.radius as number | null) ?? this.scaled(e.style.thickness, 0.002 * this.frame.longest) * 2
    const mat = this.surface(e.style)
    const cap = new THREE.SphereGeometry(radius, 16, 8)
    for (const path of this.paths(e, complex)) {
      if (path.length < 2) continue
      const curve = new THREE.CurvePath<THREE.Vector3>()
      for (let i = 0; i + 1 < path.length; i++) curve.add(new THREE.LineCurve3(v3(path[i] as number[]), v3(path[i + 1] as number[])))
      g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(8, (path.length - 1) * 4), radius, 16, false), mat))
      for (const p of [path[0] as number[], path[path.length - 1] as number[]]) { const s = new THREE.Mesh(cap, mat); s.position.copy(v3(p)); g.add(s) }
    }
    return g
  }
  private meshGeometry(coords: number[][], faces: number[][], normals: number[][] | undefined, colors: number[][] | undefined): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(coords.flat(), 3))
    const index: number[] = []
    for (const f of faces) for (let i = 1; i + 1 < f.length; i++) index.push(f[0] as number, f[i] as number, f[i + 1] as number)
    geo.setIndex(index)
    if (normals) geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals.flat(), 3)); else geo.computeVertexNormals()
    if (colors) geo.setAttribute('color', new THREE.Float32BufferAttribute(colors.flat(), 3))
    return geo
  }
  private faceEdges(coords: number[][], faces: number[][], style: { color?: number[], opacity?: number }): THREE.LineSegments {
    const pts: number[] = []
    for (const f of faces) for (let i = 0; i < f.length; i++) pts.push(...(coords[f[i] as number] as number[]), ...(coords[f[(i + 1) % f.length] as number] as number[]))
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    return new THREE.LineSegments(geo, this.lineMat(style))
  }
  private mesh(e: Element, complex: Complex | null): THREE.Object3D {
    const coords = (e.idx && complex ? complex.coords : e.coords) as number[][]
    const faces = e.faces as number[][]
    const colors = (e.vertexColors as number[][] | undefined) ?? (e.idx && complex ? complex.vertexColors : undefined)
    const normals = e.idx && complex ? complex.vertexNormals : undefined
    const g = new THREE.Group()
    g.add(new THREE.Mesh(this.meshGeometry(coords, faces, normals, colors), this.surface(e.style, { flat: !e.idx, vertexColors: !!colors })))
    if (e.style.edge && !e.idx) g.add(this.faceEdges(coords, faces, e.style.edge))
    return g
  }
  private polyhedron(e: Element): THREE.Object3D {
    const coords: number[][] = [], faces: number[][] = []
    const src = e.coords as number[][]
    for (const f of e.faces as number[][]) { const base = coords.length; for (const i of f) coords.push(src[i] as number[]); faces.push(f.map((_, k) => base + k)) }
    const g = new THREE.Group()
    g.add(new THREE.Mesh(this.meshGeometry(coords, faces, undefined, undefined), this.surface(e.style, { flat: true })))
    if (e.style.edge !== null) g.add(this.faceEdges(src, e.faces as number[][], e.style.edge ?? { color: [0, 0, 0] }))
    return g
  }
  private line(e: Element, complex: Complex | null): THREE.Object3D {
    const g = new THREE.Group()
    for (const path of this.paths(e, complex)) g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(path.map(v3)), this.lineMat(e.style)))
    return g
  }
  private discTexture(): THREE.Texture {
    if (this.disc) return this.disc
    const c = document.createElement('canvas'); c.width = c.height = 64
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(32, 32, 30, 0, 2 * Math.PI); ctx.fill()
    this.disc = new THREE.CanvasTexture(c)
    return this.disc
  }
  private point(e: Element, complex: Complex | null): THREE.Object3D {
    const coords = (e.idx && complex ? (e.idx as number[]).map(i => complex.coords[i] as number[]) : e.coords) as number[][]
    const px = e.style.pointSize?.scaled != null ? e.style.pointSize.scaled * this.widthPx : (e.style.pointSize?.absolute ?? 4)
    const mat = new THREE.PointsMaterial({ color: col(e.style.color, [0, 0, 0]), size: px, sizeAttenuation: false, map: this.discTexture(), alphaTest: 0.5, transparent: true })
    return new THREE.Points(new THREE.BufferGeometry().setFromPoints(coords.map(v3)), mat)
  }
  private arrow(e: Element, complex: Complex | null): THREE.Object3D {
    const g = new THREE.Group()
    const headLen = (e.style.arrowheads ?? 0.04) * this.frame.longest
    const radius = e.radius as number | null
    for (const path of this.paths(e, complex)) {
      const shaft: Element = { ...e, paths: [path], idx: false }
      g.add(e.tube ? this.tube(shaft, null, radius ?? undefined) : this.line(shaft, null))
      if (headLen <= 0 || path.length < 2) continue
      const tip = v3(path[path.length - 1] as number[]), prev = v3(path[path.length - 2] as number[])
      const dir = tip.clone().sub(prev).normalize()
      const base = tip.clone().sub(dir.clone().multiplyScalar(headLen))
      const r = radius != null ? radius * 2.5 : headLen * 0.3
      g.add(this.aligned(new THREE.ConeGeometry(r, headLen, 24), base.toArray(), tip.toArray(), this.surface({ ...e.style, color: e.style.color ?? [0, 0, 0] })))
    }
    return g
  }
  private text(e: Element): THREE.Object3D {
    const div = document.createElement('div')
    div.textContent = String(e.text ?? '')
    Object.assign(div.style, { color: e.style.color ? col(e.style.color, [0, 0, 0]).getStyle() : this.ink, fontSize: '12px', whiteSpace: 'nowrap', pointerEvents: 'none', fontFamily: 'inherit' })
    const [ox, oy] = (e.offset as number[] | undefined) ?? [0, 0]
    div.style.transform = `translate(${-50 - 50 * (ox ?? 0)}%, ${-50 + 50 * (oy ?? 0)}%)`
    const label = new CSS2DObject(div)
    label.center.set(0, 0)
    label.position.copy(v3(e.position as number[]))
    return label
  }
  private group(e: Element, complex: Complex | null): THREE.Object3D {
    const g = new THREE.Group()
    const { m, t } = e.matrix as { m: number[][], t: number[] }
    const r = (i: number, j: number) => (m[i] as number[])[j] as number
    g.matrix.set(r(0, 0), r(0, 1), r(0, 2), t[0] as number, r(1, 0), r(1, 1), r(1, 2), t[1] as number, r(2, 0), r(2, 1), r(2, 2), t[2] as number, 0, 0, 0, 1)
    g.matrixAutoUpdate = false
    for (const c of e.children as Element[]) { const o = this.build(c, complex); if (o) g.add(o) }
    return g
  }
  private complex(e: Complex): THREE.Object3D {
    const g = new THREE.Group()
    for (const c of e.children) { const o = this.build(c, e); if (o) g.add(o) }
    return g
  }
}

// ---------------------------------------------------------------- React component

export interface Scene3DViewProps {
  /** The scene to draw; a new object re-renders with the camera kept. */
  scene: Scene3D
  width: number
  height: number
  /** Called once with the frame's PNG data URL producer, for the caption/open affordances. */
  onReady?: (api: { snapshot: () => string }) => void
  /** WebGL unavailable or the scene failed to build: the caller falls back to the PNG. */
  onError?: (message: string) => void
}

/** Current foreground colour of the element (the chat's text colour = box/tick ink). */
function inkOf(el: HTMLElement): string {
  const c = getComputedStyle(el).color
  return c && c !== '' ? c : '#222'
}

export function Scene3DView({ scene, width, height, onReady, onError }: Scene3DViewProps) {
  const host = useRef<HTMLDivElement | null>(null)
  const renderer = useRef<SceneRenderer | null>(null)
  const [error, setError] = useState<string | undefined>(undefined)
  const fail = (e: unknown) => { const message = e instanceof Error ? e.message : String(e); setError(message); onError?.(message) }

  useEffect(() => {
    const el = host.current
    if (!el) return
    try {
      const r = new SceneRenderer(el, { width, height, ink: inkOf(el) })
      renderer.current = r
      onReady?.({ snapshot: () => r.snapshot() })
    } catch (e) {
      fail(e)   // no WebGL: the caller shows the PNG
    }
    return () => { renderer.current?.dispose(); renderer.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => { renderer.current?.resize(width, height) }, [width, height])

  useEffect(() => {
    const r = renderer.current
    if (!r) return
    try { r.setScene(scene, r.loaded) } catch (e) { fail(e) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene])

  if (error !== undefined) return <div style={{ fontSize: 12, opacity: 0.7 }}>[3D view unavailable: {error}]</div>
  const style: CSSProperties = { position: 'relative', width, height, maxWidth: '100%', cursor: 'grab', touchAction: 'none' }
  return <div ref={host} style={style} data-wolfram-scene3d={scene.elements.length} />
}
