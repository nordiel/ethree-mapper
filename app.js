const PALETTE = [
  "#3b82f6",
  "#ef4444",
  "#22c55e",
  "#f59e0b",
  "#a855f7",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
  "#f97316",
  "#6366f1",
  "#14b8a6",
  "#e11d48",
  "#0ea5e9",
  "#eab308",
  "#8b5cf6",
  "#10b981",
  "#fb7185",
  "#d946ef",
];

const PIN_COLORS = [
  "#ef4444",
  "#3b82f6",
  "#22c55e",
  "#f59e0b",
  "#a855f7",
  "#ec4899",
  "#06b6d4",
  "#f97316",
];
const SHAPE_COLORS = [
  "#3b82f6",
  "#ef4444",
  "#22c55e",
  "#f59e0b",
  "#a855f7",
  "#06b6d4",
];

let state = {
  regions: [],
  assignments: {},
  selected: null,
  eraser: false,
  showLabels: false,
  showAnnoLabels: true,
  showRegionLabels: false,
  pins: [],
  shapes: [],
  itemTypes: [], // one entry per uploaded image { id, label, dataUrl, iw, ih }
  items: [],     // one entry per placed instance { id, typeId, lon, lat }
  pendingItem: null,
  pendingItemId: null, // itemType.id currently selected for placement
  tool: "paint", // 'paint' | 'eraser' | 'pin' | 'polygon' | 'item'
  drawingShape: null,
};
let nextColorIdx = 0,
  nextPinColorIdx = 0,
  nextShapeColorIdx = 0;
let dragOccurred = false;
let view = null;
let isPanning = false, panStart = null, panDragged = false;

/* ---------- image cache (localStorage, separate from window.storage) ---------- */
function cacheImage(typeId, dataUrl) {
  try { localStorage.setItem("emap-img-" + typeId, dataUrl); } catch (e) {}
}
function getCachedImage(typeId) {
  return localStorage.getItem("emap-img-" + typeId) || "";
}
function uncacheImage(typeId) {
  try { localStorage.removeItem("emap-img-" + typeId); } catch (e) {}
}
function clearImageCache() {
  Object.keys(localStorage)
    .filter((k) => k.startsWith("emap-img-"))
    .forEach((k) => localStorage.removeItem(k));
}

/* ---------- persistence ---------- */
const STORE_KEY = "pr-mapper-v2";
async function save() {
  try {
    if (window.storage)
      await window.storage.set(
        STORE_KEY,
        JSON.stringify({
          regions: state.regions,
          assignments: state.assignments,
          nextColorIdx,
          pins: state.pins,
          shapes: state.shapes,
          itemTypes: state.itemTypes.map(({ dataUrl, ...rest }) => rest),
          items: state.items,
          showLabels: state.showLabels,
          showAnnoLabels: state.showAnnoLabels,
          showRegionLabels: state.showRegionLabels,
        }),
      );
  } catch (e) {}
}
async function load() {
  try {
    if (window.storage) {
      const r = await window.storage.get(STORE_KEY);
      if (r && r.value) {
        const d = JSON.parse(r.value);
        state.regions = d.regions || [];
        state.assignments = d.assignments || {};
        state.pins = d.pins || [];
        state.shapes = d.shapes || [];
        // migrate old flat items (had dataUrl) to types + instances
        if (d.itemTypes) {
          state.itemTypes = d.itemTypes.map((t) => ({ ...t, dataUrl: getCachedImage(t.id) }));
          state.items = d.items || [];
        } else if (d.items && d.items.length && d.items[0].dataUrl) {
          d.items.forEach((old) => {
            const t = { id: "type" + old.id, label: old.label, dataUrl: old.dataUrl, iw: old.iw, ih: old.ih };
            cacheImage(t.id, t.dataUrl);
            state.itemTypes.push(t);
            state.items.push({ id: old.id, typeId: t.id, lon: old.lon, lat: old.lat });
          });
        }
        state.showLabels = d.showLabels || false;
        state.showAnnoLabels = d.showAnnoLabels !== false;
        state.showRegionLabels = d.showRegionLabels || false;
        nextColorIdx = d.nextColorIdx || state.regions.length;
        return true;
      }
    }
  } catch (e) {}
  return false;
}

/* ---------- projection ---------- */
let bounds, lonScale;
function computeBounds() {
  let a = Infinity,
    b = -Infinity,
    c = Infinity,
    d = -Infinity;
  const walk = (co) => {
    if (typeof co[0] === "number") {
      if (co[0] < a) a = co[0];
      if (co[0] > b) b = co[0];
      if (co[1] < c) c = co[1];
      if (co[1] > d) d = co[1];
    } else co.forEach(walk);
  };
  GEO.features.forEach((f) => walk(f.geometry.coordinates));
  bounds = { minLon: a, maxLon: b, minLat: c, maxLat: d };
  lonScale = Math.cos((((c + d) / 2) * Math.PI) / 180);
}
const K = 1400,
  PAD = 14;
function proj(lon, lat) {
  return {
    x: (lon - bounds.minLon) * lonScale * K + PAD,
    y: (bounds.maxLat - lat) * K + PAD,
  };
}
function projStr(lon, lat) {
  const p = proj(lon, lat);
  return p.x.toFixed(1) + "," + p.y.toFixed(1);
}
function unproj(x, y) {
  return {
    lon: (x - PAD) / (lonScale * K) + bounds.minLon,
    lat: bounds.maxLat - (y - PAD) / K,
  };
}
function ringToPath(ring) {
  return "M" + ring.map((p) => projStr(p[0], p[1])).join("L") + "Z";
}
function geomToPath(g) {
  if (g.type === "Polygon") return g.coordinates.map(ringToPath).join("");
  return g.coordinates.map((poly) => poly.map(ringToPath).join("")).join("");
}

/* ---------- centroid ---------- */
function featureCentroid(f) {
  let sx = 0,
    sy = 0,
    n = 0;
  const geom = f.geometry;
  const addRing = (ring) =>
    ring.forEach((c) => {
      sx += c[0];
      sy += c[1];
      n++;
    });
  if (geom.type === "Polygon") addRing(geom.coordinates[0]);
  else geom.coordinates.forEach((poly) => addRing(poly[0]));
  return n > 0 ? { lon: sx / n, lat: sy / n } : null;
}

