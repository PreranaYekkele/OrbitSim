// OrbitSim — UI + 3D rendering. Physics lives in physics.js.
import * as P from './physics.js';

const B = window.BABYLON;
const KM = 1 / 1000;                       // scene units per km (1 unit = 1000 km)
const COLORS = ['#ffb547', '#5ed3f3', '#ff7a9a', '#7cf2b4', '#b79bff', '#f4e76e', '#ff9f6b'];
const $ = (id) => document.getElementById(id);

const PRESETS = {
  iss:     { name: 'ISS',              peri: 415,   apo: 425,   inc: 51.6, raan: 30,  argp: 0,   nu: 0 },
  hubble:  { name: 'Hubble',           peri: 532,   apo: 538,   inc: 28.5, raan: 120, argp: 0,   nu: 40 },
  sso:     { name: 'Sun-sync',         peri: 700,   apo: 700,   inc: 98.2, raan: 200, argp: 0,   nu: 0 },
  gps:     { name: 'GPS',              peri: 20180, apo: 20180, inc: 55,   raan: 60,  argp: 0,   nu: 90 },
  geo:     { name: 'Geostationary',    peri: 35786, apo: 35786, inc: 0,    raan: 0,   argp: 0,   nu: 0 },
  molniya: { name: 'Molniya',          peri: 600,   apo: 39700, inc: 63.4, raan: 40,  argp: 270, nu: 0 },
};
const SITES = {
  ksc:        { name: 'Kennedy',     lat: 28.57, lon: -80.65 },
  shar:       { name: 'Sriharikota', lat: 13.72, lon: 80.23 },
  kourou:     { name: 'Kourou',      lat: 5.24,  lon: -52.77 },
  baikonur:   { name: 'Baikonur',    lat: 45.96, lon: 63.31 },
  vandenberg: { name: 'Vandenberg',  lat: 34.74, lon: -120.57 },
};

// ---------- state ----------
const state = {
  orbits: [],            // {id,name,color,el,line,sat,markers,visible}
  selected: null,
  running: true,
  warp: 100,
  simTime: 0,            // seconds since start
  scheduled: [],         // {orbitId, at, dv}
  showAxes: false,
  nextId: 1,
};

// ---------- conversions ----------
const toScene = (r) => new B.Vector3(r[0] * KM, r[2] * KM, r[1] * KM);   // ECI (z north) -> Babylon (y up)
const hex = (c) => B.Color3.FromHexString(c);
const fmt = (x, d = 0) => x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const deg = (r) => r / P.DEG;

function uiToElements(u) {
  const rp = P.R_EARTH + Math.min(u.peri, u.apo);
  const ra = P.R_EARTH + Math.max(u.peri, u.apo);
  return { a: (rp + ra) / 2, e: (ra - rp) / (ra + rp), i: u.inc * P.DEG, raan: u.raan * P.DEG, argp: u.argp * P.DEG, nu: u.nu * P.DEG };
}
function elementsToUi(el) {
  return {
    peri: P.periapsis(el.a, el.e) - P.R_EARTH, apo: P.apoapsis(el.a, el.e) - P.R_EARTH,
    inc: deg(el.i), raan: deg(el.raan), argp: deg(el.argp), nu: deg(el.nu),
  };
}

// ---------- scene ----------
const canvas = $('renderCanvas');
const engine = new B.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
const scene = new B.Scene(engine);
scene.clearColor = new B.Color4(0.027, 0.043, 0.122, 1);

const camera = new B.ArcRotateCamera('cam', -Math.PI / 2.4, Math.PI / 2.7, 62, B.Vector3.Zero(), scene);
camera.lowerRadiusLimit = 9; camera.upperRadiusLimit = 220; camera.wheelDeltaPercentage = 0.02; camera.minZ = 0.05;
camera.attachControl(canvas, true);

const sun = new B.DirectionalLight('sun', new B.Vector3(-1, -0.15, -0.35), scene);
sun.intensity = 1.6;
const fill = new B.HemisphericLight('fill', new B.Vector3(0, 1, 0), scene);
fill.intensity = 0.18; fill.groundColor = new B.Color3(0.05, 0.07, 0.18);

const glow = new B.GlowLayer('glow', scene, { blurKernelSize: 32 });
glow.intensity = 0.7;

