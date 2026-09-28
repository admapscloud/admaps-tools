// scripts/tools/shared-video.mjs
// ADMaps Tools sub-module: «Shared video for identical tiles».
//
// WHY. Animated tiles are webm, often VP9 with alpha, which Chromium decodes on the CPU — two decoders per copy (colour
// and alpha). Core gives every video tile its own clone of the video (Tile#_draw → game.video.cloneTexture), so the
// load grows with every copy of the same prop. Here tiles showing the same file draw ONE shared video: one decode for
// all copies, which then move in sync, frame for frame (28.09.2026, the user: «that is fine»).
//
// HOW (checked against the core code of 13.351 and 14.361, PIXI 7.4.3 in both):
// • Tile#_draw asks game.video.cloneTexture(video) for its own clone of the cached video. That method is wrapped: when
//   the video belongs to tiles of the current scene, the tile gets a texture over a SHARED PIXI.VideoResource instead —
//   its own BaseTexture (tile-scroll sets REPEAT on it, a shared base would leak that to the other copies), the same
//   <video> underneath. The upload to the GPU stays per tile; the decode is once.
//   cloneTexture receives nothing but the cached <video>: no tile, and no path either — PIXI.Assets loads a video
//   through a blob: URL. The file is found by identity: the cached texture of each video src of the scene's tiles
//   (TextureLoader cache) is compared with the element. Not shared: files that tokens use too (tokens clone through the
//   same method — they are left alone), and files of tiles with our own video controller (videoSkip / videoPool swap
//   the clip and hide the tile — on their own video).
// • The shared resource is `internal = false`: core destroys the tile's base texture on clear/_destroy, and PIXI's
//   BaseTexture#destroy destroys the resource only when it is internal. The base's "destroyed" event (emitted exactly
//   once, after it has unbound itself) releases the reference; the last one out destroys the resource —
//   VideoResource#dispose pauses the video, empties its src and reloads it, which frees the decoder. Leftovers (a tile
//   destroyed while its texture was still loading) are cleaned on the next canvasInit.
// • Seeks. Right after cloneTexture core sets a RANDOM start (flags.core.randomizeVideo) — on the shared video every new
//   copy would throw all the copies to another frame; and every tile refresh calls VideoHelper#play without an offset,
//   which sets currentTime to itself — a seek to the same spot, a stutter for everybody. The shared <video> gets its own
//   currentTime accessor: the random start of a copy just handed out is swallowed (armed until the task ends — core
//   sets it in the very continuation of the await), a seek to (almost) the current time is skipped, real seeks (the
//   HUD's offset) go through. Nothing is written to the documents: no flags in the scenes and the exported maps.
// • Pause, play, loop and volume of one copy act on all of them — expected.
// • Toggling the checkbox needs a reload: the tiles already drawn keep their textures.
// Diagnostics from the console: __admSharedVideo.diag() — the shared videos alive, their copies and state.

const MODULE_ID = "adm-levels";
const SEEK_EPS = 0.05; // s — a seek this close to the current time changes nothing (VideoHelper#play without an offset)

/** tile src → {key, refs, ready: Promise<PIXI.VideoResource>, resource, el, swallow, disarm, dead} */
const _shared = new Map();
/** The current scene's tile srcs (src → {excluded}) and token srcs; rebuilt lazily after a relevant change. */
let _index = null;

/** HTMLMediaElement's own accessor — the shared <video> shadows it with one of its own (_guardSeeks). */
const _CT = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime");

const _VH = () => foundry?.helpers?.media?.VideoHelper ?? globalThis.VideoHelper;
const _TL = () => foundry?.canvas?.TextureLoader ?? globalThis.TextureLoader;

function _buildIndex() {
  const scene = canvas?.scene;
  const tiles = new Map();
  const tokens = new Set();
  if (scene) {
    for (const t of scene.tiles ?? []) {
      const src = t.texture?.src;
      if (!src) continue;
      const f = t.flags?.[MODULE_ID];
      const own = !!(f?.videoSkip || f?.videoPool); // our video controller swaps and hides the tile's own video
      tiles.set(src, { excluded: !!tiles.get(src)?.excluded || own });
    }
    for (const t of scene.tokens ?? []) if (t.texture?.src) tokens.add(t.texture.src);
  }
  return { sceneId: scene?.id ?? null, tiles, tokens };
}

/** The tile src whose cached video is `source`, if its tiles may share it; otherwise null (core clones as usual). */
function _shareKey(source) {
  if (!canvas?.scene || !source) return null;
  if (!_index || (_index.sceneId !== canvas.scene.id)) _index = _buildIndex();
  const loader = _TL()?.loader;
  const VH = _VH();
  if (!loader?.getCache || !VH?.hasVideoExtension) return null;
  for (const [src, info] of _index.tiles) {
    if (!VH.hasVideoExtension(src)) continue;
    let base = null;
    try { base = loader.getCache(src); } catch (_e) { base = null; }
    if (base?.resource?.source !== source) continue;
    return (info.excluded || _index.tokens.has(src)) ? null : src;
  }
  return null;
}