/* ---------- SVG coordinate helper ---------- */
function getSvgPoint(e) {
  const svg = document.getElementById("map");
  const pt = svg.createSVGPoint();
  pt.x = e.clientX;
  pt.y = e.clientY;
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}

/* ---------- zoom / pan ---------- */
function setViewBox(x, y, w, h) {
  view = { ...view, x, y, w, h };
  document.getElementById("map").setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
}
function zoomBy(factor, svgPx, svgPy) {
  if (!view) return;
  const newW = view.w * factor;
  if (newW > view.defW * 1.5 || newW < view.defW / 15) return;
  const newH = view.h * factor;
  const px = svgPx !== undefined ? svgPx : view.x + view.w / 2;
  const py = svgPy !== undefined ? svgPy : view.y + view.h / 2;
  setViewBox(px - (px - view.x) * factor, py - (py - view.y) * factor, newW, newH);
}
function resetZoom() {
  if (view) setViewBox(view.defX, view.defY, view.defW, view.defH);
}

/* ---------- map render ---------- */
let labelsByFips = {},
  lastHoveredLabel = null;
function renderMap() {
  computeBounds();
  const H = (bounds.maxLat - bounds.minLat) * K + PAD * 2;
  const viewMinLon = Math.max(bounds.minLon, -67.32);
  const vbX = (viewMinLon - bounds.minLon) * lonScale * K + PAD;
  const vbW = (bounds.maxLon - viewMinLon) * lonScale * K + PAD;
  view = { x: vbX, y: 0, w: vbW, h: H, defX: vbX, defY: 0, defW: vbW, defH: H };
  const svg = document.getElementById("map");
  svg.setAttribute(
    "viewBox",
    `${vbX.toFixed(0)} 0 ${vbW.toFixed(0)} ${H.toFixed(0)}`,
  );

  let muniHtml = "",
    labelHtml = "";
  GEO.features.forEach((f) => {
    const fips = f.properties.fips,
      name = f.properties.name;
    muniHtml += `<path class="muni" data-fips="${fips}" data-name="${name.replace(/"/g, "&quot;")}" d="${geomToPath(f.geometry)}"></path>`;
    const c = featureCentroid(f);
    if (c) {
      const p = proj(c.lon, c.lat);
      labelHtml += `<text class="muni-label" data-fips="${fips}" x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}">${escapeHtml(name)}</text>`;
    }
  });

  svg.innerHTML = `
    <g id="muni-paths">${muniHtml}</g>
    <g id="shapes-layer"></g>
    <g id="muni-labels">${labelHtml}</g>
    <g id="region-labels-layer"></g>
    <g id="pins-layer"></g>
    <g id="items-layer"></g>
    <g id="drawing-layer"></g>`;

  svg.querySelectorAll("path.muni").forEach((p) => {
    p.addEventListener("click", onMuniClick);
    p.addEventListener("mousemove", onMuniHover);
    p.addEventListener("mouseleave", hideTip);
  });
  labelsByFips = {};
  svg
    .querySelectorAll("text.muni-label")
    .forEach((t) => (labelsByFips[t.dataset.fips] = t));

  svg.addEventListener("click", onSvgClick);
  svg.addEventListener("mousemove", onSvgMove);
  svg.addEventListener("dblclick", onSvgDblClick);
  updateLabelVisibility();
}

function updateLabelVisibility() {
  document
    .getElementById("map")
    .classList.toggle("labels-always", state.showLabels);
}

/* ---------- SVG-level events (pins & polygon) ---------- */
function onSvgClick(e) {
  if (dragOccurred) { dragOccurred = false; return; }
  if (panDragged) { panDragged = false; return; }
  if (state.tool !== "pin" && state.tool !== "polygon" && state.tool !== "item") return;
  if (e.target.closest("#pins-layer") || e.target.closest("#shapes-layer") || e.target.closest("#items-layer"))
    return;
  const sp = getSvgPoint(e);
  const { lon, lat } = unproj(sp.x, sp.y);

  if (state.tool === "item" && state.pendingItem) {
    state.items.push({ id: "item" + Date.now(), typeId: state.pendingItemId, lon, lat });
    renderItems();
    renderItemList();
    save();
    return;
  }

  if (state.tool === "pin") {
    const id = "pin" + Date.now();
    const color = PIN_COLORS[nextPinColorIdx % PIN_COLORS.length];
    nextPinColorIdx++;
    state.pins.push({
      id,
      lon,
      lat,
      label: "Pin " + (state.pins.length + 1),
      color,
    });
    renderPins();
    renderPinList();
    save();
    toast("Pin placed");
  } else if (state.tool === "polygon") {
    if (e.detail === 2) return; // dblclick fires separately
    if (!state.drawingShape) {
      const color = SHAPE_COLORS[nextShapeColorIdx % SHAPE_COLORS.length];
      nextShapeColorIdx++;
      state.drawingShape = { points: [{ lon, lat }], color };
    } else {
      state.drawingShape.points.push({ lon, lat });
    }
    renderDrawing(sp);
  }
}

function onSvgMove(e) {
  if (state.tool === "polygon" && state.drawingShape)
    renderDrawing(getSvgPoint(e));
}

function onSvgDblClick(e) {
  e.preventDefault();
  if (state.tool !== "polygon" || !state.drawingShape) return;
  if (state.drawingShape.points.length < 2) return;
  const id = "shape" + Date.now();
  state.shapes.push({
    id,
    points: [...state.drawingShape.points],
    color: state.drawingShape.color,
    label: "Zone " + (state.shapes.length + 1),
  });
  state.drawingShape = null;
  document.getElementById("drawing-layer").innerHTML = "";
  renderShapes();
  renderShapeList();
  save();
  toast("Shape saved");
}

function cancelDrawing() {
  state.drawingShape = null;
  const dl = document.getElementById("drawing-layer");
  if (dl) dl.innerHTML = "";
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.tool === "polygon" && state.drawingShape) {
    cancelDrawing();
    toast("Drawing cancelled");
  }
  if (e.key === "Escape" && state.tool === "item") {
    state.tool = "paint";
    state.pendingItem = null;
    state.pendingItemId = null;
    updateMapCursor(); updateFoot(); syncEraser(); renderItemList();
  }
});

