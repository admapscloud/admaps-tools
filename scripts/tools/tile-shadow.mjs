// modules/adm-levels/scripts/tools/tile-shadow.mjs
// ADMaps Tools — «Tile shadow and colour».
// A drop shadow cast by the tile's own picture, set like Photoshop's: offset (how far it falls; flag `size`), blur,
// direction — its own, or the scene's sun (☀: one angle for every tile that follows it, set in the scene config,
// lighting tab). Length draws it out along the light: the silhouette swept from the offset on, one long shadow from
// the prop like at sunset (the walls of a house, a barrel standing up), not a shifted copy.
// A contact shadow under it: a tight dark rim right along the outline, no offset (where the prop meets the ground).
// Gradient masks go with it: which part of the tile casts the shadow («Shadow» bar — e.g. only the tall right half,
// growing from the left) and which parts of the tile dissolve into the map («Edge» bars, up to four, added with «+» —
// props blend in). The edges fade the shadow too. «Shading» darkens the tile's own picture past a line at an angle —
// a shadow lying over the prop (a house drawn on the map shades the barrel next to it). Colour: brightness, contrast,
// saturation, warmth — props from other packs matched to the map. «Rotate with tile»: the directions are the
// picture's own (they turn and mirror with the tile — props with lighting drawn in); without it they are the scene's.
//
// How. A PIXI filter on the tile mesh. A still tile's shadow is drawn ONCE into a texture in the picture's own frame
// (scene px, soft ones at half resolution) and laid under the tile in the same single pass that draws the tile with
// its colour, edges and shading — redrawn only when the shadow, the picture or the tile's size / rotation changes
// (not on a move, a pan or a zoom). A video or scrolling tile changes every frame, so its shadow is live: the tile
// drawn into a texture, its alpha shifted and darkened, blurred, the tile on top (≈ 10 passes a frame).
// Being part of the mesh, the shadow follows the tile: position, opacity, Levels hiding a floor (the live one also
// the roof fade and the frames). Screen-space numbers: offset, length and blur are scene px × zoom (refitted on pan / zoom),
// a direction is in degrees like the tile scroll (0° — to the right, 90° — down).
// A mask is a ramp across the picture: 0 before «from», 1 after «to» (% of the picture's length along the mask's
// direction); several edges multiply. Directions and ramps are worked out every frame from the mesh's corners.
// Settings: a spoiler in the tile config next to «Tile scroll». The config previews changes on the tile itself (core
// merges the form into the document and refreshes the tile); the sliders, dials and bars push that preview while
// being dragged (core's own sliders only on release).

import { SPOILER_CSS, changed, deg, dialHtml, setDial, spoilerOpen, wireControls, wireSpoiler } from "./ui-controls.mjs";

const MODULE_ID = "adm-levels";
const FLAG = "tileShadow";   // flags.adm-levels.tileShadow.{enabled, follow, sun, size, len, blur, angle, contact*, mask*, fade*, shade*, colour}
const SUN_FLAG = "sun";      // scene: flags.adm-levels.sun — the sun's direction, degrees
const SUN_DEFAULT = 45;
const STRENGTH = 0.6;        // shadow opacity (black)
const CACHE_MAX = 1024;      // the cached shadow's longest side, px
const SWEEP_MAX = 64;        // samples along a long shadow at most (a step ≈ 1.5 px up to ~95 px, longer — wider steps)
const SWEEP_STEP = 1.5;
const FADES = ["fade", "fade2", "fade3", "fade4"];   // edge slots: {slot}Angle / {slot}From / {slot}To; 0 / 0 — unused
const COLOR = ["bright", "contrast", "satur", "warm"];   // −100…100, 0 — as is
const DEFAULTS = { size: 20, len: 0, blur: 10, angle: 45, contactWidth: 0, contactStrength: 85, maskAngle: 0, maskFrom: 0, maskTo: 0,
  shadeAngle: 0, shadeFrom: 0, shadeTo: 0, shadeStrength: 0 };
for (const s of FADES) Object.assign(DEFAULTS, { [`${s}Angle`]: 0, [`${s}From`]: 0, [`${s}To`]: 0 });
for (const k of COLOR) DEFAULTS[k] = 0;
const OPEN_KEY = `${MODULE_ID}.tileShadow.open`;   // localStorage: the spoiler was left open

const _num = (v, d) => (Number.isFinite(Number(v)) && v !== "" && v !== null ? Number(v) : d);
const _pct = (v) => Math.min(100, Math.max(0, Math.round(Number(v) || 0)));
const _sym = (v) => Math.min(100, Math.max(-100, Math.round(Number(v) || 0)));

let _sunPreview = null;   // the sun turned in an open scene config, not saved yet
function _sun(scene) {
  if (_sunPreview != null && scene === canvas?.scene) return _sunPreview;
  return _num(scene?.flags?.[MODULE_ID]?.[SUN_FLAG], SUN_DEFAULT);
}

function _cfg(tileDoc) {
  const f = tileDoc?.flags?.[MODULE_ID]?.[FLAG] ?? {};
  const n = (k) => _num(f[k], DEFAULTS[k]);
  const sun = !!f.sun;
  const c = {
    enabled: !!f.enabled,
    follow: !!f.follow,
    sun,
    size: Math.max(0, n("size")),
    len: Math.max(0, n("len")),
    blur: Math.max(0, n("blur")),
    angle: sun ? _sun(tileDoc?.parent) : n("angle"),
    contactWidth: Math.max(0, n("contactWidth")), contactStrength: _pct(n("contactStrength")),
    maskAngle: n("maskAngle"), maskFrom: _pct(n("maskFrom")), maskTo: _pct(n("maskTo")),
    fades: FADES.map((s) => ({ angle: n(`${s}Angle`), from: _pct(n(`${s}From`)), to: _pct(n(`${s}To`)) })),
    shadeAngle: n("shadeAngle"), shadeFrom: _pct(n("shadeFrom")), shadeTo: _pct(n("shadeTo")), shadeStrength: _pct(n("shadeStrength")),
  };
  for (const k of COLOR) c[k] = _sym(n(k));
  return c;
}