// Earth
const R = P.R_EARTH * KM;
const earth = B.MeshBuilder.CreateSphere('earth', { diameter: 2 * R, segments: 64 }, scene);
const earthMat = new B.StandardMaterial('earthMat', scene);
earthMat.diffuseTexture = new B.Texture('assets/images/earth.jpg', scene);
earthMat.diffuseTexture.vScale = -1;  earthMat.diffuseTexture.uScale = -1;
earthMat.diffuseTexture.uOffset = 0.5;   // align texture longitude with the physics frame (verified against launch sites)
earthMat.specularColor = new B.Color3(0.12, 0.14, 0.2);
earth.material = earthMat;
glow.addExcludedMesh(earth);

// thin atmosphere rim: a slightly larger back-facing shell only shows around the limb
const atmo = B.MeshBuilder.CreateSphere('atmo', { diameter: 2 * R * 1.035, segments: 48, sideOrientation: B.Mesh.BACKSIDE }, scene);
const atmoMat = new B.StandardMaterial('atmoMat', scene);
atmoMat.emissiveColor = new B.Color3(0.35, 0.62, 1);
atmoMat.diffuseColor = B.Color3.Black(); atmoMat.specularColor = B.Color3.Black();
atmoMat.alpha = 0.14; atmoMat.disableLighting = true;
atmo.material = atmoMat; atmo.isPickable = false;
glow.addExcludedMesh(atmo);

// star field (fixed seed so it looks the same each load)
(function stars() {
  let s = 7; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const pcs = new B.PointsCloudSystem('stars', 2, scene);
  pcs.addPoints(2600, (p) => {
    const u = rnd() * 2 - 1, t = rnd() * Math.PI * 2, rr = 600;
    const q = Math.sqrt(1 - u * u);
    p.position = new B.Vector3(rr * q * Math.cos(t), rr * u, rr * q * Math.sin(t));
    const b = 0.45 + rnd() * 0.55, warm = rnd() < 0.15;
    p.color = new B.Color4(b, warm ? b * 0.85 : b, warm ? b * 0.7 : b, 1);
  });
  pcs.buildMeshAsync().then((m) => { m.isPickable = false; glow.addExcludedMesh(m); });
})();

// axes + equator (toggle)
const axesRoot = new B.TransformNode('axes', scene);
(function axes() {
  const L = 16;
  const mk = (pts, c) => { const l = B.MeshBuilder.CreateLines('ax', { points: pts }, scene); l.color = hex(c); l.alpha = 0.7; l.parent = axesRoot; glow.addExcludedMesh(l); };
  mk([B.Vector3.Zero(), new B.Vector3(L, 0, 0)], '#ff7a9a');                   // vernal equinox (x)
  mk([B.Vector3.Zero(), new B.Vector3(0, L, 0)], '#7cf2b4');                   // north pole (z)
  mk([B.Vector3.Zero(), new B.Vector3(0, 0, L)], '#5ed3f3');                   // y
  const eq = []; for (let k = 0; k <= 128; k++) { const a = (k / 128) * Math.PI * 2; eq.push(new B.Vector3(Math.cos(a) * R * 1.6, 0, Math.sin(a) * R * 1.6)); }
  mk(eq, '#9aa3cf');
  axesRoot.setEnabled(false);
})();

// launch-site marker (child of Earth so it rotates with it)
const siteMarker = B.MeshBuilder.CreateCylinder('site', { height: 0.5, diameterTop: 0, diameterBottom: 0.22, tessellation: 12 }, scene);
const siteMat = new B.StandardMaterial('siteMat', scene); siteMat.emissiveColor = hex('#ffb547'); siteMat.disableLighting = true;
siteMarker.material = siteMat; siteMarker.parent = earth; siteMarker.setEnabled(false);

// Earth rotation angle at sim time (rad). Babylon's left-handed y-rotation runs opposite to ECI's, hence the sign.
const earthAngle = () => P.OMEGA_EARTH * state.simTime;

// ---------- orbit objects ----------
function orbitPoints(el) {
  const pts = [];
  for (let k = 0; k <= 256; k++) pts.push(toScene(P.elementsToState({ ...el, nu: (k / 256) * Math.PI * 2 }).r));
  return pts;
}