/* ---------- drawing preview ---------- */
function renderDrawing(cursor) {
  if (!state.drawingShape || !state.drawingShape.points.length) return;
  const pts = state.drawingShape.points;
  const color = state.drawingShape.color;
  const pStr = pts
    .map((p) => {
      const q = proj(p.lon, p.lat);
      return q.x.toFixed(1) + "," + q.y.toFixed(1);
    })
    .join(" ");
  let html = `<polyline points="${pStr} ${cursor.x.toFixed(1)},${cursor.y.toFixed(1)}" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="5,3" opacity=".85"/>`;
  pts.forEach((p) => {
    const q = proj(p.lon, p.lat);
    html += `<circle cx="${q.x.toFixed(1)}" cy="${q.y.toFixed(1)}" r="3.5" fill="${color}" stroke="#fff" stroke-width="1" opacity=".9"/>`;
  });
  document.getElementById("drawing-layer").innerHTML = html;
}

/* ---------- render shapes ---------- */
function renderShapes() {
  const g = document.getElementById("shapes-layer");
  if (!g) return;
  let html = "";
  state.shapes.forEach((s) => {
    const pts = s.points
      .map((p) => {
        const q = proj(p.lon, p.lat);
        return q.x.toFixed(1) + "," + q.y.toFixed(1);
      })
      .join(" ");
    const cx = s.points.reduce((a, p) => a + p.lon, 0) / s.points.length;
    const cy = s.points.reduce((a, p) => a + p.lat, 0) / s.points.length;
    const lp = proj(cx, cy);
    html += `<g class="drawn-shape" data-id="${s.id}">
      <polygon points="${pts}" fill="${s.color}" fill-opacity="0.25" stroke="${s.color}" stroke-width="1.8" stroke-opacity="0.75" stroke-linejoin="round"/>
      <text class="shape-label" x="${lp.x.toFixed(1)}" y="${lp.y.toFixed(1)}">${escapeHtml(s.label)}</text>
    </g>`;
  });
  g.innerHTML = html;
  g.querySelectorAll(".drawn-shape").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (!state.eraser && state.tool !== "eraser") return;
      e.stopPropagation();
      state.shapes = state.shapes.filter((s) => s.id !== el.dataset.id);
      renderShapes(); renderShapeList(); save();
    });
  });
}

/* ---------- render pins ---------- */
function renderPins() {
  const g = document.getElementById("pins-layer");
  if (!g) return;
  let html = "";
  state.pins.forEach((pin) => {
    const p = proj(pin.lon, pin.lat);
    html += `<g class="pin-marker" data-id="${pin.id}">
      <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="6" fill="${pin.color}" stroke="#fff" stroke-width="1.5" opacity=".92"/>
      <text class="pin-label" x="${p.x.toFixed(1)}" y="${(p.y - 10).toFixed(1)}">${escapeHtml(pin.label)}</text>
    </g>`;
  });
  g.innerHTML = html;
  g.querySelectorAll(".pin-marker").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (!state.eraser && state.tool !== "eraser") return;
      e.stopPropagation();
      state.pins = state.pins.filter((p) => p.id !== el.dataset.id);
      renderPins(); renderPinList(); save();
    });
  });
}

/* ---------- region paint ---------- */
function regionById(id) {
  return state.regions.find((r) => r.id === id);
}
function paintMap() {
  document.querySelectorAll("path.muni").forEach((p) => {
    const rid = state.assignments[p.dataset.fips];
    const r = rid ? regionById(rid) : null;
    p.style.fill = r ? r.color : "";
  });
  renderRegionLabels();
}

function renderRegionLabels() {
  const g = document.getElementById("region-labels-layer");
  if (!g) return;
  if (!state.showRegionLabels) { g.innerHTML = ""; return; }

  let html = "";
  state.regions.forEach((region) => {
    const assignedFips = new Set(
      Object.entries(state.assignments)
        .filter(([, rid]) => rid === region.id)
        .map(([fips]) => fips)
    );
    if (!assignedFips.size) return;

    const pts = [];
    GEO.features.forEach((f) => {
      if (!assignedFips.has(String(f.properties.fips))) return;
      const c = featureCentroid(f);
      if (c) pts.push(proj(c.lon, c.lat));
    });
    if (!pts.length) return;

    const cx = (pts.reduce((s, p) => s + p.x, 0) / pts.length).toFixed(1);
    const cy = (pts.reduce((s, p) => s + p.y, 0) / pts.length).toFixed(1);
    html += `<text class="region-label" style="fill:${region.color}" x="${cx}" y="${cy}">${escapeHtml(region.name)}</text>`;
  });
  g.innerHTML = html;
}
function onMuniClick(e) {
  if (panDragged) return;
  if (state.tool === "pin" || state.tool === "polygon" || state.tool === "item") return;
  const fips = e.currentTarget.dataset.fips;
  if (state.eraser || state.tool === "eraser") {
    delete state.assignments[fips];
  } else {
    if (!state.selected) {
      flashFoot("Pick a region from the panel first ⟶");
      return;
    }
    if (state.assignments[fips] === state.selected)
      delete state.assignments[fips];
    else state.assignments[fips] = state.selected;
  }
  paintMap();
  renderList();
  updateCoverage();
  save();
}

/* ---------- tooltip ---------- */
const tip = document.getElementById("tip"),
  mapWrap = document.getElementById("mapWrap");