// ─────────────────────────────────────────────────────────────────────────────
// Filter
// ─────────────────────────────────────────────────────────────────────────────

/** The picture's frame under a transform (the mesh's world one by default): unit axes along its width (u) and height
 *  (v), its size along them and its centre — from the transform, anchor and texture frame (turns and mirrors). */
function _axes(mesh, m = mesh?.worldTransform) {
  const orig = mesh?.texture?.orig, an = mesh?.anchor;
  if (!m || !orig || !an) return null;
  const { a, b, c, d, tx, ty } = m;
  const su = Math.hypot(a, b), sv = Math.hypot(c, d);
  const W = su * orig.width, H = sv * orig.height;
  if (W < 1e-6 || H < 1e-6) return null;
  const lx = (0.5 - an.x) * orig.width, ly = (0.5 - an.y) * orig.height;
  return { ux: a / su, uy: b / su, vx: c / sv, vy: d / sv, W, H, cx: a * lx + c * ly + tx, cy: b * lx + d * ly + ty };
}

/** Mask ramp uniforms (at vec3 slot i): t = dot(p, g.xy) + g.z runs 0…1 across the picture along the world
 *  direction e (p — a point in the filter's world frame); ft = (from, to, on). 0 / 0 — no mask. */
function _setRamp(ax, e, from, to, g, ft, i = 0) {
  const o = i * 3;
  ft[o + 2] = 0;
  if (!(from || to) || !ax) return;
  const n = Math.abs(e[0] * ax.ux + e[1] * ax.uy) * ax.W + Math.abs(e[0] * ax.vx + e[1] * ax.vy) * ax.H;   // its length along e
  if (n < 1e-6) return;
  g[o] = e[0] / n; g[o + 1] = e[1] / n; g[o + 2] = 0.5 - (g[o] * ax.cx + g[o + 1] * ax.cy);
  ft[o] = from / 100; ft[o + 1] = to / 100; ft[o + 2] = 1;
}