function buildOrbitMeshes(o) {
  o.line?.dispose(); o.markers?.forEach((m) => m.dispose());
  o.line = B.MeshBuilder.CreateLines('orbit' + o.id, { points: orbitPoints(o.el) }, scene);
  o.line.color = hex(o.color); o.line.isPickable = false;
  // perigee / apogee markers
  const mk = (nu, size) => {
    const m = B.MeshBuilder.CreateSphere('mk', { diameter: size, segments: 8 }, scene);
    const mat = new B.StandardMaterial('mkm', scene); mat.emissiveColor = hex(o.color); mat.disableLighting = true; mat.alpha = 0.8;
    m.material = mat; m.position = toScene(P.elementsToState({ ...o.el, nu }).r); m.isPickable = false;
    glow.addExcludedMesh(m);
    return m;
  };
  o.markers = o.el.e > 0.01 ? [mk(0, 0.16), mk(Math.PI, 0.1)] : [];
  if (!o.sat) {
    o.sat = B.MeshBuilder.CreateSphere('sat' + o.id, { diameter: 0.32, segments: 12 }, scene);
    const m = new B.StandardMaterial('satm' + o.id, scene); m.emissiveColor = hex(o.color); m.disableLighting = true;
    o.sat.material = m; o.sat.metadata = { orbitId: o.id };
  }
  setVisible(o, o.visible);
  placeSat(o);
}
function placeSat(o) { o.sat.position = toScene(P.elementsToState(o.el).r); }
function setVisible(o, v) { o.visible = v; [o.line, o.sat, ...(o.markers || [])].forEach((m) => m && m.setEnabled(v)); }
function disposeOrbit(o) { o.line?.dispose(); o.sat?.dispose(); o.markers?.forEach((m) => m.dispose()); }

function addOrbit(name, el, { select = true } = {}) {
  const o = { id: state.nextId++, name: name || `Orbit ${state.nextId - 1}`, color: COLORS[(state.nextId - 2) % COLORS.length], el, visible: true };
  buildOrbitMeshes(o);
  state.orbits.push(o);
  if (select) selectOrbit(o.id); else renderList();
  return o;
}
function removeOrbit(id) {
  const o = state.orbits.find((x) => x.id === id); if (!o) return;
  disposeOrbit(o);
  state.orbits = state.orbits.filter((x) => x.id !== id);
  state.scheduled = state.scheduled.filter((s) => s.orbitId !== id);
  if (state.selected === id) selectOrbit(state.orbits.at(-1)?.id ?? null); else renderList();
}
const sel = () => state.orbits.find((o) => o.id === state.selected) || null;

function selectOrbit(id) {
  state.selected = id;
  const o = sel();
  state.orbits.forEach((x) => { if (x.line) x.line.alpha = !o || x.id === id ? 1 : 0.45; });
  syncEditor(); renderList(); updateBurnPreview(); updateHohPreview(); updateTelemetry();
}

// ---------- editor (Design tab) ----------
const SL = ['peri', 'apo', 'inc', 'raan', 'argp', 'nu'];
const SUFFIX = { peri: ' km', apo: ' km', inc: '°', raan: '°', argp: '°', nu: '°' };
let syncing = false;

function syncEditor() {
  const o = sel();
  const ed = $('editor');
  if (!o) { ed.setAttribute('data-disabled', ''); $('editingName').textContent = '—'; return; }
  ed.removeAttribute('data-disabled');
  $('editingName').textContent = o.name;
  const u = elementsToUi(o.el);
  syncing = true;
  for (const k of SL) { const inp = $(k); inp.value = u[k]; showSliderValue(k, u[k]); }
  syncing = false;
}
function showSliderValue(k, v) {
  document.querySelector(`.slider[data-key="${k}"] output`).textContent = fmt(+v, k === 'inc' ? 1 : 0) + SUFFIX[k];
}
SL.forEach((k) => $(k).addEventListener('input', () => {
  showSliderValue(k, $(k).value);
  if (syncing) return;
  const o = sel(); if (!o) return;
  const u = Object.fromEntries(SL.map((s) => [s, parseFloat($(s).value)]));
  o.el = uiToElements(u);
  buildOrbitMeshes(o); renderList(); updateTelemetry(); updateBurnPreview(); updateHohPreview();
}));