function onMuniHover(e) {
  if (isPanning) return;
  if (state.tool === "pin" || state.tool === "polygon" || state.tool === "item") return;
  const t = e.currentTarget,
    rect = mapWrap.getBoundingClientRect();
  tip.querySelector(".t-name").textContent = t.dataset.name;
  const rid = state.assignments[t.dataset.fips],
    r = rid ? regionById(rid) : null;
  tip.querySelector(".t-wh").innerHTML = r
    ? `<span class="dot" style="background:${r.color}"></span>${escapeHtml(r.name)}`
    : `<span style="color:var(--muted-2)">Unassigned</span>`;
  tip.style.left = e.clientX - rect.left + "px";
  tip.style.top = e.clientY - rect.top + "px";
  tip.style.opacity = "1";
  if (!state.showLabels) {
    if (lastHoveredLabel) lastHoveredLabel.style.opacity = "";
    const lbl = labelsByFips[t.dataset.fips];
    if (lbl) {
      lbl.style.opacity = "1";
      lastHoveredLabel = lbl;
    }
  }
}
function hideTip() {
  tip.style.opacity = "0";
  if (!state.showLabels && lastHoveredLabel) {
    lastHoveredLabel.style.opacity = "";
    lastHoveredLabel = null;
  }
}

/* ---------- zoom / pan events ---------- */
mapWrap.addEventListener("wheel", (e) => {
  e.preventDefault();
  if (!view) return;
  const factor = (e.deltaY || e.deltaX) > 0 ? 1.18 : 1 / 1.18;
  const pt = getSvgPoint(e);
  zoomBy(factor, pt.x, pt.y);
}, { passive: false });

const mapSvg = document.getElementById("map");
mapSvg.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || !view) return;
  isPanning = true;
  panDragged = false;
  panStart = { screenX: e.clientX, screenY: e.clientY, vx: view.x, vy: view.y };
  mapSvg.setPointerCapture(e.pointerId);
});
mapSvg.addEventListener("pointermove", (e) => {
  if (!isPanning || !panStart) return;
  const dx = e.clientX - panStart.screenX;
  const dy = e.clientY - panStart.screenY;
  if (!panDragged && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
    panDragged = true;
    mapSvg.style.cursor = "grabbing";
  }
  if (!panDragged) return;
  hideTip();
  const rect = mapSvg.getBoundingClientRect();
  setViewBox(
    panStart.vx - dx * (view.w / rect.width),
    panStart.vy - dy * (view.h / rect.height),
    view.w, view.h
  );
});
mapSvg.addEventListener("pointerup", () => {
  if (isPanning) {
    isPanning = false;
    panStart = null;
    if (panDragged) updateMapCursor();
  }
});
mapSvg.addEventListener("pointercancel", () => {
  isPanning = false;
  panStart = null;
  panDragged = false;
  updateMapCursor();
});

document.getElementById("zoomIn").addEventListener("click", () => zoomBy(1 / 1.5));
document.getElementById("zoomOut").addEventListener("click", () => zoomBy(1.5));
document.getElementById("zoomReset").addEventListener("click", resetZoom);

/* ---------- tabs ---------- */
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.tab === "regions") clearAnnotationMode();
    document
      .querySelectorAll(".tab")
      .forEach((b) => b.classList.remove("active"));
    document
      .querySelectorAll(".tab-panel")
      .forEach((p) => p.classList.add("hidden"));
    btn.classList.add("active");
    document
      .getElementById("tab-" + btn.dataset.tab)
      .classList.remove("hidden");
  });
});

/* ---------- sidebar region list ---------- */
const regionList = document.getElementById("regionList");
function renderList() {
  regionList.innerHTML = "";
  const counts = {};
  Object.values(state.assignments).forEach(
    (id) => (counts[id] = (counts[id] || 0) + 1),
  );
  state.regions.forEach((r) => {
    const row = document.createElement("div");
    row.className =
      "wh" +
      (state.selected === r.id && state.tool === "paint" ? " active" : "");
    row.innerHTML = `
      <input type="color" class="swatch" value="${r.color}" title="Change color">
      <span class="name-text">${escapeHtml(r.name)}</span>
      <button class="edit-btn" title="Rename">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
      </button>
      <span class="count mono">${counts[r.id] || 0}</span>
      <button class="del" title="Delete region">×</button>`;
    row.addEventListener("click", () => {
      clearAnnotationMode();
      state.eraser = false;
      state.selected = r.id;
      syncEraser();
      renderList();
      updateFoot();
    });
    const swatchInp = row.querySelector(".swatch");
    swatchInp.addEventListener("click", (ev) => ev.stopPropagation());
    swatchInp.addEventListener("input", (ev) => {
      r.color = ev.target.value;
      paintMap(); renderList(); updateFoot();
    });
    swatchInp.addEventListener("change", () => save());
    const nameSpan = row.querySelector(".name-text");
    const editBtn = row.querySelector(".edit-btn");
    editBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const inp = document.createElement("input");
      inp.className = "name";
      inp.value = r.name;
      inp.spellcheck = false;
      nameSpan.replaceWith(inp);
      editBtn.style.visibility = "hidden";
      inp.focus();
      inp.select();
      const done = () => {
        r.name = inp.value.trim() || r.name;
        nameSpan.textContent = r.name;
        inp.replaceWith(nameSpan);
        editBtn.style.visibility = "";
        renderRegionLabels();
        save();
      };
      inp.addEventListener("blur", done);
      inp.addEventListener("keydown", (ke) => {
        if (ke.key === "Enter") inp.blur();
        if (ke.key === "Escape") { inp.value = r.name; inp.blur(); }
      });
      inp.addEventListener("click", (ke) => ke.stopPropagation());
    });
    row.querySelector(".del").addEventListener("click", (ev) => {
      ev.stopPropagation();
      deleteRegion(r.id);
    });
    regionList.appendChild(row);
  });
}
function addRegion() {
  const color = PALETTE[nextColorIdx % PALETTE.length];
  nextColorIdx++;
  const id = "r" + Date.now() + Math.floor(Math.random() * 999);
  const r = {
    id,
    name: "Region " + String.fromCharCode(65 + (state.regions.length % 26)),
    color,
  };
  state.regions.push(r);
  state.selected = id;
  state.tool = "paint";
  state.eraser = false;
  syncEraser();
  renderList();
  updateFoot();
  save();
}
function deleteRegion(id) {
  state.regions = state.regions.filter((r) => r.id !== id);
  Object.keys(state.assignments).forEach((f) => {
    if (state.assignments[f] === id) delete state.assignments[f];
  });
  if (state.selected === id) state.selected = state.regions[0]?.id || null;
  paintMap();
  renderList();
  updateCoverage();
  save();
}

