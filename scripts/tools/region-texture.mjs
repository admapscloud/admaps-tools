// modules/adm-levels/scripts/tools/region-texture.mjs
// ADMaps Tools — «Region texture».
// A region type «Texture»: the region is filled with a picture repeated over the scene (scale, rotation, strength, tint),
// its edge dissolving into the map inwards — smooth or ragged, as wide as set. Trampled clearings, paths, mud.
//
// How. Per region, a PIXI mesh of the region's own triangulation (holes included) sits in the primary canvas group
// between the scene background and the tiles (sortLayer 100 at the region's bottom elevation, 0 by default), so it is
// lit, fogged and covered by props like the map itself. Its shader repeats the texture in scene space (textureGrad on
// fract() — no seams with mipmaps; regions with the same texture join), and takes the alpha from a mask: the region
// shape blurred by the edge width, rendered once into a small render texture (0 outside, ½ on the outline, 1 inside),
// so the fade happens inside the outline; «Ragged» moves the fade line inwards by fractal noise in scene space.
// A switched-off region (its box or its bound tile — main.mjs __admRegionOff) is hidden.
// Settings: in the region config, under the type select (main.mjs) — the tool adds the «Texture» option and its rows.
// The region config has no live preview of its own, so the texture follows the controls before saving here, and
// goes back to the saved state when the window closes.

import { SPOILER_CSS, dialHtml, nextFrame, wireControls } from "./ui-controls.mjs";

const MODULE_ID = "adm-levels";
const FLAG = "texture";   // flags.adm-levels.texture.{src, scale, rotation, alpha, edge, width, tint}
const DEFAULTS = { src: "", scale: 100, rotation: 0, alpha: 100, edge: "ragged", width: 60, tint: "#ffffff" };
const SORT_LAYER = 100;   // between the scene background (0) and the tiles (500)
const MASK_MAX = 1024;    // the mask render texture's longest side, px
const BLUR_K = 1;         // blur strength per px of edge width (the fade reaches full strength about «width» inside)