/** The shared <video>'s own currentTime accessor — see the header («Seeks»). */
function _guardSeeks(el, e) {
  if (!_CT?.get || !_CT?.set) return;
  Object.defineProperty(el, "currentTime", {
    configurable: true,
    enumerable: true,
    get() { return _CT.get.call(this); },
    set(v) {
      if (e.swallow > 0) { e.swallow--; return; }
      const t = Number(v);
      if (Number.isFinite(t) && (Math.abs(t - _CT.get.call(this)) < SEEK_EPS)) return;
      _CT.set.call(this, v);
    },
  });
}

/** A copy is being handed out: core's random start follows in the same task — swallow it (see the header). */
function _armSwallow(e) {
  e.swallow++;
  if (e.disarm) return;
  e.disarm = setTimeout(() => { e.swallow = 0; e.disarm = null; }, 0);
}

function _destroy(e) {
  if (e.dead) return;
  e.dead = true;
  if (e.disarm) { clearTimeout(e.disarm); e.disarm = null; }
  try { e.resource?.destroy(); } catch (_e) { /* already gone */ } // pause, src = "", load() — the decoder goes
}

/** canvasInit: an entry still held by copies core never destroyed (a tile gone while its texture was loading). Its
 *  decoder goes now; the resource object waits for the last of those bases — PIXI's Resource#destroy nulls the runners
 *  a bound base unbinds from, and a late BaseTexture#destroy would throw. */
function _orphan(e) {
  if (e.refs <= 0) { _destroy(e); return; }
  e.orphan = true;
  if (e.disarm) { clearTimeout(e.disarm); e.disarm = null; }
  try {
    if (e.resource) {
      e.resource.autoUpdate = false;
      e.resource.dispose();
    }
  } catch (_e) { /* already gone */ }
}

function _release(e) {
  if (e.refs > 0) e.refs--;
  if (e.refs > 0) return;
  if (_shared.get(e.key) === e) _shared.delete(e.key);
  _destroy(e);
}

/** A texture of its own for one tile over the shared video of `src` (created on the first request). */
async function _acquire(src, source) {
  const alphaMode = await PIXI.utils.detectVideoAlphaMode();
  let e = _shared.get(src);
  if (!e) {
    e = { key: src, refs: 0, resource: null, el: null, swallow: 0, disarm: null, dead: false, ready: null };
    e.ready = (async () => {
      const el = source.cloneNode(true); // exactly as core's cloneTexture
      const resource = new PIXI.VideoResource(el, { autoPlay: false });
      resource.internal = false; // a tile's BaseTexture#destroy must not take the shared video down
      await resource.load();
      _guardSeeks(el, e);
      e.el = el;
      e.resource = resource;
      return resource;
    })();
    _shared.set(src, e);
  }
  e.refs++; // held from here on: nothing destroys the entry while this copy waits
  let resource;
  try {
    resource = await e.ready;
    if (e.dead || e.orphan || resource.destroyed) throw new Error("the shared video was released meanwhile");
  } catch (err) {
    _release(e);
    throw err;
  }
  const base = new PIXI.BaseTexture(resource, { alphaMode });
  base.once("destroyed", () => _release(e));
  _armSwallow(e);
  return new PIXI.Texture(base);
}

function diag() {
  const rows = [..._shared.values()].map((e) => ({
    file: String(e.key).split("/").pop(),
    copies: e.refs,
    paused: e.el ? e.el.paused : null,
    time: e.el ? Math.round(_CT.get.call(e.el) * 100) / 100 : null,
    readyState: e.el ? e.el.readyState : null,
  }));
  console.table(rows);
  return { videos: rows.length, copies: rows.reduce((s, r) => s + r.copies, 0), rows };
}

export const TOOL = {
  id: "sharedVideo",
  name: "ADM_LEVELS.settings.sharedVideo.name",
  hint: "ADM_LEVELS.settings.sharedVideo.hint",
  requiresReload: true,

  onReady({ isEnabled }) {
    globalThis.__admSharedVideo = { diag };
    if (!isEnabled() || !globalThis.libWrapper?.register) return;
    const target = foundry?.helpers?.media?.VideoHelper
      ? "foundry.helpers.media.VideoHelper.prototype.cloneTexture"
      : "VideoHelper.prototype.cloneTexture";
    try {
      libWrapper.register(MODULE_ID, target, async function (wrapped, source, ...rest) {
        let src = null;
        try { src = _shareKey(source); } catch (_e) { src = null; }
        if (!src) return wrapped(source, ...rest);
        try { return await _acquire(src, source); }
        catch (err) {
          console.warn("[adm-levels] shared video: falling back to a clone of its own", err);
          return wrapped(source, ...rest);
        }
      }, "MIXED");
    } catch (e) {
      console.warn("[adm-levels] shared video: cloneTexture wrapper failed", e);
      return;
    }

    // The scene's src index follows the tiles and tokens (texture, our video flags).
    const drop = () => { _index = null; };
    Hooks.on("createTile", drop);
    Hooks.on("deleteTile", drop);
    Hooks.on("updateTile", (_doc, changes) => { if (changes?.texture || changes?.flags) drop(); });
    Hooks.on("createToken", drop);
    Hooks.on("deleteToken", drop);
    Hooks.on("updateToken", (_doc, changes) => { if (changes?.texture) drop(); });
    // A new canvas: the old tiles are gone, whatever is still held is a leftover (see _orphan).
    Hooks.on("canvasInit", () => {
      for (const e of _shared.values()) _orphan(e);
      _shared.clear();
      drop();
    });
  },
};