let _ShadowFilter = null;
function _shadowFilterClass() {
  if (_ShadowFilter) return _ShadowFilter;

  // ⚠️ highp on the filter globals: the stock filter vertex shader declares them highp, and a precision mismatch
  // between the stages fails the program link.
  const RAMP = `
    uniform highp vec3 uFadeG[${FADES.length}];
    uniform vec3 uFadeFT[${FADES.length}];
    float admRamp(highp vec3 g, vec3 ft, highp vec2 p) {
      if (ft.z < 0.5) return 1.0;
      highp float t = dot(p, g.xy) + g.z;
      float d = ft.y - ft.x;
      float m = abs(d) < 0.0001 ? step(ft.x, t) : clamp((t - ft.x) / d, 0.0, 1.0);
      return m * m * (3.0 - 2.0 * m);
    }
    float admEdges(highp vec2 p) {
      float m = 1.0;
      for (int i = 0; i < ${FADES.length}; i++) m *= admRamp(uFadeG[i], uFadeFT[i], p);
      return m;
    }`;

  // Silhouette pass: the input's alpha taken from `uOffset` screen points back, black, times the masks at the
  // point that casts it; a long shadow takes the most of it along the sweep — `uSweep` further on, `uSweepN` samples
  // (1 — none). inputSize.zw turns points into texture coordinates; inputClamp keeps the pooled texture's spare area
  // out; outputFrame + coord × inputSize.xy is the point in the world frame.
  const FRAG = `
    varying vec2 vTextureCoord;
    uniform sampler2D uSampler;
    uniform highp vec4 inputSize;
    uniform highp vec4 inputClamp;
    uniform highp vec4 outputFrame;
    uniform vec2 uOffset;
    uniform vec2 uSweep;
    uniform float uSweepN;
    uniform float uStrength;
    uniform highp vec3 uMaskG;
    uniform vec3 uMaskFT;
    ${RAMP}
    void main(void) {
      float a = 0.0;
      for (int i = 0; i < ${SWEEP_MAX}; i++) {
        if (float(i) >= uSweepN) break;
        vec2 c = vTextureCoord - (uOffset + uSweep * (float(i) / max(uSweepN - 1.0, 1.0))) * inputSize.zw;
        if (c.x >= inputClamp.x && c.y >= inputClamp.y && c.x <= inputClamp.z && c.y <= inputClamp.w) {
          highp vec2 p = outputFrame.xy + c * inputSize.xy;
          a = max(a, texture2D(uSampler, c).a * admRamp(uMaskG, uMaskFT, p) * admEdges(p));
        }
      }
      gl_FragColor = vec4(0.0, 0.0, 0.0, a * uStrength);
    }`;

  // Tile pass: the tile itself — colour (uColor: brightness ×, contrast ×, saturation ×, warmth −1…1, on the
  // un-premultiplied colour), its dissolving edges (all four channels), the shading ramp (uShadeFT.w — the strength,
  // 0 = off; the ramp 0 / 0 — the whole tile, like the masks) — and, for a still tile, its cached shadow laid under
  // it (uCacheU / uCacheV map the world point into the cache; uCacheOn — its strength now: the tile's alpha).
  const FRAG_TILE = `
    varying vec2 vTextureCoord;
    uniform sampler2D uSampler;
    uniform sampler2D uCache;
    uniform highp vec4 inputSize;
    uniform highp vec4 outputFrame;
    uniform highp vec3 uShadeG;
    uniform vec4 uShadeFT;
    uniform vec4 uColor;
    uniform float uColorOn;
    uniform highp vec3 uCacheU;
    uniform highp vec3 uCacheV;
    uniform float uCacheOn;
    ${RAMP}
    void main(void) {
      highp vec2 p = outputFrame.xy + vTextureCoord * inputSize.xy;
      vec4 c = texture2D(uSampler, vTextureCoord);
      if (uColorOn > 0.5 && c.a > 0.0) {
        vec3 rgb = c.rgb / c.a * uColor.x;
        rgb = (rgb - 0.5) * uColor.y + 0.5;
        rgb = mix(vec3(dot(rgb, vec3(0.2126, 0.7152, 0.0722))), rgb, uColor.z);
        rgb *= vec3(1.0 + 0.15 * uColor.w, 1.0 + 0.03 * uColor.w, 1.0 - 0.15 * uColor.w);
        c.rgb = clamp(rgb, 0.0, 1.0) * c.a;
      }
      c *= admEdges(p);
      if (uShadeFT.w > 0.0) c.rgb *= 1.0 - uShadeFT.w * admRamp(uShadeG, uShadeFT.xyz, p);
      if (uCacheOn > 0.0) {
        highp vec2 q = vec2(dot(p, uCacheU.xy) + uCacheU.z, dot(p, uCacheV.xy) + uCacheV.z);
        float s = 0.0;
        if (q.x > 0.0 && q.y > 0.0 && q.x < 1.0 && q.y < 1.0) s = texture2D(uCache, q).a * uCacheOn;
        c += vec4(0.0, 0.0, 0.0, s) * (1.0 - c.a);
      }
      gl_FragColor = c;
    }`;

  class AdmTileShadowFilter extends PIXI.Filter {
    constructor() {
      super(undefined, FRAG, {
        uOffset: new Float32Array(2), uSweep: new Float32Array(2), uSweepN: 1, uStrength: STRENGTH,
        uMaskG: new Float32Array(3), uMaskFT: new Float32Array(3),
        uFadeG: new Float32Array(3 * FADES.length), uFadeFT: new Float32Array(3 * FADES.length),
      });
      this.admIsShadow = true;
      this.mesh = null;       // the tile mesh the directions and masks are measured on
      this.hasShadow = true;
      this.cache = null;      // { rt, pad, W, H, Wc, Hc } — the still tile's shadow, drawn once
      this.cacheKey = null;
      this.bakeAxes = null;   // set while baking: the picture's frame in the scene (scene directions turn into it)
      this._dist = 0;
      this._len = 0;
      this._blur = new PIXI.BlurFilter(0, 4);
      this._blurC = new PIXI.BlurFilter(0, 4);   // the contact rim's
      this._castOn = false;
      this._contactOn = false;
      this._contactStrength = 0;
      this._tile = new PIXI.Filter(undefined, FRAG_TILE, {
        uFadeG: this.uniforms.uFadeG, uFadeFT: this.uniforms.uFadeFT, uShadeG: new Float32Array(3), uShadeFT: new Float32Array(4),
        uColor: new Float32Array([1, 1, 1, 0]), uColorOn: 0,
        uCache: PIXI.Texture.EMPTY, uCacheU: new Float32Array(3), uCacheV: new Float32Array(3), uCacheOn: 0,
      });
      this.cfg = { ...DEFAULTS };
    }

    /** Screen-space numbers for the zoom: offset, length, blurs and the padding the shadows need around the tile. */
    fit(zoom) {
      const z = Number(zoom) || 1;
      this._dist = (Number(this.cfg.size) || 0) * z;
      this._len = (Number(this.cfg.len) || 0) * z;
      const b = (Number(this.cfg.blur) || 0) * z;
      this._blur.blur = b;
      this._castOn = (this._dist > 0.01) || (this._len > 0.01) || (b > 0.01);   // offset, length and blur 0 — no cast shadow
      const cw = (Number(this.cfg.contactWidth) || 0) * z;
      this._blurC.blur = cw;
      this._contactStrength = (Number(this.cfg.contactStrength) || 0) / 100;
      this._contactOn = cw > 0.01 && this._contactStrength > 0;
      this.hasShadow = this._castOn || this._contactOn;     // none — only the tile pass
      this.padding = this.hasShadow ? Math.ceil(Math.max(this._castOn ? this._dist + this._len + b * 2 : 0, this._contactOn ? cw * 2 : 0)) + 2 : 0;
    }

    apply(filterManager, input, output, clearMode) {
      const u = this.uniforms, cfg = this.cfg, t = this._tile.uniforms, ba = this.bakeAxes;
      const ax = _axes(this.mesh);
      // A world direction for degrees: the scene's, or the picture's with «rotate with tile» (the sun is the scene's).
      // Baking draws in the picture's own frame, so there a scene direction is turned into it.
      const dir = (d, scene = !cfg.follow) => {
        const r = (Number(d) || 0) * Math.PI / 180, dx = Math.cos(r), dy = Math.sin(r);
        if (ba) return scene ? [dx * ba.ux + dy * ba.uy, dx * ba.vx + dy * ba.vy] : [dx, dy];
        return (!scene && ax) ? [dx * ax.ux + dy * ax.vx, dx * ax.uy + dy * ax.vy] : [dx, dy];
      };
      const [ox, oy] = dir(cfg.angle, cfg.sun || !cfg.follow);
      u.uOffset[0] = ox * this._dist;
      u.uOffset[1] = oy * this._dist;
      u.uSweep[0] = ox * this._len;
      u.uSweep[1] = oy * this._len;
      u.uSweepN = this._len > 0.01 ? Math.min(SWEEP_MAX, Math.ceil(this._len / SWEEP_STEP) + 1) : 1;
      _setRamp(ax, dir(cfg.maskAngle), cfg.maskFrom, cfg.maskTo, u.uMaskG, u.uMaskFT);
      for (let i = 0; i < FADES.length; i++) {
        const f = cfg.fades?.[i];
        _setRamp(ax, dir(f?.angle), f?.from, f?.to, u.uFadeG, u.uFadeFT, i);
      }
      if (ba) {   // baking: the shadow alone
        this._shadow(filterManager, input, output, clearMode);
        return;
      }
      _setRamp(ax, dir(cfg.shadeAngle), cfg.shadeFrom, cfg.shadeTo, t.uShadeG, t.uShadeFT);
      t.uShadeFT[3] = (Number(cfg.shadeStrength) || 0) / 100;
      const col = COLOR.map((k) => (Number(cfg[k]) || 0) / 100);
      t.uColorOn = col.some((v) => v) ? 1 : 0;
      t.uColor[0] = 2 ** col[0]; t.uColor[1] = 1 + col[1]; t.uColor[2] = 1 + col[2]; t.uColor[3] = col[3];
      t.uCacheOn = 0;
      const cc = this.cache;
      if (cc && ax && this.hasShadow) {
        // world point → the cache: along the picture's axes from its top-left corner, back to scene px, plus the pad.
        const ku = ax.W / cc.W, kv = ax.H / cc.H;
        const p0x = ax.cx - ax.ux * ax.W / 2 - ax.vx * ax.H / 2, p0y = ax.cy - ax.uy * ax.W / 2 - ax.vy * ax.H / 2;
        t.uCacheU[0] = ax.ux / (ku * cc.Wc); t.uCacheU[1] = ax.uy / (ku * cc.Wc);
        t.uCacheU[2] = (-(ax.ux * p0x + ax.uy * p0y) / ku + cc.pad) / cc.Wc;
        t.uCacheV[0] = ax.vx / (kv * cc.Hc); t.uCacheV[1] = ax.vy / (kv * cc.Hc);
        t.uCacheV[2] = (-(ax.vx * p0x + ax.vy * p0y) / kv + cc.pad) / cc.Hc;
        t.uCache = cc.rt;
        t.uCacheOn = this.mesh?.worldAlpha ?? 1;
        filterManager.applyFilter(this._tile, input, output, clearMode);   // one pass: the tile with its shadow under it
        return;
      }
      if (!this.hasShadow) {
        filterManager.applyFilter(this._tile, input, output, clearMode);
        return;
      }
      this._shadow(filterManager, input, output, clearMode);
      filterManager.applyFilter(this._tile, input, output, PIXI.CLEAR_MODES.BLEND);
    }

    /** The shadows straight into the output: the cast one, then the contact rim over it — the same silhouette pass
     *  with no offset, no length, no «Shadow» mask (the whole outline touches the ground; the edges still fade it),
     *  its own strength and blur. */
    _shadow(filterManager, input, output, clearMode) {
      const u = this.uniforms;
      let mode = clearMode;
      if (this._castOn) {
        this._layer(filterManager, input, output, mode, this._blur);
        mode = PIXI.CLEAR_MODES.BLEND;
      }
      if (this._contactOn) {
        const ox = u.uOffset[0], oy = u.uOffset[1], n = u.uSweepN, s = u.uStrength, m = u.uMaskFT[2];
        u.uOffset[0] = 0; u.uOffset[1] = 0; u.uSweepN = 1; u.uStrength = this._contactStrength; u.uMaskFT[2] = 0;
        this._layer(filterManager, input, output, mode, this._blurC);
        u.uOffset[0] = ox; u.uOffset[1] = oy; u.uSweepN = n; u.uStrength = s; u.uMaskFT[2] = m;
      }
    }

    /** One shadow layer: the silhouette, through its blur when there is one. */
    _layer(filterManager, input, output, clearMode, blur) {
      if (blur.blur > 0.01) {
        const sil = filterManager.getFilterTexture();
        filterManager.applyFilter(this, input, sil, PIXI.CLEAR_MODES.CLEAR);
        blur.apply(filterManager, sil, output, clearMode);
        filterManager.returnFilterTexture(sil);
      } else {
        filterManager.applyFilter(this, input, output, clearMode);
      }
    }

    dropCache() {
      try { this.cache?.rt.destroy(true); } catch (_e) {}
      this.cache = null;
      this.cacheKey = null;
    }

    destroy() {
      this.dropCache();
      try { this._blur.destroy(); } catch (_e) {}
      try { this._blurC.destroy(); } catch (_e) {}
      try { this._tile.destroy(); } catch (_e) {}
      super.destroy();
    }
  }
  _ShadowFilter = AdmTileShadowFilter;
  return _ShadowFilter;
}