const _num = (v, d) => (Number.isFinite(Number(v)) && v !== "" && v !== null ? Number(v) : d);
const _isTexture = (doc) => doc?.flags?.[MODULE_ID]?.type === "texture";
const _hex = (v) => (/^#[0-9a-f]{6}$/i.test(String(v ?? "")) ? String(v).toLowerCase() : DEFAULTS.tint);

function _cfg(doc) {
  const f = doc?.flags?.[MODULE_ID]?.[FLAG] ?? {};
  const n = (k, lo, hi) => Math.min(hi, Math.max(lo, _num(f[k], DEFAULTS[k])));
  return {
    src: String(f.src ?? ""),
    scale: n("scale", 1, 1000),
    rotation: _num(f.rotation, 0),
    alpha: n("alpha", 0, 100),
    edge: f.edge === "smooth" ? "smooth" : "ragged",
    width: n("width", 0, 2000),
    tint: _hex(f.tint),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────
const VERT = `#version 300 es
  precision highp float;
  in vec2 aVertexPosition;
  uniform mat3 projectionMatrix;
  uniform mat3 translationMatrix;
  out vec2 vScene;
  void main() {
    vScene = aVertexPosition;
    gl_Position = vec4((projectionMatrix * translationMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);
  }`;

// q — the texture coordinate in repeats, turned about the scene origin; the tint multiplies the colour like a tile's;
// the mask — the blurred shape; «ragged»: the fade line wanders between ½ and 1 − soft by fbm noise (features about the
// edge width), the deep inside always full.
const FRAG = `#version 300 es
  precision highp float;
  in vec2 vScene;
  uniform sampler2D uTex;
  uniform sampler2D uMask;
  uniform vec2 uTexSize;
  uniform vec2 uRot;
  uniform vec3 uTint;
  uniform vec4 uMaskFrame;
  uniform float uAlpha;
  uniform float uRagged;
  uniform float uWidth;
  uniform vec2 uSeed;
  out vec4 fragColor;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
    return s / 0.9375;
  }
  void main() {
    vec2 q = vec2(uRot.x * vScene.x + uRot.y * vScene.y, -uRot.y * vScene.x + uRot.x * vScene.y) / uTexSize;
    vec4 col = textureGrad(uTex, fract(q), dFdx(q), dFdy(q));
    col.rgb *= uTint;
    float m = texture(uMask, (vScene - uMaskFrame.xy) / uMaskFrame.zw).r;
    float a;
    if (uRagged > 0.5) {
      const float soft = 0.12;
      float n = clamp((fbm(vScene / max(uWidth * 0.6, 4.0) + uSeed) - 0.5) * 2.2 + 0.5, 0.0, 1.0);   // fbm crowds ½ — stretched
      float t = 0.5 + (0.5 - soft) * n;
      a = smoothstep(t, t + soft, m);
    } else {
      a = smoothstep(0.5, 1.0, m);
    }
    fragColor = col * (a * uAlpha);
  }`;

const _entries = new Map();   // region id → { mesh, tri, mask, width }
const _tickets = new Map();   // region id → the latest render call (an older one finishing late is dropped)

function _geometry(tri) {
  return new PIXI.Geometry().addAttribute("aVertexPosition", tri.vertices, 2).addIndex(tri.indices);
}

/** The region shape, white, blurred by the edge width into a small render texture; frame — what it covers, scene px. */
function _buildMask(doc, width) {
  const b = doc.bounds;
  const pad = Math.ceil(width * 1.5) + 4;
  const W = b.width + 2 * pad, H = b.height + 2 * pad;
  const res = Math.min(1, MASK_MAX / Math.max(W, H, 1));
  const rt = PIXI.RenderTexture.create({ width: Math.max(1, Math.ceil(W * res)), height: Math.max(1, Math.ceil(H * res)) });
  const g = new PIXI.Graphics();
  g.beginFill(0xffffff, 1);
  for (const node of doc.polygonTree) {
    if (node.isHole) continue;
    g.drawPolygon(node.points);
    for (const hole of node.children) { g.beginHole(); g.drawPolygon(hole.points); g.endHole(); }
  }
  g.endFill();
  g.position.set(pad - b.x, pad - b.y);
  const box = new PIXI.Container();
  box.scale.set(res);
  box.addChild(g);
  const blur = width > 0 ? new PIXI.BlurFilter(width * res * BLUR_K, 4) : null;
  if (blur) box.filters = [blur];
  canvas.app.renderer.render(box, { renderTexture: rt, clear: true });
  box.destroy({ children: true });
  blur?.destroy();
  return { rt, frame: [b.x - pad, b.y - pad, rt.width / res, rt.height / res] };
}

function _remove(id) {
  const e = _entries.get(id);
  if (!e) return;
  _entries.delete(id);
  try { if (!e.mesh.destroyed) e.mesh.destroy(); } catch (_e) {}
  try { e.mask?.rt.destroy(true); } catch (_e) {}
}

function _clear() { for (const id of [..._entries.keys()]) _remove(id); }

/** Draw, update or remove the region's texture. override — unsaved settings from the open region config. */
async function _render(doc, override = null) {
  const id = doc?.id;
  if (!id) return;
  const ticket = (_tickets.get(id) ?? 0) + 1;
  _tickets.set(id, ticket);
  const c = override ?? (_isTexture(doc) ? _cfg(doc) : null);
  if (!c?.src || doc.parent !== canvas?.scene || !canvas?.primary) { _remove(id); return; }
  let tex = null;
  try { tex = await foundry.canvas.loadTexture(c.src); } catch (_e) {}
  if (_tickets.get(id) !== ticket) return;
  const tri = doc.triangulation;
  if (!tex?.baseTexture || !tri?.indices?.length || !canvas?.primary) { _remove(id); return; }

  let e = _entries.get(id);
  if (e && (e.mesh.destroyed || e.mesh.parent !== canvas.primary)) { _remove(id); e = null; }
  if (!e) {
    const shader = PIXI.Shader.from(VERT, FRAG, {
      uTex: tex, uMask: PIXI.Texture.EMPTY, uTexSize: new Float32Array(2), uRot: new Float32Array(2), uTint: new Float32Array([1, 1, 1]), uMaskFrame: new Float32Array(4),
      uAlpha: 1, uRagged: 1, uWidth: 1, uSeed: new Float32Array(2),
    });
    e = { mesh: new PIXI.Mesh(_geometry(tri), shader), tri, mask: null, width: -1 };
    e.mesh.name = `admRegionTexture.${id}`;
    _entries.set(id, e);
    canvas.primary.addChild(e.mesh);
  } else if (e.tri !== tri) {   // the shape changed
    e.mesh.geometry = _geometry(tri);
    e.tri = tri;
    e.width = -1;
  }
  if (e.width !== c.width) {
    try { e.mask?.rt.destroy(true); } catch (_e) {}
    e.mask = _buildMask(doc, c.width);
    e.width = c.width;
  }

  const u = e.mesh.shader.uniforms, k = c.scale / 100, r = (Number(c.rotation) || 0) * Math.PI / 180;
  u.uTex = tex;
  u.uMask = e.mask.rt;
  u.uTexSize[0] = Math.max(1, tex.width * k); u.uTexSize[1] = Math.max(1, tex.height * k);
  u.uRot[0] = Math.cos(r); u.uRot[1] = Math.sin(r);
  const tint = parseInt(_hex(c.tint).slice(1), 16);
  u.uTint[0] = (tint >> 16 & 255) / 255; u.uTint[1] = (tint >> 8 & 255) / 255; u.uTint[2] = (tint & 255) / 255;
  u.uMaskFrame.set(e.mask.frame);
  u.uAlpha = c.alpha / 100;
  u.uRagged = c.edge === "ragged" ? 1 : 0;
  u.uWidth = c.width;
  let h = 2166136261;   // per-region seed: its own ragged outline, the same on every client
  for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  u.uSeed[0] = ((h >>> 0) % 1000) / 7.3; u.uSeed[1] = ((h >>> 10) % 1000) / 9.1;

  const m = e.mesh;
  m.elevation = Number.isFinite(doc.elevation?.bottom) ? doc.elevation.bottom : 0;
  m.sortLayer = SORT_LAYER;
  m.sort = 0;
  m.visible = !globalThis.__admRegionOff?.(doc);
  canvas.primary.sortDirty = true;
}

function _renderAll() {
  for (const doc of canvas?.scene?.regions ?? []) {
    if (!_isTexture(doc)) continue;
    _render(doc);
    _syncFill(doc.object);   // regions drawn before the tool's hooks (the first canvas of a session)
  }
}

/** The region's own hatched fill (core's RegionMesh child, a private field) covers the texture: on a texture region it
 *  goes see-through — still the click target, the outline stays for selecting and editing — and comes back when the
 *  type changes. hide — the type shown in an open config (not saved yet).
 *  ⚠️ The alpha is pinned, not set: Token Magic FX writes its «Opacity» (flags.tokenmagic.regionData.alpha) into this
 *  very mesh on load and 250 ms after every region update. Not renderable=false: PIXI then drops it from hit testing. */
function _syncFill(region, hide = _isTexture(region?.document)) {
  const RegionMesh = foundry?.canvas?.placeables?.regions?.RegionMesh;
  const fill = region?.children?.find?.((c) => (RegionMesh ? c instanceof RegionMesh : c?.constructor?.name === "RegionMesh"));
  if (!fill) return;
  if (hide && !fill._admTexAlpha) {
    let wanted = fill.alpha;   // what core / Token Magic set — given back when the type changes
    Object.defineProperty(fill, "alpha", { configurable: true, get: () => 0, set: (v) => { wanted = v; } });
    fill._admTexAlpha = () => wanted;
  } else if (!hide && fill._admTexAlpha) {
    const v = fill._admTexAlpha();
    delete fill.alpha;
    fill.alpha = v;
    fill._admTexAlpha = null;
  }
}

function _refreshVisibility() {
  for (const [id, e] of _entries) {
    const doc = canvas?.scene?.regions?.get(id);
    if (doc && !e.mesh.destroyed) e.mesh.visible = !globalThis.__admRegionOff?.(doc);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UI: rows in the region config, under the type select (main.mjs)
// ─────────────────────────────────────────────────────────────────────────────
const CSS = `
  .adm-rt-grid { display: grid; width: 100%; box-sizing: border-box; padding-right: 5px; align-items: center; gap: 8px 9px;
    grid-template-columns: minmax(0, max-content) minmax(64px, 1fr) 36px minmax(0, max-content) minmax(64px, 1fr) 36px; }
  .adm-rt-grid > label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .adm-rt-grid > input[type=color] { justify-self: center; width: 28px; height: 28px; min-height: 0; padding: 0; margin: 0; cursor: pointer;
    border: 1px solid var(--color-border-light-tertiary, #7a7971); border-radius: 50%; background: none; box-shadow: none; }
  .adm-rt-grid > input[type=color]::-webkit-color-swatch-wrapper { padding: 0; }
  .adm-rt-grid > input[type=color]::-webkit-color-swatch { border: none; border-radius: 50%; }
  .adm-rt-grid > input[type=color]::-moz-color-swatch { border: none; border-radius: 50%; }`;

function _injectConfig(app, html) {
  const root = html instanceof HTMLElement ? html : (html?.[0] ?? html);
  const typeSel = root?.querySelector?.("select[data-adm-type]");
  if (!typeSel || root.querySelector("[data-adm-texture-group]")) return;
  const doc = app.document;
  const c = _cfg(doc);
  const L = (k) => game.i18n.localize(`ADM_LEVELS.${k}`);
  const nm = (k) => `flags.${MODULE_ID}.${FLAG}.${k}`;
  if (!typeSel.querySelector('option[value="texture"]')) typeSel.insertAdjacentHTML("beforeend", `<option value="texture">${L("ui.texture")}</option>`);
  if (_isTexture(doc)) typeSel.value = "texture";   // main.mjs marks only its own options selected
  const show = typeSel.value === "texture" ? "flex" : "none";
  const picker = (k, min, max, step) => `<range-picker name="${nm(k)}" value="${c[k]}" min="${min}" max="${max}" step="${step}"></range-picker>`;
  const opt = (v, label) => `<option value="${v}"${c.edge === v ? " selected" : ""}>${label}</option>`;
  const injectHtml = `
    <div class="form-group" data-adm-texture-group style="display:${show};">
      <label>${L("ui.texture")}</label>
      <div class="form-fields"><file-picker name="${nm("src")}" type="image" value="${c.src}"></file-picker></div>
    </div>
    <div class="form-group adm-controls" data-adm-texture-group style="display:${show};">
      <style>${SPOILER_CSS}${CSS}</style>
      <div class="adm-rt-grid">
        <label>${L("regionTexture.scale")}</label>${picker("scale", 10, 400, 5)}<span></span>
        <label>${L("regionTexture.alpha")}</label>${picker("alpha", 0, 100, 1)}${dialHtml(nm("rotation"), c.rotation, L("tileScroll.patternRotation"))}
        <label>${L("tileScroll.edge")}</label><select name="${nm("edge")}">${opt("smooth", L("tileScroll.edgeStraight"))}${opt("ragged", L("tileScroll.edgeTorn"))}</select><span></span>
        <label>${L("regionTexture.width")}</label>${picker("width", 0, 300, 1)}<input
          type="color" name="${nm("tint")}" value="${c.tint}" aria-label="${L("regionTexture.tint")}">
      </div>
    </div>`;
  const anchor = root.querySelector("[data-adm-transport-group]") ?? typeSel.closest(".form-group");
  anchor.insertAdjacentHTML("afterend", injectHtml);
  const groups = [...root.querySelectorAll("[data-adm-texture-group]")];
  for (const g of groups) wireControls(g);

  // Preview on the map while the window is open (at most once a frame).
  const q = (k) => root.querySelector(`[name="${nm(k)}"]`);
  const read = () => ({
    src: String(q("src")?.value ?? ""), scale: _num(q("scale")?.value, 100), rotation: _num(q("rotation")?.value, 0),
    alpha: _num(q("alpha")?.value, 100), edge: q("edge")?.value === "smooth" ? "smooth" : "ragged", width: _num(q("width")?.value, 60),
    tint: _hex(q("tint")?.value),
  });
  const preview = () => nextFrame(doc, () => {
    const on = typeSel.value === "texture";
    if (on) _render(doc, read());
    else _remove(doc.id);
    _syncFill(doc.object, on);
  });
  typeSel.addEventListener("change", () => {
    for (const g of groups) g.style.display = typeSel.value === "texture" ? "flex" : "none";
    try { app.setPosition({ height: "auto" }); } catch (_e) {}
    preview();
  });
  for (const g of groups) g.addEventListener("change", preview);
  q("tint")?.addEventListener("input", preview);   // the colour dialog sends «input» while picking, «change» on close
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMaps Tools sub-module descriptor
// ─────────────────────────────────────────────────────────────────────────────
export const TOOL = {
  id: "regionTexture",
  name: "ADM_LEVELS.settings.regionTexture.name",
  hint: "ADM_LEVELS.settings.regionTexture.hint",

  onReady({ isEnabled }) {
    Hooks.on("canvasReady", () => { _clear(); if (isEnabled()) _renderAll(); });
    Hooks.on("canvasTearDown", _clear);
    Hooks.on("createRegion", (doc) => { if (isEnabled() && _isTexture(doc)) _render(doc); });
    Hooks.on("updateRegion", (doc) => {
      if (!isEnabled()) return;
      if (_isTexture(doc) || _entries.has(doc.id)) _render(doc);
      _syncFill(doc.object);
    });
    // A redrawn region gets a new fill at core's alpha.
    Hooks.on("drawRegion", (region) => { if (isEnabled()) _syncFill(region); });
    Hooks.on("refreshRegion", (region) => { if (isEnabled()) _syncFill(region); });
    Hooks.on("deleteRegion", (doc) => _remove(doc.id));
    Hooks.on("updateTile", (_tile, changed) => { if ("hidden" in (changed ?? {})) _refreshVisibility(); });
    Hooks.on("renderRegionConfig", (app, html) => {
      if (!isEnabled()) return;
      try { _injectConfig(app, html); } catch (e) { console.warn("[ADM:regionTexture] config:", e); }
    });
    Hooks.on("closeRegionConfig", (app) => {
      if (!isEnabled() || !app.document) return;
      _render(app.document);
      _syncFill(app.document.object);
    });
    if (canvas?.ready && isEnabled()) _renderAll();
  },
};