$('addOrbit').addEventListener('click', () => {
  const p = PRESETS[$('preset').value];
  const name = $('orbitName').value.trim() || uniqueName(p.name);
  addOrbit(name, uiToElements(p));
  $('orbitName').value = '';
  toast(`Added ${name}`);
});
const uniqueName = (base) => { let n = base, k = 2; while (state.orbits.some((o) => o.name === n)) n = `${base} ${k++}`; return n; };

function renderList() {
  const ul = $('orbitList'); ul.innerHTML = '';
  $('emptyList').hidden = state.orbits.length > 0;
  for (const o of state.orbits) {
    const li = document.createElement('li');
    li.tabIndex = 0; li.setAttribute('aria-current', String(o.id === state.selected));
    const u = elementsToUi(o.el);
    li.innerHTML = `<span class="dot" style="color:${o.color};background:${o.color}"></span><span class="nm"></span>
      <span class="meta">${fmt(u.peri)}×${fmt(u.apo)} km</span>
      <button class="x" aria-label="Hide or show">${o.visible ? '◉' : '○'}</button><button class="x" aria-label="Delete">✕</button>`;
    li.querySelector('.nm').textContent = o.name;
    const [vis, del] = li.querySelectorAll('button');
    vis.title = o.visible ? 'Hide' : 'Show'; del.title = 'Delete';
    vis.onclick = (e) => { e.stopPropagation(); setVisible(o, !o.visible); renderList(); };
    del.onclick = (e) => { e.stopPropagation(); removeOrbit(o.id); };
    li.onclick = () => selectOrbit(o.id);
    li.onkeydown = (e) => { if (e.key === 'Enter') selectOrbit(o.id); };
    ul.appendChild(li);
  }
  document.querySelectorAll('.selName').forEach((n) => (n.textContent = sel()?.name || 'the selected orbit'));
}

// ---------- telemetry ----------
let telTick = 0;
function updateTelemetry() {
  const o = sel();
  const h = $('telName'), dl = $('telData');
  if (!o) { h.textContent = 'No orbit selected'; dl.innerHTML = '<dt>Add or click an orbit to see its numbers.</dt>'; return; }
  const { r, v } = P.elementsToState(o.el);
  const rn = P.vec.norm(r), vn = P.vec.norm(v);
  const T = P.period(o.el.a);
  h.innerHTML = `<span class="dot" style="color:${o.color};background:${o.color}"></span>`; h.append(o.name);
  const rows = [
    ['Altitude', `${fmt(rn - P.R_EARTH)} km`, true],
    ['Speed', `${fmt(vn, 3)} km/s`, true],
    ['Period', fmtDuration(T)],
    ['Perigee', `${fmt(P.periapsis(o.el.a, o.el.e) - P.R_EARTH)} km`],
    ['Apogee', `${fmt(P.apoapsis(o.el.a, o.el.e) - P.R_EARTH)} km`],
    ['Semi-major axis a', `${fmt(o.el.a)} km`],
    ['Eccentricity e', fmt(o.el.e, 4)],
    ['Inclination i', `${fmt(deg(o.el.i), 2)}°`],
    ['Ascending node Ω', `${fmt(deg(o.el.raan), 1)}°`],
    ['Arg. of perigee ω', `${fmt(deg(o.el.argp), 1)}°`],
    ['True anomaly ν', `${fmt(deg(o.el.nu), 1)}°`],
    ['Specific energy', `${fmt(P.specificEnergy(o.el.a), 2)} km²/s²`],
  ];
  dl.innerHTML = rows.map(([k, val, big]) => `<dt>${k}</dt><dd${big ? ' class="big"' : ''}>${val}</dd>`).join('');
}
function fmtDuration(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = Math.round(s % 60);
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min ${String(ss).padStart(2, '0')} s`;
}

// ---------- manoeuvres ----------
const readDv = () => ({ prograde: (+$('dvPro').value || 0) / 1000, normal: (+$('dvNor').value || 0) / 1000, radial: (+$('dvRad').value || 0) / 1000 });
let ghost = null;
function updateBurnPreview() {
  const o = sel(), box = $('burnPreview');
  ghost?.dispose(); ghost = null;
  if (!o) { box.innerHTML = 'Select an orbit first.'; $('burnNow').disabled = true; return; }
  const dv = readDv();
  const mag = Math.hypot(dv.prograde, dv.normal, dv.radial) * 1000;
  const next = P.applyBurn(o.el, dv);
  const bad = P.validate(next);
  const pe = P.periapsis(next.a, next.e) - P.R_EARTH, ap = P.apoapsis(next.a, next.e) - P.R_EARTH;
  box.innerHTML = next.e >= 1 || !(next.a > 0)
    ? `<span class="warn">Δv ${fmt(mag)} m/s escapes Earth's gravity — the craft would leave orbit.</span>`
    : `After ${fmt(mag)} m/s: perigee ${fmt(pe)} km, apogee ${fmt(ap)} km, i ${fmt(deg(next.i), 2)}°, period ${fmtDuration(P.period(next.a))}` +
      (bad ? `<br><span class="warn">${bad}</span>` : '');
  $('burnNow').disabled = !!bad || mag === 0;
  if (!bad && mag > 0 && o.visible && !$('pane-burn').hidden) {
    ghost = B.MeshBuilder.CreateDashedLines('ghost', { points: orbitPoints(next), dashSize: 2, gapSize: 2, dashNb: 180 }, scene);
    ghost.color = hex('#ffffff'); ghost.alpha = 0.55; ghost.isPickable = false;
  }
}
['dvPro', 'dvNor', 'dvRad'].forEach((id) => $(id).addEventListener('input', updateBurnPreview));
$('burnNow').addEventListener('click', () => {
  const o = sel(); if (!o) return;
  o.el = P.applyBurn(o.el, readDv());
  buildOrbitMeshes(o); syncEditor(); renderList(); updateTelemetry(); updateBurnPreview();
  toast('Burn complete');
});