const _zoom = () => Number(canvas?.stage?.scale?.x) || 1;

/** The still tile's shadow drawn once: the picture unmirrored in its own frame (scene px, half resolution for a soft
 *  shadow), padded by the shadow's reach; scene directions turned into that frame. */
function _bake(mesh, c) {
  const tex = mesh?.texture;
  mesh.transform.updateLocalTransform();
  const s = _axes(mesh, mesh.transform.localTransform);   // the picture's frame in the scene
  if (!s || !tex?.baseTexture?.valid) return null;
  const cast = c.size > 0 || c.len > 0 || c.blur > 0, contact = c.contactWidth > 0 && c.contactStrength > 0;
  const pad = Math.ceil(Math.max(cast ? c.size + c.len + 2 * c.blur : 0, contact ? 2 * c.contactWidth : 0)) + 4;
  const Wc = s.W + 2 * pad, Hc = s.H + 2 * pad;
  // Half resolution only for soft layers: a narrow contact rim comes out coarse at it (HiDPI, zoomed in).
  const soft = (!cast || c.blur >= 3) && (!contact || c.contactWidth >= 8);
  const res = Math.min(soft ? 0.5 : 1, CACHE_MAX / Math.max(Wc, Hc));
  const rt = PIXI.RenderTexture.create({ width: Math.max(1, Math.ceil(Wc * res)), height: Math.max(1, Math.ceil(Hc * res)) });
  const sprite = new PIXI.Sprite(tex);
  sprite.position.set(pad, pad);
  sprite.width = s.W; sprite.height = s.H;
  const box = new PIXI.Container();
  box.scale.set(res);
  box.addChild(sprite);
  const bake = new (_shadowFilterClass())();
  bake.bakeAxes = s;
  bake.mesh = sprite;
  bake.cfg = c;
  bake.fit(res);
  sprite.filters = [bake];
  canvas.app.renderer.render(box, { renderTexture: rt, clear: true });
  box.destroy({ children: true });   // the sprite — not the tile's texture
  bake.destroy();
  return { rt, pad, W: s.W, H: s.H, Wc: rt.width / res, Hc: rt.height / res };
}