/* ---------- annotation lists ---------- */
function renderPinList() {
  const el = document.getElementById("pinList");
  if (!el) return;
  if (!state.pins.length) {
    el.innerHTML = '<p class="empty-anno">No pins placed yet.</p>';
    return;
  }
  el.innerHTML = "";
  state.pins.forEach((pin) => {
    const row = document.createElement("div");
    row.className = "anno-item";
    row.innerHTML = `<span class="anno-dot" style="background:${pin.color}"></span>
      <input class="anno-name" value="${escapeHtml(pin.label)}">
      <button class="del" title="Delete">×</button>`;
    row.querySelector(".anno-name").addEventListener("change", (e) => {
      pin.label = e.target.value.trim() || pin.label;
      renderPins();
      save();
    });
    row.querySelector(".del").addEventListener("click", () => {
      state.pins = state.pins.filter((p) => p.id !== pin.id);
      renderPins();
      renderPinList();
      save();
    });
    el.appendChild(row);
  });
}
function renderShapeList() {
  const el = document.getElementById("shapeList");
  if (!el) return;
  if (!state.shapes.length) {
    el.innerHTML = '<p class="empty-anno">No shapes drawn yet.</p>';
    return;
  }
  el.innerHTML = "";
  state.shapes.forEach((shape) => {
    const row = document.createElement("div");
    row.className = "anno-item";
    row.innerHTML = `<span class="anno-dot" style="background:${shape.color}"></span>
      <input class="anno-name" value="${escapeHtml(shape.label)}">
      <button class="del" title="Delete">×</button>`;
    row.querySelector(".anno-name").addEventListener("change", (e) => {
      shape.label = e.target.value.trim() || shape.label;
      renderShapes();
      save();
    });
    row.querySelector(".del").addEventListener("click", () => {
      state.shapes = state.shapes.filter((s) => s.id !== shape.id);
      renderShapes();
      renderShapeList();
      save();
    });
    el.appendChild(row);
  });
}

/* ---------- items ---------- */
const ITEM_MAX = 72; // SVG units — controls icon size on map
function renderItems() {
  const g = document.getElementById("items-layer");
  if (!g) return;
  let html = "";
  state.items.forEach((item) => {
    const type = state.itemTypes.find((t) => t.id === item.typeId);
    if (!type) return;
    const p = proj(item.lon, item.lat);
    const scale = ITEM_MAX / Math.max(type.iw, type.ih, 1);
    const w = type.iw * scale, h = type.ih * scale;
    const cx = p.x, cy = p.y;
    html += `<g class="item-marker" data-id="${item.id}" style="cursor:pointer">
      <image href="${type.dataUrl}" x="${(cx-w/2).toFixed(1)}" y="${(cy-h/2).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" preserveAspectRatio="xMidYMid meet"/>
      <text class="pin-label" x="${cx.toFixed(1)}" y="${(cy+h/2+12).toFixed(1)}">${escapeHtml(type.label)}</text>
    </g>`;
  });
  g.innerHTML = html;
  g.querySelectorAll(".item-marker").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (!state.eraser && state.tool !== "eraser") return;
      e.stopPropagation();
      state.items = state.items.filter((it) => it.id !== el.dataset.id);
      renderItems(); renderItemList(); save();
    });

    el.addEventListener("pointerdown", (e) => {
      if (state.eraser || state.tool === "eraser" || state.tool === "item") return;
      e.stopPropagation();
      e.preventDefault();

      const itemId = el.dataset.id;
      const item = state.items.find((it) => it.id === itemId);
      if (!item) return;
      const type = state.itemTypes.find((t) => t.id === item.typeId);
      if (!type) return;

      const scale = ITEM_MAX / Math.max(type.iw, type.ih, 1);
      const w = type.iw * scale, h = type.ih * scale;
      const imgEl = el.querySelector("image");
      const txtEl = el.querySelector("text");
      let moved = false;

      el.setPointerCapture(e.pointerId);
      el.style.cursor = "grabbing";

      const onMove = (me) => {
        moved = true;
        const sp = getSvgPoint(me);
        const { lon, lat } = unproj(sp.x, sp.y);
        item.lon = lon;
        item.lat = lat;
        const p = proj(lon, lat);
        if (imgEl) {
          imgEl.setAttribute("x", (p.x - w / 2).toFixed(1));
          imgEl.setAttribute("y", (p.y - h / 2).toFixed(1));
        }
        if (txtEl) {
          txtEl.setAttribute("x", p.x.toFixed(1));
          txtEl.setAttribute("y", (p.y + h / 2 + 12).toFixed(1));
        }
      };

      const onUp = () => {
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        el.style.cursor = "";
        if (moved) {
          dragOccurred = true;
          setTimeout(() => { dragOccurred = false; }, 100);
          save();
        }
      };

      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
    });
  });
}
function renderItemList() {
  const el = document.getElementById("itemList");
  if (!el) return;
  if (!state.itemTypes.length) {
    el.innerHTML = '<p class="empty-anno">No items added yet.</p>';
    return;
  }
  el.innerHTML = "";
  state.itemTypes.forEach((type) => {
    const isActive = state.tool === "item" && state.pendingItemId === type.id;
    const count = state.items.filter((it) => it.typeId === type.id).length;
    const row = document.createElement("div");
    row.className = "anno-item" + (isActive ? " active" : "");
    row.title = isActive ? "Click to stop placing" : "Click to place on map";
    row.innerHTML = `<img class="item-list-thumb" src="${type.dataUrl}" alt="">
      <input class="anno-name" value="${escapeHtml(type.label)}">
      ${isActive ? '<span class="placing-badge">placing…</span>' : (count > 0 ? `<span class="item-count">${count}</span>` : '')}
      <button class="del" title="Delete">×</button>`;
    row.addEventListener("click", (e) => {
      if (e.target.tagName === "INPUT" || e.target.closest(".del")) return;
      if (isActive) {
        state.tool = "paint";
        state.pendingItem = null;
        state.pendingItemId = null;
        updateMapCursor(); updateFoot(); syncEraser(); renderItemList();
      } else {
        state.pendingItem = { ...type };
        state.pendingItemId = type.id;
        state.tool = "item";
        state.eraser = false;
        syncEraser(); updateMapCursor(); updateFoot(); renderItemList();
        toast(`Placing "${type.label}" — click the map. Esc to stop.`);
      }
    });
    row.querySelector(".anno-name").addEventListener("change", (e) => {
      type.label = e.target.value.trim() || type.label;
      renderItems(); save();
    });
    row.querySelector(".del").addEventListener("click", () => {
      if (state.pendingItemId === type.id) {
        state.tool = "paint"; state.pendingItem = null; state.pendingItemId = null;
        updateMapCursor(); updateFoot(); syncEraser();
      }
      uncacheImage(type.id);
      state.itemTypes = state.itemTypes.filter((t) => t.id !== type.id);
      state.items = state.items.filter((it) => it.typeId !== type.id);
      renderItems(); renderItemList(); save();
    });
    el.appendChild(row);
  });
}