function updateHohPreview() {
  const o = sel(), box = $('hohPreview');
  if (!o) { box.innerHTML = 'Select an orbit first.'; $('hohGo').disabled = true; return; }
  const r1 = P.vec.norm(P.elementsToState(o.el).r);
  const r2 = P.R_EARTH + (+$('hohTarget').value || 0);
  const h = P.hohmann(r1, r2);
  const ok = r2 > P.R_EARTH + 150 && Math.abs(r2 - r1) > 1;
  box.innerHTML = ok
    ? `Burn 1: ${fmt(h.dv1 * 1000)} m/s now<br>Burn 2: ${fmt(h.dv2 * 1000)} m/s after ${fmtDuration(h.time)}<br><strong>Total Δv ${fmt(h.total * 1000)} m/s</strong>` +
      (o.el.e > 0.02 ? `<br><span class="warn">Works best from a near-circular orbit (e = ${fmt(o.el.e, 3)}).</span>` : '')
    : '<span class="warn">Pick a target altitude above 150 km that differs from the current one.</span>';
  $('hohGo').disabled = !ok;
}
$('hohTarget').addEventListener('input', updateHohPreview);
$('hohGo').addEventListener('click', () => {
  const o = sel(); if (!o) return;
  const r1 = P.vec.norm(P.elementsToState(o.el).r);
  const h = P.hohmann(r1, P.R_EARTH + (+$('hohTarget').value));
  o.el = P.applyBurn(o.el, { prograde: h.dv1 });
  state.scheduled.push({ orbitId: o.id, at: state.simTime + h.time, dv: { prograde: h.dv2 } });
  buildOrbitMeshes(o); syncEditor(); renderList(); updateTelemetry(); updateBurnPreview();
  toast(`Transfer started — second burn in ${fmtDuration(h.time)}`);
});

