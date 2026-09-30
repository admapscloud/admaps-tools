// scripts/tools/wall-cut-regions.mjs
// ADMaps Tools sub-module: «Regions cut walls».
//
// WHY (28.09.2026, the user): wagons are tiles with walls that keep tokens on them (linked to the wagon by Mass Edit);
// bridges between wagons are tiles with walls along their sides. Where a bridge meets a wagon the wagon's wall has to
// go — and come back when the bridge is moved or removed. A region with «Cut walls» (a checkbox in the region config,
// right under the type), linked to the bridge by Mass Edit, does it: a wall whose MIDDLE lies in such a region, whose
// height overlaps the region's elevation range, and which is not linked to that region by Mass Edit, loses all its
// restrictions — as if it were not there — while any such region covers it. The wagon's walls are split into short
// pieces where a bridge attaches. The bridge's own walls share its Mass Edit link, so they are never cut, even on a
// short bridge whose end regions cover the middles of its side walls.
//
// HOW. Only the active GM writes walls. A cut wall keeps its own state in flags.adm-levels.cutOrig
// ({move, sight, light, sound, door, ds}) and gets NONE everywhere (door → none too: no door control left behind).
// No region covers it any more → restored, the flag removed. Re-evaluated (debounced) when regions or walls change and
// on canvasReady — a scene exported while a wall was cut heals itself on load; a wall re-created by a scene variation
// swap carrying cutOrig is put back in line the same way.
// A wall bound to a tile («wall follows the tile», main.mjs) belongs to the cut while cut: main.mjs skips cut walls,
// and after the restore the binding is re-applied (__admApplyWallBind).
// Height: the wall's wall-height span and the region's elevation range must overlap by more than a point — a region
// 15–30 does not cut a wall 0–15 under it; empty bounds are endless.
// A region switched off — «Disable region», or bound to a tile that is hidden (inverted: shown) — cuts nothing, so hiding
// the bridge tile gives the wagon's wall back (29.09.2026). The binding is read live, nothing is written to the region
// when the tile changes: tile shown/hidden, created or deleted re-evaluates the cut.
// Toggling the checkbox needs a reload (the hooks are set on start).

const MODULE_ID = "adm-levels";
const FLAG_CUT = "cutWalls"; // region: boolean (the checkbox — main.mjs region config)
const FLAG_ORIG = "cutOrig"; // wall: {move, sight, light, sound, door, ds} while cut
const ME = "multi-token-edit"; // Mass Edit: flags[ME].links = [{id, type}], shared id = linked

let _timer = null;
let _running = false;
let _again = false;

function _bound(v, inf) {
  if (v === null || v === undefined || v === "") return inf;
  const n = Number(v);
  return Number.isFinite(n) ? n : inf;
}

/** The wall's wall-height span and the region's elevation range overlap by more than a point. */
function _heightsOverlap(wall, region) {
  const f = wall.flags?.["wall-height"] ?? {};
  const wb = _bound(f.bottom, -Infinity);
  const wt = _bound(f.top, Infinity);
  const rb = _bound(region.elevation?.bottom, -Infinity);
  const rt = _bound(region.elevation?.top, Infinity);
  return (wb < rt) && (wt > rb);
}

/** Linked by Mass Edit: a link id they share (its Linker.areLinked). */
function _linked(a, b) {
  const la = a.flags?.[ME]?.links;
  const lb = b.flags?.[ME]?.links;
  if (!la?.length || !lb?.length) return false;
  return la.some((x) => lb.some((y) => x.id === y.id));
}

function _contains(region, x, y) {
  try { return !!region.polygonTree?.testPoint({ x, y }); } catch (_e) { return false; }
}

/** Does any cutter region cut this wall? */
function _cutBy(wall, cutters) {
  const c = wall.c;
  const mx = (c[0] + c[2]) / 2;
  const my = (c[1] + c[3]) / 2;
  return cutters.some((r) => _heightsOverlap(wall, r) && !_linked(wall, r) && _contains(r, mx, my));
}