/** A tile whose picture changes by itself every frame: a video, or one the tile scroll moves. */
const _moving = (tileObj) => !!(tileObj?.isVideo || tileObj?.document?.flags?.[MODULE_ID]?.tileScroll?.enabled);

/** Put the shadow on the tile, update it, or take it off — cheap when nothing changed (runs on every refresh). */
function _applyToTile(tileObj) {
  const mesh = tileObj?.mesh;
  if (!mesh || mesh.destroyed) return;
  const c = _cfg(tileObj.document);
  const contact = c.contactWidth > 0 && c.contactStrength > 0;
  const on = c.enabled && (c.size > 0 || c.len > 0 || c.blur > 0 || contact || c.shadeStrength > 0 || COLOR.some((k) => c[k])
    || c.fades.some((f) => f.from > 0 || f.to > 0));
  let flt = tileObj._admShadowFilter;
  const attached = !!flt && !flt.destroyed && Array.isArray(mesh.filters) && mesh.filters.includes(flt);
  const key = on ? JSON.stringify(c) : "off";
  // The cache: a still tile with a shadow; redrawn when the shadow, the picture or the size / rotation / mirroring
  // changes (the transform without the position — a move needs no new cache).
  let cacheKey = null;
  if (on && (c.size > 0 || c.len > 0 || c.blur > 0 || contact) && !_moving(tileObj)) {
    mesh.transform.updateLocalTransform();
    const { a, b, c: mc, d } = mesh.transform.localTransform, bt = mesh.texture?.baseTexture;
    cacheKey = `${key}|${[a, b, mc, d].map((v) => v.toFixed(5)).join(",")}|${bt?.uid}|${mesh.texture?.orig?.width}x${mesh.texture?.orig?.height}|${bt?.valid}`;
  }
  if (key === tileObj._admShadowKey && (attached || !on) && cacheKey === (flt?.cacheKey ?? null)) return;
  tileObj._admShadowKey = key;
  const others = (mesh.filters ?? []).filter((x) => !x?.admIsShadow);
  if (!on) {
    mesh.filters = others.length ? others : null;
    if (flt) { try { flt.destroy(); } catch (_e) {} tileObj._admShadowFilter = null; }
    return;
  }
  if (!flt || flt.destroyed) flt = tileObj._admShadowFilter = new (_shadowFilterClass())();
  flt.mesh = mesh;
  flt.cfg = c;
  flt.fit(_zoom());
  if (cacheKey !== flt.cacheKey) {
    flt.dropCache();
    if (cacheKey) {
      try { flt.cache = _bake(mesh, c); } catch (e) { console.warn("[ADM:tileShadow] cache:", e); }
      flt.cacheKey = flt.cache ? cacheKey : null;   // not baked (picture not loaded yet) — live, tried again next refresh
    }
  }
  mesh.filters = [...others, flt];   // last: the shadow is cast by whatever the other filters drew
}