/* ---------- item form ---------- */
let pendingDataUrl = null, pendingNW = 0, pendingNH = 0;
const addItemBtn  = document.getElementById("addItemBtn");
const itemForm    = document.getElementById("itemForm");
const itemFileEl  = document.getElementById("itemFile");
const itemLabelEl = document.getElementById("itemLabel");
const itemPlaceBtn  = document.getElementById("itemPlaceBtn");
const itemCancelBtn = document.getElementById("itemCancelBtn");
const itemFileNameEl = document.getElementById("itemFileName");
const itemThumbEl   = document.getElementById("itemThumb");

addItemBtn.addEventListener("click", () => {
  itemForm.style.display = "flex";
  addItemBtn.style.display = "none";
  itemLabelEl.value = "";
  itemFileEl.value = "";
  itemFileNameEl.textContent = "Choose image…";
  itemThumbEl.style.display = "none";
  itemPlaceBtn.disabled = true;
  pendingDataUrl = null;
});
itemFileEl.addEventListener("change", () => {
  const file = itemFileEl.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    pendingDataUrl = ev.target.result;
    itemFileNameEl.textContent = file.name;
    itemThumbEl.src = pendingDataUrl;
    itemThumbEl.style.display = "block";
    itemThumbEl.onload = () => { pendingNW = itemThumbEl.naturalWidth; pendingNH = itemThumbEl.naturalHeight; };
    itemPlaceBtn.disabled = false;
  };
  reader.readAsDataURL(file);
});
itemPlaceBtn.addEventListener("click", () => {
  if (!pendingDataUrl) return;
  const label = itemLabelEl.value.trim() || "Item " + (state.itemTypes.length + 1);
  const newType = { id: "type" + Date.now(), label, dataUrl: pendingDataUrl, iw: pendingNW || 100, ih: pendingNH || 100 };
  state.itemTypes.push(newType);
  cacheImage(newType.id, newType.dataUrl);
  state.pendingItem = { ...newType };
  state.pendingItemId = newType.id;
  state.tool = "item";
  state.eraser = false;
  itemForm.style.display = "none";
  addItemBtn.style.display = "";
  syncEraser(); updateMapCursor(); updateFoot(); renderItemList();
  toast(`Placing "${label}" — click the map. Esc to stop.`);
});
itemCancelBtn.addEventListener("click", () => {
  itemForm.style.display = "none";
  addItemBtn.style.display = "";
  pendingDataUrl = null;
  if (state.tool === "item") {
    state.tool = "paint"; state.pendingItem = null; state.pendingItemId = null;
    updateMapCursor(); updateFoot(); syncEraser(); renderItemList();
  }
});

/* ---------- tool buttons ---------- */
const eraserBtn = document.getElementById("eraserBtn");
function syncEraser() {
  eraserBtn.classList.toggle("on", state.eraser || state.tool === "eraser");
  updateFoot();
}
eraserBtn.addEventListener("click", () => {
  if (state.tool === "eraser") {
    state.tool = "paint";
    state.eraser = false;
  } else {
    state.tool = "eraser";
    state.eraser = true;
    state.selected = null;
  }
  renderList();
  syncEraser();
});
document.getElementById("addRegion").addEventListener("click", addRegion);
document.getElementById("resetBtn").addEventListener("click", () => {
  if (!confirm("Clear all assignments and annotations? Regions are kept.")) return;
  state.assignments = {};
  state.pins = [];
  state.shapes = [];
  state.items = [];
  state.itemTypes.forEach((t) => uncacheImage(t.id));
  state.itemTypes = [];
  paintMap();
  renderList();
  renderPins(); renderPinList();
  renderShapes(); renderShapeList();
  renderItems(); renderItemList();
  updateCoverage();
  save();
  toast("Map cleared");
});

/* ---------- pin & polygon mode buttons ---------- */
const pinModeBtn = document.getElementById("pinModeBtn");
const polyModeBtn = document.getElementById("polyModeBtn");
const polyHint = document.getElementById("polyHint");

function clearAnnotationMode() {
  if (!["pin", "polygon", "item"].includes(state.tool)) return;
  state.tool = "paint";
  state.pendingItem = null;
  state.pendingItemId = null;
  cancelDrawing();
  pinModeBtn.classList.remove("on");
  polyModeBtn.classList.remove("on");
  polyHint.style.display = "none";
  updateMapCursor();
  updateFoot();
  renderItemList();
}

pinModeBtn.addEventListener("click", () => {
  if (state.tool === "pin") {
    state.tool = "paint";
    pinModeBtn.classList.remove("on");
  } else {
    state.tool = "pin";
    state.eraser = false;
    cancelDrawing();
    pinModeBtn.classList.add("on");
    polyModeBtn.classList.remove("on");
    polyHint.style.display = "none";
    syncEraser();
  }
  updateMapCursor();
  updateFoot();
});
polyModeBtn.addEventListener("click", () => {
  if (state.tool === "polygon") {
    state.tool = "paint";
    polyModeBtn.classList.remove("on");
    cancelDrawing();
    polyHint.style.display = "none";
  } else {
    state.tool = "polygon";
    state.eraser = false;
    cancelDrawing();
    polyModeBtn.classList.add("on");
    pinModeBtn.classList.remove("on");
    polyHint.style.display = "block";
    syncEraser();
  }
  updateMapCursor();
  updateFoot();
});
function updateMapCursor() {
  document.getElementById("map").style.cursor =
    state.tool === "pin" || state.tool === "polygon" || state.tool === "item" ? "crosshair" : "";
}