const NONE = { move: 0, sight: 0, light: 0, sound: 0, door: 0 };

async function _sync() {
  _timer = null;
  if (_running) { _again = true; return; }
  const scene = canvas?.scene;
  if (!scene || !game.users?.activeGM?.isSelf) return;
  _running = true;
  try {
    // A region switched off — its «Disable region» box, or its bound tile hidden (inverted: shown) — cuts nothing:
    // the same rule as every other region feature (main.mjs _isRegionEffectivelyDisabled).
    const off = globalThis.__admRegionOff;
    const cutters = scene.regions.filter((r) => !!r.flags?.[MODULE_ID]?.[FLAG_CUT] && !off?.(r));
    const updates = [];
    const rebind = [];
    for (const wall of scene.walls) {
      const orig = wall.flags?.[MODULE_ID]?.[FLAG_ORIG];
      const cut = cutters.length ? _cutBy(wall, cutters) : false;
      if (cut) {
        const off = (wall.move === NONE.move) && (wall.sight === NONE.sight) && (wall.light === NONE.light)
          && (wall.sound === NONE.sound) && (Number(wall.door ?? 0) === NONE.door);
        if (orig && off) continue;
        const u = { _id: wall.id, ...NONE };
        if (!orig) {
          u[`flags.${MODULE_ID}.${FLAG_ORIG}`] = {
            move: wall.move, sight: wall.sight, light: wall.light, sound: wall.sound,
            door: Number(wall.door ?? 0), ds: Number(wall.ds ?? 0),
          };
        }
        updates.push(u);
      } else if (orig) {
        updates.push({
          _id: wall.id,
          move: orig.move ?? wall.move, sight: orig.sight ?? wall.sight,
          light: orig.light ?? wall.light, sound: orig.sound ?? wall.sound,
          door: orig.door ?? 0, ds: orig.ds ?? 0,
          [`flags.${MODULE_ID}.-=${FLAG_ORIG}`]: null,
        });
        if (wall.flags?.[MODULE_ID]?.tileBindId) rebind.push(wall.id);
      }
    }
    if (updates.length) await scene.updateEmbeddedDocuments("Wall", updates, { admLevelsWallCut: true });
    for (const id of rebind) {
      const w = scene.walls.get(id);
      if (w) { try { await globalThis.__admApplyWallBind?.(w); } catch (_e) { /* binding gone */ } }
    }
  } catch (e) {
    console.warn("[adm-levels] cut walls:", e);
  } finally {
    _running = false;
    if (_again) { _again = false; _schedule(); }
  }
}

function _schedule() {
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(_sync, 60);
}

export const TOOL = {
  id: "wallCutRegions",
  name: "ADM_LEVELS.settings.wallCutRegions.name",
  hint: "ADM_LEVELS.settings.wallCutRegions.hint",
  requiresReload: true,

  onReady({ isEnabled }) {
    if (!isEnabled()) return;
    const regionTouched = (changes) => !!(changes?.shapes || changes?.elevation || changes?.flags);
    Hooks.on("createRegion", () => _schedule());
    Hooks.on("deleteRegion", () => _schedule());
    Hooks.on("updateRegion", (_doc, changes) => { if (regionTouched(changes)) _schedule(); });
    Hooks.on("createWall", () => _schedule());
    Hooks.on("updateWall", (_doc, changes, options) => {
      if (options?.admLevelsWallCut) return; // our own write
      if (("c" in (changes ?? {})) || changes?.flags) _schedule();
    });
    // A region bound to a tile follows its visibility — nothing is written to the region, so watch the tiles.
    Hooks.on("updateTile", (_doc, changes) => { if ("hidden" in (changes ?? {})) _schedule(); });
    Hooks.on("createTile", () => _schedule());
    Hooks.on("deleteTile", () => _schedule());
    Hooks.on("canvasReady", () => _schedule());
  },
};
