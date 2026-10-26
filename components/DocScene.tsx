"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

/**
 * 3D view of the importer's documents. The animation mirrors what the agent is
 * actually doing:
 *   reading  -> a scan beam sweeps each sheet until that page's extraction returns
 *   checking -> threads draw between documents as they are cross-checked
 *   result   -> threads settle green (consistent) or pulse red (conflict)
 */

export type SheetState = "idle" | "scanning" | "done" | "failed";
export type Phase = "idle" | "reading" | "checking" | "result";
export interface Link { a: number; b: number; ok: boolean }

interface Props {
  images: string[]; // object URLs of uploaded photos ("" = placeholder sheet)
  states: SheetState[];
  phase: Phase;
  links: Link[];
}

const EMERALD = new THREE.Color("#34d399");
const RED = new THREE.Color("#fb7185");
const GOLD = new THREE.Color("#fbbf24");
const SHEET_W = 1.6;
const SHEET_H = 2.26; // A4 ratio

function placeholderTexture(i: number): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 362;
  const g = c.getContext("2d")!;
  g.fillStyle = "#f4f2ea"; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#1f2a24"; g.fillRect(24, 26, 120, 10);
  g.fillStyle = "#c9cfc7";
  for (let y = 56; y < 330; y += 14) g.fillRect(24, y, (y * 37 + i * 53) % 160 + 50, 5);
  g.strokeStyle = "#9aa59d"; g.strokeRect(24, 150, 208, 110);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function checkTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#34d399"; g.beginPath(); g.arc(64, 64, 60, 0, Math.PI * 2); g.fill();
  g.strokeStyle = "#022c1c"; g.lineWidth = 14; g.lineCap = "round"; g.lineJoin = "round";
  g.beginPath(); g.moveTo(36, 66); g.lineTo(56, 86); g.lineTo(94, 44); g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export default function DocScene({ images, states, phase, links }: Props) {
  const mount = useRef<HTMLDivElement>(null);
  const live = useRef({ states, phase, links });
  live.current = { states, phase, links };
  const api = useRef<{ setImages: (imgs: string[]) => void; rebuildLinks: () => void } | null>(null);

  // --- one-time scene setup -------------------------------------------------
  useEffect(() => {
    const el = mount.current!;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2("#05110c", 0.045);
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
    scene.add(new THREE.AmbientLight("#ffffff", 1.4));
    const key = new THREE.DirectionalLight("#e7fff4", 1.6);
    key.position.set(3, 5, 6);
    scene.add(key);
    const rim = new THREE.PointLight("#34d399", 18, 14);
    rim.position.set(0, -1.5, 2.5);
    scene.add(rim);

    // Starfield / dust
    const dustGeo = new THREE.BufferGeometry();
    const N = 520;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 22;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 12;
      pos[i * 3 + 2] = -Math.random() * 14 + 2;
    }
    dustGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: "#7ef0c2", size: 0.03, transparent: true, opacity: 0.55, depthWrite: false }));
    scene.add(dust);

    // Grid floor
    const grid = new THREE.GridHelper(40, 60, "#0f3d2a", "#0b2a1d");
    grid.position.y = -2.1;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.55;
    scene.add(grid);

    const group = new THREE.Group();
    scene.add(group);

    interface Sheet {
      root: THREE.Group; paper: THREE.Mesh; glow: THREE.Mesh; beam: THREE.Mesh; check: THREE.Mesh;
      base: THREE.Vector3; seed: number; doneAt: number;
    }
    let sheets: Sheet[] = [];
    const linkObjs: { line: THREE.Mesh; mat: THREE.MeshBasicMaterial; pulses: THREE.Mesh[]; link: Link; born: number; curve: THREE.QuadraticBezierCurve3 }[] = [];
    const pulseGeo = new THREE.SphereGeometry(0.045, 12, 12);
    const loader = new THREE.TextureLoader();

    function disposeSheets() {
      sheets.forEach((s) => {
        group.remove(s.root);
        s.root.traverse((o) => {
          const m = o as THREE.Mesh;
          m.geometry?.dispose?.();
          const mat = m.material as THREE.MeshStandardMaterial | undefined;
          mat?.map?.dispose?.();
          mat?.dispose?.();
        });
      });
      sheets = [];
    }

    function layout() {
      const n = sheets.length;
      const aspect = el.clientWidth / Math.max(1, el.clientHeight);
      const spread = aspect < 1 ? 1.62 : 2.05;
      sheets.forEach((s, i) => {
        const t = n === 1 ? 0 : i / (n - 1) - 0.5;
        const x = t * spread * (n - 1);
        s.base.set(x, 0.05, -Math.abs(t) * 0.9);
        s.root.rotation.y = -t * 0.55;
      });
      const width = Math.max(SHEET_W * 1.2, spread * (n - 1) + SHEET_W * 1.08);
      const fitW = (width / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / aspect;
      const fitH = (SHEET_H * 0.95) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      camera.position.set(0, 0.75, Math.max(fitW, fitH) + 0.55);
      camera.lookAt(0, 0.62, -0.4); // leave headroom for the threads above the sheets
    }

    function setImages(imgs: string[]) {
      disposeSheets();
      const list = imgs.length ? imgs : ["", "", ""];
      list.forEach((src, i) => {
        const root = new THREE.Group();
        const mat = new THREE.MeshStandardMaterial({ map: placeholderTexture(i), roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
        if (src) {
          loader.load(src, (tex) => {
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.anisotropy = 4;
            mat.map?.dispose();
            mat.map = tex;
            mat.needsUpdate = true;
          });
        }
        const paper = new THREE.Mesh(new THREE.PlaneGeometry(SHEET_W, SHEET_H), mat);
        const glow = new THREE.Mesh(
          new THREE.PlaneGeometry(SHEET_W + 0.16, SHEET_H + 0.16),
          new THREE.MeshBasicMaterial({ color: EMERALD, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false }),
        );
        glow.position.z = -0.01;
        const beam = new THREE.Mesh(
          new THREE.PlaneGeometry(SHEET_W + 0.1, 0.09),
          new THREE.MeshBasicMaterial({ color: EMERALD, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
        );
        beam.position.z = 0.02;
        const check = new THREE.Mesh(
          new THREE.CircleGeometry(0.17, 40),
          new THREE.MeshBasicMaterial({ map: checkTexture(), transparent: true, opacity: 0 }),
        );
        check.position.set(SHEET_W / 2 - 0.05, SHEET_H / 2 - 0.05, 0.03);
        root.add(glow, paper, beam, check);
        group.add(root);
        sheets.push({ root, paper, glow, beam, check, base: new THREE.Vector3(), seed: Math.random() * 10, doneAt: 0 });
      });
      layout();
      rebuildLinks();
    }

    function rebuildLinks() {
      linkObjs.forEach((l) => {
        group.remove(l.line); l.line.geometry.dispose(); l.mat.dispose();
        l.pulses.forEach((p) => { group.remove(p); (p.material as THREE.Material).dispose(); });
      });
      linkObjs.length = 0;
      const now = performance.now();
      live.current.links.forEach((link, k) => {
        const A = sheets[link.a], B = sheets[link.b];
        if (!A || !B) return;
        // Anchor on the top edge of each sheet and arc through the dark space above.
        const a = A.base.clone().add(new THREE.Vector3(0.18 * Math.sign(B.base.x - A.base.x), SHEET_H / 2 - 0.05, 0.08));
        const b = B.base.clone().add(new THREE.Vector3(0.18 * Math.sign(A.base.x - B.base.x), SHEET_H / 2 - 0.05, 0.08));
        const mid = a.clone().lerp(b, 0.5).add(new THREE.Vector3(0, 0.75 + Math.abs(link.b - link.a) * 0.45 + (k % 2) * 0.12, 0.4));
        const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
        const geo = new THREE.TubeGeometry(curve, 80, link.ok ? 0.014 : 0.022, 8, false);
        const mat = new THREE.MeshBasicMaterial({ color: link.ok ? EMERALD : RED, transparent: true, opacity: 0, depthWrite: false });
        const line = new THREE.Mesh(geo, mat);
        geo.setDrawRange(0, 0);
        group.add(line);
        const pulses = Array.from({ length: link.ok ? 2 : 3 }, () => {
          const m = new THREE.Mesh(pulseGeo, new THREE.MeshBasicMaterial({ color: link.ok ? "#bbf7d0" : "#fecdd3", transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
          group.add(m);
          return m;
        });
        linkObjs.push({ line, mat, pulses, link, born: now + k * 140, curve });
      });
    }

    api.current = { setImages, rebuildLinks };

    // Pointer / tilt parallax
    const target = { x: 0, y: 0 };
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      target.x = ((e.clientX - r.left) / r.width - 0.5) * 2;
      target.y = ((e.clientY - r.top) / r.height - 0.5) * 2;
    };
    el.addEventListener("pointermove", onMove);

    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
      layout();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    setImages([]);
    resize();

    let raf = 0;
    const clock = new THREE.Clock();
    const tick = () => {
      const t = clock.getElapsedTime();
      const now = performance.now();
      const { states: st, phase: ph } = live.current;

      group.rotation.y += ((target.x * 0.18) - group.rotation.y) * 0.05;
      group.rotation.x += ((target.y * 0.08) - group.rotation.x) * 0.05;
      dust.rotation.y = t * 0.012;
      grid.position.z = (t * 0.35) % (40 / 60);

      sheets.forEach((s, i) => {
        const state = st[i] ?? "idle";
        const float = reduced ? 0 : Math.sin(t * 0.9 + s.seed) * 0.07;
        s.root.position.set(s.base.x, s.base.y + float, s.base.z);
        const glowMat = s.glow.material as THREE.MeshBasicMaterial;
        const beamMat = s.beam.material as THREE.MeshBasicMaterial;
        const checkMat = s.check.material as THREE.MeshBasicMaterial;

        if (state === "scanning") {
          const k = (t * 0.75 + s.seed) % 1;
          s.beam.position.y = SHEET_H / 2 - k * SHEET_H;
          beamMat.opacity = 0.85;
          glowMat.color.copy(EMERALD);
          glowMat.opacity = 0.18 + Math.sin(t * 5) * 0.06;
          s.root.position.z += 0.25;
        } else {
          beamMat.opacity *= 0.88;
        }
        if (state === "done") {
          if (!s.doneAt) s.doneAt = now;
          const age = (now - s.doneAt) / 1000;
          glowMat.color.copy(EMERALD);
          glowMat.opacity = Math.max(0.12, 0.6 * Math.exp(-age * 2.2));
          checkMat.opacity = Math.min(1, age * 3);
          s.check.scale.setScalar(Math.min(1, 0.4 + age * 2.4));
        } else if (state === "failed") {
          glowMat.color.copy(RED);
          glowMat.opacity = 0.35 + Math.sin(t * 6) * 0.15;
          checkMat.opacity = 0;
        } else if (state === "idle") {
          s.doneAt = 0;
          glowMat.opacity *= 0.9;
          checkMat.opacity *= 0.9;
        }
      });

      // Threads: draw in, then data pulses flow along them; conflicts glow red
      linkObjs.forEach((l, k) => {
        const age = Math.max(0, (now - l.born) / 1000);
        const idxCount = (l.line.geometry.index?.count ?? 0);
        l.line.geometry.setDrawRange(0, Math.floor(idxCount * Math.min(1, age * 1.4)));
        const tgt = ph === "checking" ? 0.7 : ph === "result" ? (l.link.ok ? 0.55 : 1) : 0;
        l.mat.opacity += (tgt - l.mat.opacity) * 0.08;
        if (!l.link.ok && ph === "result") l.mat.color.copy(RED).lerp(GOLD, (Math.sin(t * 4) + 1) * 0.12);
        const drawn = Math.min(1, age * 1.4);
        l.pulses.forEach((p, j) => {
          const speed = l.link.ok ? 0.35 : 0.6;
          const u = ((t * speed + j / l.pulses.length + k * 0.17) % 1) * drawn;
          p.position.copy(l.curve.getPoint(u));
          const pm = p.material as THREE.MeshBasicMaterial;
          pm.opacity += ((drawn >= 1 && ph !== "idle" ? 0.95 : 0) - pm.opacity) * 0.1;
          p.scale.setScalar(1 + Math.sin(t * 8 + j) * 0.25);
        });
      });

      rim.intensity = ph === "result" && linkObjs.some((l) => !l.link.ok) ? 14 + Math.sin(t * 4) * 6 : 18;
      rim.color.copy(ph === "result" && linkObjs.some((l) => !l.link.ok) ? RED : EMERALD);

      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener("pointermove", onMove);
      disposeSheets();
      linkObjs.forEach((l) => { l.line.geometry.dispose(); l.mat.dispose(); l.pulses.forEach((p) => (p.material as THREE.Material).dispose()); });
      pulseGeo.dispose();
      dustGeo.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
      api.current = null;
    };
  }, []);

  const imgKey = images.join("|");
  useEffect(() => { api.current?.setImages(images); }, [imgKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const linkKey = links.map((l) => `${l.a}-${l.b}-${l.ok}`).join(",");
  useEffect(() => { api.current?.rebuildLinks(); }, [linkKey]);

  return <div ref={mount} className="scene" aria-hidden="true" />;
}