// ---------- launch ----------
function siteVector(site) {
  // surface point in ECI at current sim time
  const lat = site.lat * P.DEG, lon = site.lon * P.DEG + earthAngle();
  return [P.R_EARTH * Math.cos(lat) * Math.cos(lon), P.R_EARTH * Math.cos(lat) * Math.sin(lon), P.R_EARTH * Math.sin(lat)];
}
function placeSiteMarker() {
  const s = SITES[$('site').value];
  const lat = s.lat * P.DEG, lon = s.lon * P.DEG;
  // local (body-fixed) position, mapped to Babylon axes; the marker inherits Earth's rotation
  const local = new B.Vector3(R * Math.cos(lat) * Math.cos(lon), R * Math.sin(lat), R * Math.cos(lat) * Math.sin(lon));
  siteMarker.position = local.scale(1.02);
  const up = local.normalize();
  siteMarker.rotationQuaternion = B.Quaternion.FromUnitVectorsToRef(B.Vector3.Up(), up, new B.Quaternion());
  siteMarker.setEnabled(true);
}
function updateLaunchReadout() {
  const s = SITES[$('site').value];
  const inc = +$('lInc').value, alt = +$('lAlt').value;
  const minI = P.minInclination(s.lat);
  const effI = Math.max(inc, minI);
  const az = P.launchAzimuth(s.lat, effI);
  const boost = P.rotationalBoost(s.lat) * 1000;
  const vOrbit = P.visViva(P.R_EARTH + alt, P.R_EARTH + alt) * 1000;
  const gain = boost * Math.sin(az * P.DEG);
  $('launchReadout').innerHTML = [
    ['Latitude', `${fmt(s.lat, 2)}°`],
    ['Earth-rotation boost', `${fmt(boost)} m/s`],
    ['Lowest direct inclination', `${fmt(minI, 1)}°`],
    ['Launch azimuth', Number.isNaN(az) ? '—' : `${fmt(az, 1)}° from north`],
    ['Orbital speed needed', `${fmt(vOrbit)} m/s`],
    ['Saved by the boost', `${fmt(gain)} m/s`],
  ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('') +
    (inc < minI ? `<dt class="warn" style="grid-column:1/-1;color:var(--alert)">${s.name} can't reach ${fmt(inc, 1)}° directly — it will launch to ${fmt(minI, 1)}°.</dt>` : '');
  placeSiteMarker();
}
['site', 'lInc', 'lAlt'].forEach((id) => $(id).addEventListener('input', updateLaunchReadout));
$('launchGo').addEventListener('click', () => {
  const s = SITES[$('site').value];
  const alt = Math.max(200, +$('lAlt').value);
  const i = Math.max(+$('lInc').value, P.minInclination(s.lat)) * P.DEG;
  // circular orbit whose ground track passes over the site right now, heading north-east
  const rs = siteVector(s);
  const lat = Math.asin(rs[2] / P.R_EARTH), lonI = Math.atan2(rs[1], rs[0]);
  const u = Math.asin(Math.min(1, Math.sin(lat) / Math.sin(i)));            // argument of latitude at the site
  const dLon = Math.atan2(Math.cos(i) * Math.sin(u), Math.cos(u));
  const el = { a: P.R_EARTH + alt, e: 0, i, raan: P.wrap2pi(lonI - dLon), argp: 0, nu: u };
  const o = addOrbit(uniqueName(`${s.name} launch`), el);
  toast(`Launched ${o.name} into a ${fmt(alt)} km orbit`);
});

// ---------- tabs ----------
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
  document.querySelectorAll('.pane').forEach((p) => (p.hidden = p.id !== 'pane-' + t.dataset.tab));
  siteMarker.setEnabled(t.dataset.tab === 'launch');
  if (t.dataset.tab === 'launch') updateLaunchReadout();
  if (t.dataset.tab !== 'burn') { ghost?.dispose(); ghost = null; } else updateBurnPreview();
}));