/** Every tile again — the sun turned (saved or in an open scene config). */
function _applyAll() {
  for (const t of canvas?.tiles?.placeables ?? []) {
    if (t._admShadowFilter || t.document?.flags?.[MODULE_ID]?.[FLAG]?.enabled) _applyToTile(t);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UI: spoiler in the tile config
// ─────────────────────────────────────────────────────────────────────────────
// One setting a row, in titled blocks: a label, the control, a 36 px column on the right for the dials — a slider
// runs over it (.adm-ts-wide), its number at the right edge under the dials. Every label starts a row at column 1:
// auto placement would go on into Mass Edit's box column (free past a block's title row, where its box sits).
const COLS = "minmax(0, max-content) minmax(0, 1fr) 36px";
const CSS = `
  .adm-tileshadow .adm-ts-grid { display: grid; align-items: center; gap: 6px 10px; padding: 2px 8px 8px; grid-template-columns: ${COLS}; }
  .adm-tileshadow .adm-ts-grid:has(.mass-edit-checkbox) { grid-template-columns: ${COLS} max-content; }
  .adm-tileshadow .adm-sec { gap: 6px 10px; }
  .adm-tileshadow .adm-sec + .adm-sec { margin-top: 6px; }
  .adm-tileshadow .adm-ts-h { grid-column: 1 / 4; display: flex; align-items: center; gap: 8px; min-height: 20px; font-weight: bold; }
  .adm-tileshadow .adm-ts-h > .adm-ts-line { flex: 1; border-top: 1px solid var(--color-border-light-tertiary, #7a7971); opacity: 0.6; }
  .adm-tileshadow .adm-sec > label:not(.adm-ts-sun), .adm-tileshadow .adm-ts-lbl { grid-column: 1; }
  .adm-tileshadow .adm-ts-wide { grid-column: 2 / 4; }
  .adm-tileshadow .adm-sec > label, .adm-tileshadow .adm-ts-lbl > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .adm-tileshadow .adm-ts-lbl { display: flex; align-items: center; gap: 4px; min-width: 0; }
  .adm-tileshadow :is(.adm-ts-lbl, .adm-ts-h) > button { flex: none; width: 18px; height: 18px; min-height: 0; padding: 0; margin: 0; border-radius: 50%;
    display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: normal; line-height: 1; cursor: pointer; }
  .adm-tileshadow .adm-ts-h > button { margin-right: 9px; }
  .adm-tileshadow .adm-ts-row { display: contents; }
  .adm-tileshadow .adm-ts-row[hidden], .adm-tileshadow button[hidden] { display: none; }
  .adm-tileshadow .adm-sec > .adm-ts-sun { justify-self: start; display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
  .adm-tileshadow .adm-sec > .adm-ts-sun > input { margin: 0; }
  .adm-tileshadow .adm-dial.adm-ts-locked { pointer-events: none; opacity: 0.6; }
  .adm-tileshadow .adm-ts-bar { position: relative; height: 14px; box-sizing: border-box; border-radius: 3px; cursor: pointer;
    touch-action: none; border: 1px solid var(--color-border-light-tertiary, #7a7971);
    background: repeating-conic-gradient(#8a8a8a 0 25%, #b8b8b8 0 50%) 0 0 / 8px 8px; }
  .adm-tileshadow .adm-ts-bar::before { content: ""; position: absolute; inset: 0; border-radius: inherit;
    background: linear-gradient(90deg, transparent var(--f), var(--c) var(--t)); }
  .adm-tileshadow .adm-ts-mask { --c: #000; }
  .adm-tileshadow .adm-ts-fade { --c: #eee6d4; }
  .adm-tileshadow .adm-ts-bar > i { position: absolute; top: -4px; bottom: -4px; width: 6px; margin-left: -3px; box-sizing: border-box;
    border-radius: 2px; background: #fff; border: 1px solid #000; cursor: ew-resize; }
  .adm-tileshadow .adm-ts-bar > i[data-h=From] { left: var(--f); }
  .adm-tileshadow .adm-ts-bar > i[data-h=To] { left: var(--t); }`;

/** Ramp bar: two handles, from ≤ to (% of the picture). A press on the bar takes the nearer handle there; on a pair
 *  of handles at one spot the first move decides which; a double click clears the mask (0 / 0). */
function _wireBar(el) {
  const inp = { From: el.querySelector('input[name$="From"]'), To: el.querySelector('input[name$="To"]') };
  const val = (h) => Number(inp[h].value) || 0;
  const put = (h, v) => {
    inp[h].value = String(v);
    el.style.setProperty(h === "From" ? "--f" : "--t", `${v}%`);
    changed(inp[h]);
  };
  const set = (h, v) => {
    v = _pct(v);
    v = (h === "From") ? Math.min(v, val("To")) : Math.max(v, val("From"));
    if (v !== val(h)) put(h, v);
  };
  const pct = (ev) => { const r = el.getBoundingClientRect(); return (ev.clientX - r.left) / Math.max(1, r.width) * 100; };
  const pick = (p) => {
    const f = val("From"), t = val("To");
    if (Math.abs(f - t) < 0.5) return (p < f - 1) ? "From" : (p > t + 1 ? "To" : null);
    return (Math.abs(p - f) <= Math.abs(p - t)) ? "From" : "To";
  };
  let drag = false, active = null;
  el.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    drag = true;
    try { el.setPointerCapture(ev.pointerId); } catch (_e) {}
    const p = pct(ev);
    active = pick(p);
    if (active && !ev.target.dataset?.h) set(active, p);   // on the bar: the nearer handle jumps here
  });
  el.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const p = pct(ev);
    active ??= pick(p);
    if (active) set(active, p);
  });
  for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) el.addEventListener(t, () => { drag = false; active = null; });
  el.addEventListener("dblclick", () => el.admClear());
  el.admClear = () => { if (val("From")) put("From", 0); if (val("To")) put("To", 0); };
}

/** Extra edges: «+» (in the «Edges» title) shows the next unused slot as a row of its own, turned to a side no shown
 *  edge takes yet; «×» clears its slot and hides it. Unused slots stay in the form as 0 / 0, so a removed edge is
 *  saved as removed. */
function _wireEdges(box, app) {
  const add = box.querySelector(".adm-ts-add");
  const rows = [...box.querySelectorAll(".adm-ts-row")];
  const sync = () => { add.hidden = rows.every((r) => !r.hidden); };
  add?.addEventListener("click", () => {
    const row = rows.find((r) => r.hidden);
    if (!row) return;
    const used = [...box.querySelectorAll(".adm-dial[data-edge] input")].filter((i) => !i.closest("[hidden]")).map((i) => Number(i.value));
    const side = [0, 90, 180, 270].find((a) => used.every((u) => Math.abs(((u - a + 540) % 360) - 180) > 45)) ?? 0;
    setDial(row.querySelector(".adm-dial"), side);
    row.hidden = false;
    sync();
    try { app.setPosition({ height: "auto" }); } catch (_e) {}
  });
  for (const row of rows) {
    row.querySelector(".adm-ts-del")?.addEventListener("click", () => {
      row.querySelector(".adm-ts-bar")?.admClear?.();
      row.hidden = true;
      sync();
      try { app.setPosition({ height: "auto" }); } catch (_e) {}
    });
  }
  if (add) sync();
}