/* ---------- name labels toggle ---------- */
document.getElementById("labelsAlways").addEventListener("change", function () {
  state.showLabels = this.checked;
  if (state.showLabels && lastHoveredLabel) {
    lastHoveredLabel.style.opacity = "";
    lastHoveredLabel = null;
  }
  updateLabelVisibility();
  save();
});

/* ---------- annotation labels toggle ---------- */
function updateAnnoLabels() {
  document.getElementById("map").classList.toggle("anno-labels-hidden", !state.showAnnoLabels);
}
document.getElementById("annoLabels").addEventListener("change", function () {
  state.showAnnoLabels = this.checked;
  updateAnnoLabels();
  save();
});
document.getElementById("regionLabels").addEventListener("change", function () {
  state.showRegionLabels = this.checked;
  renderRegionLabels();
  save();
});

/* ---------- coverage meter ---------- */
function updateCoverage() {
  const n = Object.keys(state.assignments).length;
  document.getElementById("covNum").textContent = n;
  document.getElementById("covBar").style.width = (n / 78) * 100 + "%";
}

/* ---------- footer status ---------- */
function updateFoot() {
  const f = document.getElementById("footText");
  if (state.tool === "pin") {
    f.innerHTML = "<b>Pin mode</b> — click anywhere on the map to place a pin.";
    return;
  }
  if (state.tool === "item") {
    const lbl = state.pendingItem?.label || "item";
    f.innerHTML = `<b>Item mode</b> — click the map to place <b>${escapeHtml(lbl)}</b>.`;
    return;
  }
  if (state.tool === "polygon") {
    f.innerHTML =
      "<b>Draw mode</b> — click to add vertices, double-click to close.";
    return;
  }
  if (state.eraser || state.tool === "eraser") {
    f.innerHTML = "<b>Eraser on</b> — click any municipio to clear its region.";
    return;
  }
  if (state.selected) {
    const r = regionById(state.selected);
    if (r) {
      f.innerHTML = `Painting for <b style="color:${r.color}">${escapeHtml(r.name)}</b> — click municipios to assign.`;
      return;
    }
  }
  f.textContent = "Select a region to begin painting.";
}
let footTimer;
function flashFoot(msg) {
  const f = document.getElementById("footText");
  f.textContent = msg;
  clearTimeout(footTimer);
  footTimer = setTimeout(updateFoot, 1800);
}

/* ---------- export ---------- */
function exportRows() {
  return GEO.features.map((f) => {
    const fips = f.properties.fips,
      rid = state.assignments[fips],
      r = rid ? regionById(rid) : null;
    return { municipio: f.properties.name, fips, region: r ? r.name : "" };
  });
}
document.getElementById("csvBtn").addEventListener("click", () => {
  const rows = exportRows();
  const csv =
    "Municipio,FIPS,Region\n" +
    rows
      .map(
        (r) => `"${r.municipio}","${r.fips}","${r.region.replace(/"/g, '""')}"`,
      )
      .join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
  );
  a.download = "pr_municipality_regions.csv";
  a.click();
  toast("CSV downloaded");
});
document.getElementById("jsonBtn").addEventListener("click", async () => {
  const out = {
    regions: state.regions.map((r) => ({
      name: r.name,
      color: r.color,
      municipios: GEO.features
        .filter((f) => state.assignments[f.properties.fips] === r.id)
        .map((f) => f.properties.name),
    })),
    pins: state.pins,
    shapes: state.shapes.map((s) => ({
      label: s.label,
      color: s.color,
      points: s.points,
    })),
    coverage: exportRows(),
  };
  const txt = JSON.stringify(out, null, 2);
  try {
    await navigator.clipboard.writeText(txt);
    toast("JSON copied");
  } catch (e) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([txt], { type: "application/json" }));
    a.download = "pr_municipalities.json";
    a.click();
    toast("JSON downloaded");
  }
});

