// modules/adm-levels/scripts/tools/ui-controls.mjs
// ADMaps Tools — controls shared by the tile config spoilers («Tile scroll», «Tile shadow») and the region texture
// rows (class adm-controls on their box): the spoiler itself
// (the on/off box in its header, an option on the right of the header, the open state remembered per client), the
// degrees dial (drag the ring, Shift — 15° steps, the number in the middle typed by hand) and the live preview.
// The config previews changes on the tile itself (core merges the form into the document and refreshes the tile):
// the controls send «change» while dragged, at most once per frame each; core's own sliders send it only on
// release, so their drags are pushed too.

export const deg = (v) => ((Math.round(Number(v) || 0) % 360) + 360) % 360;

// The dial's dot hangs off a zero-size pivot in its centre: a full-size turned box would stick out at 45° and widen
// the scrollable area of the row.
// Mass Edit: it ticks / reads only `.form-group`s with named fields (and adds its «apply» box to each, also to groups
// added after its render). So the header (summary) and each section of a spoiler are form-groups: a section is a
// subgrid row group (.adm-sec) of the spoiler's grid, and the grid gets one more column, only when Mass Edit's boxes
// are there (:has), for those boxes. Core's .form-group look (flex, bold labels) is taken back off them here.
export const SPOILER_CSS = `
  .adm-spoiler { margin: 6px 0; border: 1px solid var(--color-border-light-tertiary, #7a7971); border-radius: 4px; }
  .adm-spoiler > summary { cursor: pointer; padding: 4px 8px; font-weight: bold; list-style: revert; }
  .adm-spoiler > summary input[type=checkbox] { margin: 0 6px 0 4px; vertical-align: middle; }
  .adm-spoiler > summary .adm-sp-right { float: right; display: inline-flex; align-items: center; font-weight: normal; cursor: pointer; }
  .adm-spoiler > summary::after { content: ""; display: block; clear: both; }
  .adm-spoiler > summary.form-group { display: list-item; margin: 0; }
  .adm-spoiler > summary > label { line-height: normal; color: inherit; flex: none; }
  .adm-spoiler > summary > .mass-edit-checkbox { float: right; display: inline-grid; margin: 2px 0 0 8px; }
  .adm-spoiler .adm-sec { display: grid; grid-column: 1 / -1; grid-template-columns: subgrid; align-items: center; margin: 0; padding: 0; }
  .adm-spoiler .adm-sec > label { font-weight: normal; color: inherit; line-height: normal; flex: none; cursor: default; }
  .adm-spoiler .adm-sec > .mass-edit-checkbox { grid-column: -2 / -1; grid-row: 1; margin: 0; }
  :is(.adm-spoiler, .adm-controls) range-picker { min-width: 0; gap: 4px; }
  :is(.adm-spoiler, .adm-controls) range-picker > input[type=range] { min-width: 0; }
  :is(.adm-spoiler, .adm-controls) range-picker > input[type=number] { flex: 0 0 30px; width: 30px; }
  .adm-dial { position: relative; flex: none; width: 36px; height: 36px; box-sizing: border-box; border-radius: 50%;
    border: 1px solid var(--color-border-light-tertiary, #7a7971); display: flex; align-items: center; justify-content: center;
    cursor: grab; touch-action: none; user-select: none; }
  .adm-dial > i { position: absolute; left: 50%; top: 50%; width: 0; height: 0; transform: rotate(var(--a)); pointer-events: none; }
  .adm-dial > i::after { content: ""; position: absolute; left: 15px; top: -3.5px; width: 7px; height: 7px;
    border-radius: 50%; background: var(--color-warm-1, #ee9b3a); }
  .adm-dial > span { display: flex; align-items: center; font-size: 11px; line-height: 1; cursor: text; }
  .adm-dial input { field-sizing: content; width: auto; min-width: 1ch; max-width: 3.2ch; height: auto; min-height: 0;
    line-height: 1; padding: 0; margin: 0;
    border: none; outline: none; background: none; box-shadow: none; color: inherit; font-size: 11px; text-align: center;
    appearance: textfield; -moz-appearance: textfield; }
  .adm-dial input::-webkit-inner-spin-button,
  .adm-dial input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }`;

/** The spoiler was left open on this client. */
export function spoilerOpen(key) {
  try { return localStorage.getItem(key) === "1"; } catch (_e) { return false; }
}

/** Live preview: the config re-reads the whole form on each change — at most one per element per frame. */
const _soon = new Map();
export function nextFrame(key, fn) {
  const queued = _soon.has(key);
  _soon.set(key, fn);
  if (!queued) requestAnimationFrame(() => {
    const f = _soon.get(key);
    _soon.delete(key);
    try { f(); } catch (_e) {}
  });
}
export const changed = (input) => nextFrame(input, () => input.dispatchEvent(new Event("change", { bubbles: true })));

export const dialHtml = (name, value, label, attrs = "") => `<div class="adm-dial"${attrs} style="--a:${deg(value)}deg"><i></i><span><input
    type="number" name="${name}" value="${deg(value)}" min="0" max="359" step="1" aria-label="${label}">°</span></div>`;

/** Degrees dial: drag on the ring (Shift — 15° steps), the number in the middle is typed by hand. */
export function wireDial(el) {
  const input = el.querySelector("input");
  const show = (v) => el.style.setProperty("--a", `${v}deg`);
  const fromPointer = (ev) => {
    const r = el.getBoundingClientRect();
    let a = Math.atan2(ev.clientY - (r.top + r.height / 2), ev.clientX - (r.left + r.width / 2)) * 180 / Math.PI;
    if (ev.shiftKey) a = Math.round(a / 15) * 15;
    a = deg(a);
    if (String(a) === input.value) return;
    input.value = String(a);
    show(a);
    changed(input);
  };
  let drag = false;
  el.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    if (ev.target.closest(".adm-dial > span")) {   // the number: typed by hand
      if (ev.target !== input) { ev.preventDefault(); input.focus(); input.select?.(); }
      return;
    }
    ev.preventDefault();
    drag = true;
    try { el.setPointerCapture(ev.pointerId); } catch (_e) {}
    fromPointer(ev);
  });
  el.addEventListener("pointermove", (ev) => { if (drag) fromPointer(ev); });
  for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) el.addEventListener(t, () => { drag = false; });
  input.addEventListener("input", () => { if (input.value !== "") show(deg(input.value)); });
  input.addEventListener("change", () => { const a = deg(input.value); input.value = String(a); show(a); });
}

/** A dial's value set from code (no change sent — the caller's own change event carries it). */
export function setDial(el, v) {
  const a = deg(v);
  el.querySelector("input").value = String(a);
  el.style.setProperty("--a", `${a}deg`);
}

/** Push core sliders' drags to the preview, wire the dials. */
export function wireControls(box) {
  box.addEventListener("input", (ev) => {
    const r = ev.target;
    if (r?.type !== "range") return;
    const picker = r.closest("range-picker");
    if (picker) nextFrame(picker, () => { picker.value = r.valueAsNumber; });
  });
  for (const el of box.querySelectorAll(".adm-dial")) wireDial(el);
}

/** Remember the open state, then the controls. */
export function wireSpoiler(box, openKey) {
  box.addEventListener("toggle", () => { try { localStorage.setItem(openKey, box.open ? "1" : "0"); } catch (_e) {} });
  wireControls(box);
}