/** A direction rewritten between the scene's frame and the picture's (the tile's current rotation and mirroring). */
function _turn(el, ax, toTile) {
  const r = (Number(el.querySelector("input").value) || 0) * Math.PI / 180, dx = Math.cos(r), dy = Math.sin(r);
  const [x, y] = toTile
    ? [dx * ax.ux + dy * ax.uy, dx * ax.vx + dy * ax.vy]    // scene → picture: e·u, e·v
    : [dx * ax.ux + dy * ax.vx, dx * ax.uy + dy * ax.vy];   // picture → scene: dx·u + dy·v
  setDial(el, Math.atan2(y, x) * 180 / Math.PI);
}

/** Ticking «rotate with tile» keeps the picture as it is: the directions are rewritten into the new frame (the sun's
 *  dial stays — the sun is the scene's). Runs before the form reads the change. */
function _reframe(box, mesh, toTile) {
  const ax = _axes(mesh);
  if (!ax) return;
  for (const el of box.querySelectorAll(".adm-dial:not(.adm-ts-locked)")) _turn(el, ax, toTile);
}

/** ☀: the shadow's dial shows the scene's sun and rests; released, it keeps that direction (in the picture's frame
 *  with «rotate with tile»), so nothing jumps either way. */
function _wireSun(box, app) {
  const sun = box.querySelector(`[name="flags.${MODULE_ID}.${FLAG}.sun"]`);
  const dial = box.querySelector(`.adm-dial input[name="flags.${MODULE_ID}.${FLAG}.angle"]`)?.closest(".adm-dial");
  const follow = box.querySelector(`[name="flags.${MODULE_ID}.${FLAG}.follow"]`);
  if (!sun || !dial) return;
  sun.addEventListener("change", () => {   // before the form reads the change
    if (sun.checked) setDial(dial, _sun(app.document?.parent ?? canvas?.scene));
    else if (follow?.checked) { const ax = _axes(app.document?.object?.mesh); if (ax) _turn(dial, ax, true); }
    dial.classList.toggle("adm-ts-locked", sun.checked);
  });
}

function _wire(box, app) {
  wireSpoiler(box, OPEN_KEY);
  const follow = box.querySelector(`[name="flags.${MODULE_ID}.${FLAG}.follow"]`);
  follow?.addEventListener("change", () => _reframe(box, app.document?.object?.mesh, follow.checked));
  for (const el of box.querySelectorAll(".adm-ts-bar")) _wireBar(el);
  _wireEdges(box, app);
  _wireSun(box, app);
}

function _injectConfig(app, html) {
  const root = html instanceof HTMLElement ? html : (html?.[0] ?? html);
  if (!root?.querySelector) return;
  if (root.querySelector(`[name="flags.${MODULE_ID}.${FLAG}.enabled"]`)) return;   // already injected
  const c = _cfg(app.document);
  const L = (k) => game.i18n.localize(`ADM_LEVELS.tileShadow.${k}`);
  const nm = (k) => `flags.${MODULE_ID}.${FLAG}.${k}`;
  const picker = (k, min, max, cls = "adm-ts-wide") => `<range-picker class="${cls}" name="${nm(k)}" value="${c[k]}" min="${min}" max="${max}" step="1"></range-picker>`;
  const dial = (k, v, attrs = "") => dialHtml(nm(k), v, L("angle"), attrs);
  const bar = (k, kind, from, to) => `<div class="adm-ts-bar adm-ts-${kind}" style="--f:${from}%;--t:${to}%">
      <i data-h="From"></i><i data-h="To"></i>
      <input type="hidden" name="${nm(`${k}From`)}" value="${from}" data-dtype="Number">
      <input type="hidden" name="${nm(`${k}To`)}" value="${to}" data-dtype="Number"></div>`;
  const edgeLabel = (del) => `<span class="adm-ts-lbl"><span>${L("fade")}</span>${del ? '<button type="button" class="adm-ts-del">×</button>' : ""}</span>`;
  const [f0, ...more] = c.fades;
  const extra = more.map((f, i) => {
    const s = FADES[i + 1];
    return `<div class="adm-ts-row"${(f.from || f.to) ? "" : " hidden"}>${edgeLabel(true)}${bar(s, "fade", f.from, f.to)}${dial(`${s}Angle`, f.angle, " data-edge")}</div>`;
  }).join("");
  const row = (k, ctl) => `<label>${L(k)}</label>${ctl}`;
  const head = (k, more = "") => `<div class="adm-ts-h"><span>${L(k)}</span><span class="adm-ts-line"></span>${more}</div>`;
  // ☀ beside the shadow's dial: the sun sets that direction.
  const sun = `<label class="adm-ts-sun"><input type="checkbox" name="${nm("sun")}"${c.sun ? " checked" : ""}>${L("sun")}</label>`;
  // A titled block each, a Mass Edit group each (its box on the title row): shadow / contact shadow / shading /
  // colour / edges — the edges last: «+» grows that block.
  const sec = (html) => `<div class="form-group adm-sec">${html}</div>`;
  const injectHtml = `
  <details class="adm-spoiler adm-tileshadow"${spoilerOpen(OPEN_KEY) ? " open" : ""}>
    <summary class="form-group"><input type="checkbox" name="${nm("enabled")}" aria-label="${L("enabled")}"${c.enabled ? " checked" : ""}>${L("title")}<label
      class="adm-sp-right"><input type="checkbox" name="${nm("follow")}"${c.follow ? " checked" : ""}>${L("follow")}</label></summary>
    <style>${SPOILER_CSS}${CSS}</style>
    <div class="adm-ts-grid">
      ${sec(`${head("secShadow")}
        <label>${L("angle")}</label>${sun}${dial("angle", c.angle)}
        ${row("size", picker("size", 0, 200))}${row("len", picker("len", 0, 500))}${row("blur", picker("blur", 0, 100))}
        <label>${L("mask")}</label>${bar("mask", "mask", c.maskFrom, c.maskTo)}${dial("maskAngle", c.maskAngle)}`)}
      ${sec(`${head("contact")}${row("width", picker("contactWidth", 0, 30))}${row("strength", picker("contactStrength", 0, 100))}`)}
      ${sec(`${head("shade")}
        <label>${L("ramp")}</label>${bar("shade", "mask", c.shadeFrom, c.shadeTo)}${dial("shadeAngle", c.shadeAngle)}
        ${row("strength", picker("shadeStrength", 0, 100))}`)}
      ${sec(`${head("secColor")}${row("bright", picker("bright", -100, 100))}${row("contrast", picker("contrast", -100, 100))}
        ${row("satur", picker("satur", -100, 100))}${row("warm", picker("warm", -100, 100))}`)}
      ${sec(`${head("secEdges", '<button type="button" class="adm-ts-add">+</button>')}
        ${edgeLabel(false)}${bar(FADES[0], "fade", f0.from, f0.to)}${dial(`${FADES[0]}Angle`, f0.angle, " data-edge")}${extra}`)}
    </div>
  </details>`;
  const anchor = root.querySelector("details.adm-tilescroll")
    ?? root.querySelector('[name="texture.tint"]')?.closest(".form-group")
    ?? root.querySelector(".form-group");
  if (anchor) anchor.insertAdjacentHTML("afterend", injectHtml);
  else root.insertAdjacentHTML("beforeend", injectHtml);
  const box = root.querySelector("details.adm-tileshadow");
  if (!box) return;
  if (c.sun) box.querySelector(`.adm-dial input[name="${nm("angle")}"]`)?.closest(".adm-dial")?.classList.add("adm-ts-locked");
  _wire(box, app);
  try { app.setPosition({ height: "auto" }); } catch (_e) {}
}