/* ---------- image export ---------- */
function exportImage(format, filename) {
  const svg = document.getElementById("map");
  const vb = svg.viewBox.baseVal;

  // Clone and set explicit dimensions so canvas knows the size
  const clone = svg.cloneNode(true);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", vb.width);
  clone.setAttribute("height", vb.height);
  clone.classList.remove("labels-always");

  // Background rect (replaces CSS var(--map-bg))
  const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("x", vb.x);
  bg.setAttribute("y", vb.y);
  bg.setAttribute("width", vb.width);
  bg.setAttribute("height", vb.height);
  bg.setAttribute("fill", "#eef1f6");
  clone.insertBefore(bg, clone.firstChild);

  // Inline fill for each municipality path (resolves CSS class + var(--land))
  const origByFips = {};
  svg
    .querySelectorAll("path.muni")
    .forEach((p) => (origByFips[p.dataset.fips] = p));
  clone.querySelectorAll("path.muni").forEach((p) => {
    const orig = origByFips[p.dataset.fips];
    p.style.fill = orig?.style.fill || "#d4dbe6";
    p.style.stroke = "#ffffff";
    p.style.strokeWidth = "0.9";
    p.style.strokeLinejoin = "round";
    p.removeAttribute("class");
  });

  // Label visibility: respect current toggles
  clone.querySelectorAll("text.muni-label").forEach((t) => {
    t.style.opacity = state.showLabels ? "1" : "0";
  });
  if (!state.showAnnoLabels) {
    clone.querySelectorAll("text.pin-label, text.shape-label").forEach((t) => {
      t.style.display = "none";
    });
  }

  // Drop in-progress drawing
  const dl = clone.querySelector("#drawing-layer");
  if (dl) dl.innerHTML = "";

  // Inject text styles so they survive SVG serialization (no CSS vars, no external sheet)
  const styleEl = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "style",
  );
  styleEl.textContent =
    "text{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;font-size:14px;font-weight:800;" +
    "fill:#111827;text-anchor:middle;dominant-baseline:central;" +
    "paint-order:stroke;stroke:rgba(255,255,255,0.92);stroke-width:6px;stroke-linejoin:round;}";
  clone.insertBefore(styleEl, clone.firstChild);

  const svgStr = new XMLSerializer().serializeToString(clone);
  const url = URL.createObjectURL(
    new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" }),
  );
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = vb.width;
    canvas.height = vb.height;
    const ctx = canvas.getContext("2d");
    if (format === "jpg") {
      ctx.fillStyle = "#eef1f6";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    const mime = format === "jpg" ? "image/jpeg" : "image/png";
    const a = document.createElement("a");
    a.href = canvas.toDataURL(mime, 0.92);
    a.download = filename;
    a.click();
    toast(`${format.toUpperCase()} downloaded`);
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    toast("Export failed — try a different browser");
  };
  img.src = url;
}
function doExportMap(filename) {
  const data = {
    version: 1,
    regions: state.regions,
    assignments: state.assignments,
    nextColorIdx,
    pins: state.pins,
    shapes: state.shapes,
    itemTypes: state.itemTypes,
    items: state.items,
    showLabels: state.showLabels,
    showAnnoLabels: state.showAnnoLabels,
    showRegionLabels: state.showRegionLabels,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast("Map exported");
}

/* ---------- export filename modal ---------- */
let _exportConfirmCb = null;
const exportModal = document.getElementById("exportModal");
const exportFileNameEl = document.getElementById("exportFileName");
const exportFileExtEl = document.getElementById("exportFileExt");

function openExportModal(title, suggestedName, ext, onConfirm) {
  document.getElementById("exportModalTitle").textContent = title;
  exportFileNameEl.value = suggestedName;
  exportFileExtEl.textContent = "." + ext;
  _exportConfirmCb = (name) => onConfirm(name + "." + ext);
  exportModal.classList.add("show");
  requestAnimationFrame(() => { exportFileNameEl.focus(); exportFileNameEl.select(); });
}
function closeExportModal() {
  exportModal.classList.remove("show");
  _exportConfirmCb = null;
}
document.getElementById("exportModalCancel").addEventListener("click", closeExportModal);
document.getElementById("exportModalConfirm").addEventListener("click", () => {
  const name = exportFileNameEl.value.trim();
  if (!name) return;
  const cb = _exportConfirmCb;
  closeExportModal();
  if (cb) cb(name);
});
exportFileNameEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("exportModalConfirm").click();
  if (e.key === "Escape") closeExportModal();
});
exportModal.addEventListener("click", (e) => { if (e.target === exportModal) closeExportModal(); });

document
  .getElementById("pngBtn")
  .addEventListener("click", () => {
    const base = mapFileName("png").slice(0, -4);
    openExportModal("Export as PNG", base, "png", (f) => exportImage("png", f));
  });
document
  .getElementById("jpgBtn")
  .addEventListener("click", () => {
    const base = mapFileName("jpg").slice(0, -4);
    openExportModal("Export as JPG", base, "jpg", (f) => exportImage("jpg", f));
  });

/* ---------- map export / import ---------- */
document.getElementById("exportMapBtn").addEventListener("click", () => {
  const base = mapFileName("emap").slice(0, -5);
  openExportModal("Export Map", base, "emap", (f) => doExportMap(f));
});

document.getElementById("importMapBtn").addEventListener("click", () => {
  document.getElementById("importFile").click();
});

document.getElementById("importFile").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const d = JSON.parse(ev.target.result);
      state.regions = d.regions || [];
      state.assignments = d.assignments || {};
      state.pins = d.pins || [];
      state.shapes = d.shapes || [];
      state.itemTypes = (d.itemTypes || []).map((t) => {
        if (t.dataUrl) cacheImage(t.id, t.dataUrl);
        return { ...t, dataUrl: t.dataUrl || getCachedImage(t.id) };
      });
      state.items = d.items || [];
      state.showLabels = d.showLabels || false;
      state.showAnnoLabels = d.showAnnoLabels !== false;
      state.showRegionLabels = d.showRegionLabels || false;
      nextColorIdx = d.nextColorIdx || state.regions.length;

      // Reset any active tool state
      state.selected = null;
      state.pendingItem = null;
      state.pendingItemId = null;
      state.tool = "paint";
      state.eraser = false;
      state.drawingShape = null;

      // Sync checkboxes
      document.getElementById("labelsAlways").checked = state.showLabels;
      document.getElementById("annoLabels").checked = state.showAnnoLabels;
      document.getElementById("regionLabels").checked = state.showRegionLabels;

      // Re-render everything
      paintMap(); renderList();
      renderPins(); renderPinList();
      renderShapes(); renderShapeList();
      renderItems(); renderItemList();
      updateCoverage();
      updateLabelVisibility();
      updateAnnoLabels();
      syncEraser();
      updateFoot();
      save();
      toast("Map imported");
    } catch {
      toast("Import failed — invalid file");
    }
    e.target.value = "";
  };
  reader.readAsText(file);
});

/* ---------- utils ---------- */
function mapFileName(ext) {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 5).replace(":", "");
  return `pr-map-${date}-${time}.${ext}`;
}
function escapeHtml(s) {
  return String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
}
const toastEl = document.getElementById("toast");
let toastTimer;
function toast(m) {
  toastEl.textContent = m;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1900);
}

/* ---------- init ---------- */
(async function init() {
  renderMap();
  const had = await load();
  if (!had || state.regions.length === 0) {
    ["Region A", "Region B", "Region C"].forEach((n, i) => {
      state.regions.push({ id: "r0" + i, name: n, color: PALETTE[i] });
    });
    nextColorIdx = 3;
    state.selected = "r00";
  } else {
    state.selected = state.regions[0]?.id || null;
  }
  document.getElementById("labelsAlways").checked = state.showLabels;
  document.getElementById("annoLabels").checked = state.showAnnoLabels;
  document.getElementById("regionLabels").checked = state.showRegionLabels;
  updateAnnoLabels();
  paintMap();
  renderList();
  renderPins();
  renderShapes();
  renderItems();
  renderPinList();
  renderShapeList();
  renderItemList();
  updateCoverage();
  syncEraser();
  updateFoot();
})();