// ---------- time bar ----------
function setRunning(v) {
  state.running = v;
  $('playPause').textContent = v ? '❚❚' : '▶';
  $('playPause').setAttribute('aria-label', v ? 'Pause simulation' : 'Resume simulation');
}
$('playPause').onclick = () => setRunning(!state.running);
function setWarp(w) { state.warp = w; document.querySelectorAll('.warp button').forEach((b) => b.classList.toggle('on', +b.dataset.warp === w)); }
document.querySelectorAll('.warp button').forEach((b) => (b.onclick = () => setWarp(+b.dataset.warp)));
function toggleAxes() { state.showAxes = !state.showAxes; axesRoot.setEnabled(state.showAxes); $('toggleAxes').classList.toggle('on', state.showAxes); }
$('toggleAxes').onclick = toggleAxes;
$('reset').onclick = () => { state.orbits.slice().forEach((o) => removeOrbit(o.id)); state.simTime = 0; history.replaceState(null, '', location.pathname); toast('All orbits removed'); };
$('help').onclick = () => $('helpDialog').showModal();
$('share').onclick = async () => {
  const data = state.orbits.map((o) => [o.name, ...['a', 'e', 'i', 'raan', 'argp', 'nu'].map((k) => +o.el[k].toFixed(6))]);
  const url = `${location.origin}${location.pathname}#o=${encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(data)))))}`;
  history.replaceState(null, '', url);
  try { await navigator.clipboard.writeText(url); toast('Link copied — it recreates these orbits'); }
  catch { toast('Link is in the address bar'); }
};
function loadFromHash() {
  const m = location.hash.match(/#o=(.+)/); if (!m) return false;
  try {
    const data = JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(m[1])))));
    data.forEach(([name, a, e, i, raan, argp, nu]) => { const el = { a, e, i, raan, argp, nu }; if (!P.validate(el)) addOrbit(String(name).slice(0, 24), el, { select: false }); });
    if (state.orbits.length) selectOrbit(state.orbits[0].id);
    return state.orbits.length > 0;
  } catch { return false; }
}
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); setRunning(!state.running); }
  const warps = { Digit1: 1, Digit2: 10, Digit3: 100, Digit4: 1000, Digit5: 10000 };
  if (warps[e.code]) setWarp(warps[e.code]);
  if (e.key === 'a' || e.key === 'A') toggleAxes();
  if (e.key === 'h' || e.key === 'H') $('helpDialog').showModal();
});

let toastTimer;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2600); }

// click a satellite in 3D to select it
scene.onPointerObservable.add((pi) => {
  if (pi.type !== B.PointerEventTypes.POINTERTAP) return;
  const id = pi.pickInfo?.pickedMesh?.metadata?.orbitId; if (id) selectOrbit(id);
});

// ---------- main loop ----------
function fmtClock(t) {
  const d = Math.floor(t / 86400), h = Math.floor((t % 86400) / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  return `T+ ${d} d ${[h, m, s].map((x) => String(x).padStart(2, '0')).join(':')}`;
}
engine.runRenderLoop(() => {
  const dtReal = Math.min(engine.getDeltaTime() / 1000, 0.1);
  if (state.running) {
    const dt = dtReal * state.warp;
    const t0 = state.simTime, t1 = t0 + dt;
    for (const o of state.orbits) {
      // propagate exactly to any burn that falls inside this frame, so burns fire at the right point
      let t = t0;
      const due = state.scheduled.filter((s) => s.orbitId === o.id && s.at <= t1).sort((a, b) => a.at - b.at);
      for (const s of due) {
        o.el = P.propagate(o.el, Math.max(0, s.at - t)); t = Math.max(t, s.at);
        o.el = P.applyBurn(o.el, s.dv); s.done = true;
        buildOrbitMeshes(o); renderList(); toast(`${o.name}: circularisation burn complete`);
        if (o.id === state.selected) { syncEditor(); updateBurnPreview(); updateHohPreview(); }
      }
      o.el = P.propagate(o.el, t1 - t);
      placeSat(o);
    }
    state.scheduled = state.scheduled.filter((x) => !x.done);
    state.simTime = t1;
    earth.rotation.y = -earthAngle();
    $('clock').textContent = fmtClock(state.simTime);
    if (++telTick % 12 === 0) updateTelemetry();
  }
  // floating label next to the selected satellite
  const o = sel(), tag = $('satTag');
  if (o && o.visible) {
    const p = B.Vector3.Project(o.sat.position, B.Matrix.Identity(), scene.getTransformMatrix(), camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight()));
    const k = canvas.clientWidth / engine.getRenderWidth();
    tag.hidden = p.z < 0 || p.z > 1; tag.style.left = p.x * k + 'px'; tag.style.top = p.y * k + 'px'; tag.textContent = o.name;
  } else tag.hidden = true;
  scene.render();
});
window.addEventListener('resize', () => engine.resize());

// ---------- start ----------
if (!loadFromHash()) {
  addOrbit('ISS', uiToElements(PRESETS.iss), { select: false });
  addOrbit('Molniya', uiToElements(PRESETS.molniya), { select: false });
  addOrbit('GPS', uiToElements(PRESETS.gps));
}
updateLaunchReadout(); siteMarker.setEnabled(false);
setWarp(100);

// exposed for automated tests
window.__orbitsim = { state, P, addOrbit, selectOrbit, removeOrbit };