/** The scene config, lighting tab: the sun every ☀ tile's shadow follows; the map shows it while turning. */
function _injectSceneConfig(app, html) {
  const root = html instanceof HTMLElement ? html : (html?.[0] ?? html);
  const tab = root?.querySelector?.('.tab[data-tab="lighting"]');
  if (!tab || tab.querySelector("[data-adm-sun]")) return;
  const scene = app.document;
  const L = (k) => game.i18n.localize(`ADM_LEVELS.tileShadow.${k}`);
  tab.insertAdjacentHTML("beforeend", `
    <div class="form-group adm-controls" data-adm-sun>
      <style>${SPOILER_CSS}</style>
      <label>${L("sunScene")}</label>
      <div class="form-fields">${dialHtml(`flags.${MODULE_ID}.${SUN_FLAG}`, _num(scene?.flags?.[MODULE_ID]?.[SUN_FLAG], SUN_DEFAULT), L("angle"))}</div>
    </div>`);
  const group = tab.querySelector("[data-adm-sun]");
  wireControls(group);
  const input = group.querySelector("input");
  const preview = () => {
    if (scene !== canvas?.scene) return;
    _sunPreview = deg(input.value);
    _applyAll();
  };
  input.addEventListener("change", preview);
  input.addEventListener("input", () => { if (input.value !== "") preview(); });
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMaps Tools sub-module descriptor
// ─────────────────────────────────────────────────────────────────────────────
export const TOOL = {
  id: "tileShadow",
  name: "ADM_LEVELS.settings.tileShadow.name",
  hint: "ADM_LEVELS.settings.tileShadow.hint",

  onReady({ isEnabled }) {
    Hooks.on("renderTileConfig", (app, html) => {
      if (!isEnabled()) return;
      try { _injectConfig(app, html); } catch (e) { console.warn("[ADM:tileShadow] config:", e); }
    });
    const apply = (tileObj) => {
      // Refresh runs often: a tile with no shadow and no filter left on it costs one flag read, not a setting read.
      if (!tileObj?._admShadowFilter && !tileObj?.document?.flags?.[MODULE_ID]?.[FLAG]?.enabled) return;
      if (!isEnabled()) return;
      try { _applyToTile(tileObj); } catch (e) { console.warn("[ADM:tileShadow] apply:", e); }
    };
    Hooks.on("drawTile", apply);
    Hooks.on("refreshTile", apply);   // also the config's live preview (core merges the form and refreshes)
    Hooks.on("updateTile", (tileDoc) => apply(tileDoc.object));
    Hooks.on("destroyTile", (tileObj) => {
      const flt = tileObj?._admShadowFilter;
      if (flt && !flt.destroyed) { try { flt.destroy(); } catch (_e) {} }
      if (tileObj) tileObj._admShadowFilter = null;
    });
    // Zoom changes the screen-space distance, blur and padding.
    Hooks.on("canvasPan", () => {
      const z = _zoom();
      for (const t of canvas?.tiles?.placeables ?? []) {
        const flt = t._admShadowFilter;
        if (flt && !flt.destroyed) flt.fit(z);
      }
    });
    // The sun: the scene config (lighting tab), its preview while turning, the saved value.
    Hooks.on("renderSceneConfig", (app, html) => {
      if (!isEnabled()) return;
      try { _injectSceneConfig(app, html); } catch (e) { console.warn("[ADM:tileShadow] scene config:", e); }
    });
    Hooks.on("closeSceneConfig", () => {
      if (_sunPreview == null) return;
      _sunPreview = null;
      if (isEnabled()) _applyAll();
    });
    Hooks.on("updateScene", (scene, changed) => {
      if (scene !== canvas?.scene || !isEnabled()) return;
      if (foundry.utils.hasProperty(changed ?? {}, `flags.${MODULE_ID}.${SUN_FLAG}`)) { _sunPreview = null; _applyAll(); }
    });
  },
};
