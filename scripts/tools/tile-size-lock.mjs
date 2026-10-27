// modules/adm-levels/scripts/tools/tile-size-lock.mjs
// ADMaps Tools — «Proportional tile size».
// A chain-link button between Width and Height in the tile config: pressed, typing one size changes the other in the
// same proportion (100 × 200, width 50 → height 100). The proportion is the one the sizes had when the button was
// pressed, or the tile's own when the config opens with it pressed (the button state is remembered per client).
// The pair is set on every keystroke and again on commit, before the config reads the form (the input's own listener
// runs before the form's), so the live preview and the save get both sizes.

const MODULE_ID = "adm-levels";
const LOCK_KEY = `${MODULE_ID}.tileSizeLock`;   // localStorage: the button was left pressed

function _inject(html) {
  const root = html instanceof HTMLElement ? html : (html?.[0] ?? html);
  const w = root?.querySelector?.('input[name="width"]'), h = root?.querySelector?.('input[name="height"]');
  if (!w || !h || root.querySelector(".adm-size-lock")) return;
  let on = false;
  try { on = localStorage.getItem(LOCK_KEY) === "1"; } catch (_e) {}
  let ratio = 0;   // height ÷ width while pressed
  const take = () => { const a = Number(w.value), b = Number(h.value); ratio = (a > 0 && b > 0) ? b / a : 0; };

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "adm-size-lock";
  btn.setAttribute("aria-label", game.i18n.localize("ADM_LEVELS.tileSizeLock.button"));
  btn.style.cssText = "flex:none;width:28px;height:28px;min-height:0;padding:0;margin:0;display:flex;align-items:center;justify-content:center;";
  const show = () => {
    btn.innerHTML = `<i class="fa-solid ${on ? "fa-link" : "fa-link-slash"}" style="margin:0;"></i>`;
    btn.style.color = on ? "var(--color-warm-1, #ee9b3a)" : "";
    btn.setAttribute("aria-pressed", String(on));
  };
  btn.addEventListener("click", () => {
    on = !on;
    if (on) take();
    try { localStorage.setItem(LOCK_KEY, on ? "1" : "0"); } catch (_e) {}
    show();
  });

  const pair = (src, dst, k) => () => {
    const v = Number(src.value);
    if (!on || !ratio || !(v > 0)) return;
    dst.value = String(Math.max(1, Math.round(v * k())));
  };
  for (const t of ["input", "change"]) {
    w.addEventListener(t, pair(w, h, () => ratio));
    h.addEventListener(t, pair(h, w, () => 1 / ratio));
  }
  if (on) take();
  show();
  w.insertAdjacentElement("afterend", btn);
  // Core gives the row's label and fields half each — with the button the two sizes would wrap. Fields are
  // right-aligned, so two thirds keep them on one line without moving them against the other rows.
  const fields = w.closest(".form-fields");
  if (fields) fields.style.flex = "2";
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMaps Tools sub-module descriptor
// ─────────────────────────────────────────────────────────────────────────────
export const TOOL = {
  id: "tileSizeLock",
  name: "ADM_LEVELS.settings.tileSizeLock.name",
  hint: "ADM_LEVELS.settings.tileSizeLock.hint",

  onReady({ isEnabled }) {
    Hooks.on("renderTileConfig", (_app, html) => {
      if (!isEnabled()) return;
      try { _inject(html); } catch (e) { console.warn("[ADM:tileSizeLock]", e); }
    });
  },
};
