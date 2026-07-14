/* Zurich Underground Trains AR — prototype
 * Data: OpenStreetMap (tunnel geometry, ODbL) + transport.opendata.ch (real-time timetable)
 * Trains are interpolated along tunnel centerlines between their timed stops.
 */
'use strict';

// ---------------------------------------------------------------- config ---

// Corridor metadata; geometry + per-point depths come from tunnels.js (built by
// build_data.py). A/B are stop-name prefixes matched against adjacent passList
// pairs; B may list stations beyond the corridor for trains that pass its end
// without stopping (position is then scaled by estimated leg length).
const CORRIDOR_CFG = {
  'weinberg':       { label: 'Weinberg', color: '#4dd2ff',
                      A: ['Zürich HB'], B: ['Zürich Oerlikon', 'Zürich Flughafen'] },
  'hirschengraben': { label: 'Hirschengraben', color: '#ffd166',
                      A: ['Zürich HB'], B: ['Zürich Stadelhofen'] },
  'zuerichberg':    { label: 'Zürichberg', color: '#c792ea',
                      A: ['Zürich Stadelhofen'],
                      B: ['Stettbach', 'Dübendorf', 'Dietlikon', 'Uster', 'Wallisellen', 'Winterthur'] },
  'wipkingen-a':    { label: 'Wipkingen line', color: '#7ce38b',
                      A: ['Zürich HB'], B: ['Zürich Wipkingen'] },
  'wipkingen-b':    { label: 'Wipkingen tunnel', color: '#7ce38b',
                      A: ['Zürich Wipkingen'], B: ['Zürich Oerlikon'] },
  'kaeferberg':     { label: 'Käferberg', color: '#ff9e64',
                      A: ['Zürich Hardbrücke'], B: ['Zürich Oerlikon', 'Zürich Flughafen'] },
  'ulmberg-a':      { label: 'HB–Wiedikon', color: '#5ee6c0',
                      A: ['Zürich HB'], B: ['Zürich Wiedikon'] },
  'ulmberg-b':      { label: 'Ulmberg', color: '#5ee6c0',
                      A: ['Zürich Wiedikon'], B: ['Zürich Enge'] },
  'enge':           { label: 'Enge', color: '#5ee6c0',
                      A: ['Zürich Enge'],
                      B: ['Zürich Wollishofen', 'Kilchberg', 'Rüschlikon', 'Thalwil'] },
  'riesbach':       { label: 'Riesbach', color: '#ff7ad9',
                      A: ['Zürich Stadelhofen'],
                      B: ['Zürich Tiefenbrunnen', 'Küsnacht ZH', 'Erlenbach ZH', 'Herrliberg', 'Meilen'] },
  'szu-a':          { label: 'SZU', color: '#9fb4ff',
                      A: ['Zürich HB'], B: ['Zürich Selnau'] },
  'szu-b':          { label: 'SZU', color: '#9fb4ff',
                      A: ['Zürich Selnau'],
                      B: ['Zürich Giesshübel', 'Zürich Binz', 'Zürich Saalsporthalle', 'Zürich Brunau'] },
  'tram-a':         { label: 'Tram tunnel', color: '#ff6b6b',
                      A: ['Zürich, Milchbuck'], B: ['Zürich, Tierspital'] },
  'tram-b':         { label: 'Tram tunnel', color: '#ff6b6b',
                      A: ['Zürich, Tierspital'], B: ['Zürich, Waldgarten'] },
  'tram-c':         { label: 'Tram tunnel', color: '#ff6b6b',
                      A: ['Zürich, Waldgarten'], B: ['Zürich, Ueberlandpark'] },
  'tram-d':         { label: 'Tram tunnel', color: '#ff6b6b',
                      A: ['Zürich, Ueberlandpark'], B: ['Zürich, Schwamendingerplatz'] },
};

const BOARDS = [
  { query: 'Zürich HB', limit: 40 },
  { query: 'Zürich HB SZU', limit: 10 },   // SZU deep station has its own id — S4/S10
                                           // departures never show on the main HB board
  { query: 'Zürich Stadelhofen', limit: 20 },
  { query: 'Zürich Oerlikon', limit: 20 },
  { query: 'Stettbach', limit: 15 },
  { query: 'Zürich Flughafen', limit: 15 },  // inbound Weinberg trains that skip Oerlikon
  { query: 'Uster', limit: 12 },             // inbound Zürichberg trains that skip Stettbach (S15)
  { query: 'Zürich Hardbrücke', limit: 15 },
  { query: 'Zürich Enge', limit: 12 },
  { query: 'Zürich Wollishofen', limit: 10 },
  { query: 'Zürich Tiefenbrunnen', limit: 10 },
  { query: 'Zürich Selnau', limit: 10 },
  { query: 'Zürich Giesshübel', limit: 10 },
  { query: 'Zürich, Milchbuck', limit: 15 },
  { query: 'Zürich, Schwamendingerplatz', limit: 15 },
];

// Compass calibration targets: prominent, street-visible Zurich landmarks.
// h = approximate height of the visual target above local street level, m
// (Uetliberg tower tip includes the hill: ~1055 m a.s.l. vs ~410 m in the city).
const LANDMARKS = [
  { name: 'Prime Tower',        lon: 8.51765, lat: 47.38647, h: 126 },
  { name: 'Uetliberg TV tower', lon: 8.49026, lat: 47.34946, h: 620 },
  { name: 'Grossmünster',       lon: 8.54402, lat: 47.37039, h: 55 },
  { name: 'Fraumünster spire',  lon: 8.54127, lat: 47.36970, h: 70 },
  { name: 'St. Peter clock',    lon: 8.54051, lat: 47.37079, h: 55 },
  { name: 'Predigerkirche',     lon: 8.54453, lat: 47.37447, h: 90 },
  { name: 'HB main hall',       lon: 8.54040, lat: 47.37786, h: 22 },
  { name: 'Swissôtel Oerlikon', lon: 8.54446, lat: 47.41134, h: 60 },
];

const REFRESH_MS = 150 * 1000;         // 15 boards per cycle — stay inside API rate limits
const LEG_LENGTH_FUDGE = 1.25;         // straight-line -> track-length estimate for legs
                                       // extending beyond the tunnel
const DEFAULT_POS = { lat: 47.37770, lon: 8.54385 };  // Central, Zurich — fallback/desktop

// ------------------------------------------------------------- geo utils ---

const M_PER_DEG_LAT = 110540;
function mPerDegLon(lat) { return 111320 * Math.cos(lat * Math.PI / 180); }

function geoDist(a, b) { // [lon,lat] pairs -> meters
  const dx = (a[0] - b[0]) * mPerDegLon((a[1] + b[1]) / 2);
  const dy = (a[1] - b[1]) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

// Merge corridor metadata with generated geometry; precompute cumulative distances
const CORRIDORS = {};
for (const [key, cfg] of Object.entries(CORRIDOR_CFG)) {
  const data = TUNNEL_DATA.corridors[key];
  if (!data) continue;
  const cum = [0];
  for (let i = 1; i < data.path.length; i++) {
    cum.push(cum[i - 1] + geoDist(data.path[i - 1], data.path[i]));
  }
  CORRIDORS[key] = { ...cfg, path: data.path, depths: data.depths, cum, length: cum[cum.length - 1] };
}

function pointAtDistance(c, s) { // corridor, meters from A -> {lon, lat, frac, bearing, depth}
  const { path, cum, depths, length } = c;
  s = Math.max(0, Math.min(length, s));
  let i = 1;
  while (i < cum.length - 1 && cum[i] < s) i++;
  const t = (s - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
  const lon = path[i - 1][0] + t * (path[i][0] - path[i - 1][0]);
  const lat = path[i - 1][1] + t * (path[i][1] - path[i - 1][1]);
  const bearing = Math.atan2(
    (path[i][0] - path[i - 1][0]) * mPerDegLon(lat),
    (path[i][1] - path[i - 1][1]) * M_PER_DEG_LAT);
  const depth = depths[i - 1] + t * (depths[i] - depths[i - 1]);
  return { lon, lat, frac: s / length, bearing, depth };
}

// ----------------------------------------------------------- train engine ---

const trains = new Map();   // key -> train
let lastFetch = 0;
let fetchError = null;

function stopTime(p, kind) { // kind: 'departure' | 'arrival'
  const prog = p.prognosis && p.prognosis[kind];
  if (prog) { const t = Date.parse(prog); if (!isNaN(t)) return t; }
  const ts = p[kind + 'Timestamp'];
  return ts ? ts * 1000 : null;
}

function schedTime(p, kind) { // scheduled time, ignoring delay prognosis — stable across polls
  const ts = p[kind + 'Timestamp'];
  return ts ? ts * 1000 : null;
}

function nameMatches(name, list) {
  return !!name && list.some(x => name.startsWith(x));
}

function lineBadge(j) {
  const cat = j.category || '';
  const num = j.number || '';
  if (cat === 'S') return 'S' + num;
  if (cat === 'T') return 'Tram ' + num;
  if (num && num.length <= 3) return cat + num;
  return cat || (j.name || '?');
}

async function fetchBoard(query, limit, type, found) {
  const url = 'https://transport.opendata.ch/v1/stationboard?station=' +
    encodeURIComponent(query) + '&limit=' + limit + '&type=' + type;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const data = await res.json();
  const boardStation = data.station && data.station.name;
  const boardCoord = data.station && data.station.coordinate;
  for (const j of (data.stationboard || [])) {
    // The queried station's own passList entry has null name/coordinate.
    // Stations the train passes WITHOUT stopping appear with null times — drop
    // them, so the timed stops around them still form an adjacent pair (their
    // extra track length is covered by the LEG_LENGTH_FUDGE estimate).
    const stops = (j.passList || []).map(p => ({
      name: (p.station && p.station.name) || boardStation,
      coord: (p.station && p.station.name ? p.station.coordinate : boardCoord), // x = lat, y = lon
      dep: stopTime(p, 'departure'),
      arr: stopTime(p, 'arrival'),
      schedDep: schedTime(p, 'departure'),
    })).filter(s => s.dep || s.arr);
    for (let i = 0; i + 1 < stops.length; i++) {
      const s1 = stops[i], s2 = stops[i + 1];
      if (!s1.dep || !s2.arr || s2.arr <= s1.dep) continue;
      for (const [cname, c] of Object.entries(CORRIDORS)) {
        let dir = null;
        if (nameMatches(s1.name, c.A) && nameMatches(s2.name, c.B)) dir = 'AB';
        else if (nameMatches(s1.name, c.B) && nameMatches(s2.name, c.A)) dir = 'BA';
        if (!dir) continue;
        let legLen = c.length;
        if (s1.coord && s2.coord &&
            typeof s1.coord.x === 'number' && typeof s2.coord.x === 'number' &&
            typeof s1.coord.y === 'number' && typeof s2.coord.y === 'number') {
          const straight = geoDist([s1.coord.y, s1.coord.x], [s2.coord.y, s2.coord.x]);
          if (isFinite(straight) && straight < 60000) {
            legLen = Math.max(c.length, straight * LEG_LENGTH_FUDGE);
          }
        }
        // key from the SCHEDULED departure so a changing delay prognosis
        // updates the existing train instead of duplicating it
        const key = [lineBadge(j), j.to, cname, dir,
                     Math.round((s1.schedDep || s1.dep) / 60000)].join('|');
        found.set(key, {
          key, badge: lineBadge(j), to: j.to, corridor: cname, dir,
          dep: s1.dep, arr: s2.arr, legLen,
          fromName: s1.name, toName: s2.name,
        });
      }
    }
  }
}

async function fetchBoards() {
  console.log('[fetchBoards] start', new Date().toISOString());
  // Boards only list FUTURE departures: a train disappears from the HB board the
  // moment it leaves HB and enters the tunnel. So legs are captured in advance,
  // merged into `trains`, and kept until they expire. That cache is empty on
  // startup, though — so while it is, also poll ARRIVAL boards, whose passLists
  // include the (past) departure times of trains already en route.
  const found = new Map();
  const jobs = [];
  for (const b of BOARDS) jobs.push(['departure', b]);
  if (!trains.size) for (const b of BOARDS) jobs.push(['arrival', b]);
  await Promise.all(jobs.map(([type, b]) =>
    fetchBoard(b.query, b.limit, type, found)
      .catch(e => { fetchError = e.message || String(e); })));
  const now = Date.now();
  for (const [k, v] of found) trains.set(k, v);       // add/refresh (updates prognosis)
  for (const [k, v] of trains) {
    if (v.arr < now - 5 * 60 * 1000) trains.delete(k); // expire finished legs
  }
  if (found.size) fetchError = null;
  lastFetch = now;
  console.log('[fetchBoards] done, legs:', trains.size, 'err:', fetchError);
}

// Ease: trains accelerate out of one stop and brake into the next
function easeInOut(f) { return (1 - Math.cos(Math.PI * f)) / 2; }

function activeTrains(now) {
  const out = [];
  for (const t of trains.values()) {
    const f = (now - t.dep) / (t.arr - t.dep);
    if (f <= 0 || f >= 1) continue;
    const c = CORRIDORS[t.corridor];
    const s = easeInOut(f) * t.legLen;              // meters travelled along the leg
    // Corridor occupies the A-side end of the leg. AB: corridor first, BA: corridor last.
    const distAlong = t.dir === 'AB' ? s : t.legLen - s;
    if (distAlong < 0 || distAlong > c.length) continue;
    const p = pointAtDistance(c, distAlong);
    out.push({
      ...t, lon: p.lon, lat: p.lat, frac: p.frac,
      bearing: p.bearing + (t.dir === 'BA' ? Math.PI : 0),
      depth: p.depth,
      color: c.color, label: c.label, progress: f,
    });
  }
  return out;
}

// ------------------------------------------------------------------- UI ----

const $ = id => document.getElementById(id);
const statusEl = $('status'), trainlistEl = $('trainlist');
let mode = null; // 'map' | 'ar'
let userPos = { ...DEFAULT_POS, acc: null, real: false };
let headingSource = '—';

function setStatus() {
  const age = lastFetch ? Math.round((Date.now() - lastFetch) / 1000) : null;
  const gps = userPos.real
    ? `<span class="ok">GPS ±${Math.round(userPos.acc || 0)} m</span>`
    : `<span class="warn">GPS: simulated (Central)</span>`;
  const data = fetchError
    ? `<span class="err">data error: ${fetchError}</span>`
    : age === null ? 'loading trains…' : `data ${age}s old`;
  statusEl.innerHTML = `${gps} · heading: ${headingSource}<br>${data}`;
}

function renderTrainList(list) {
  list.sort((a, b) => a.corridor.localeCompare(b.corridor) || a.progress - b.progress);
  trainlistEl.innerHTML = list.map(t => `
    <div class="train-row">
      <span class="train-badge" style="background:${t.color}">${t.badge}</span>
      <span>→ ${t.to}</span>
      <span class="train-sub">${t.label} · ${Math.round(t.frac * 100)}% · ${Math.round(t.depth)} m</span>
    </div>`).join('') ||
    '<div class="train-row"><span class="train-sub">no trains in the tunnels right now — next ones appear automatically</span></div>';
}

// ------------------------------------------------------------- map mode ----

let map, trainMarkers = new Map();

// Split a corridor into runs of consecutive tunnel / surface segments
function corridorRuns(c) {
  const runs = [];
  let cur = null;
  for (let i = 0; i + 1 < c.path.length; i++) {
    const tunnel = c.depths[i] < 0 || c.depths[i + 1] < 0;
    if (!cur || cur.tunnel !== tunnel) {
      cur = { tunnel, from: i, to: i + 1 };
      runs.push(cur);
    } else cur.to = i + 1;
  }
  return runs;
}

function initMap() {
  if (map) return;
  map = L.map('map', { zoomControl: false }).setView([47.383, 8.548], 14);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap, &copy; CARTO', maxZoom: 19,
  }).addTo(map);

  for (const w of TUNNEL_DATA.render) {
    L.polyline(w.pts.map(p => [p[1], p[0]]),
      { color: '#888', weight: 2, opacity: 0.4, dashArray: '4 6' }
    ).addTo(map).bindTooltip(w.name || 'rail tunnel');
  }
  for (const c of Object.values(CORRIDORS)) {
    for (const r of corridorRuns(c)) {
      const latlngs = c.path.slice(r.from, r.to + 1).map(p => [p[1], p[0]]);
      L.polyline(latlngs, r.tunnel
        ? { color: c.color, weight: 4, opacity: 0.85 }
        : { color: c.color, weight: 2.5, opacity: 0.5, dashArray: '2 7' }
      ).addTo(map).bindTooltip(c.label + (r.tunnel ? ' (tunnel)' : ' (surface)'));
    }
  }
  for (const [name, [lon, lat]] of Object.entries(TUNNEL_DATA.stations)) {
    L.circleMarker([lat, lon], { radius: 5, color: '#fff', fillColor: '#222', fillOpacity: 1 })
      .addTo(map).bindTooltip(name, { permanent: true, direction: 'top', className: 'stn-label' });
  }
}

function updateMap(list) {
  const seen = new Set();
  for (const t of list) {
    seen.add(t.key);
    let m = trainMarkers.get(t.key);
    if (!m) {
      m = L.marker([t.lat, t.lon], {
        icon: L.divIcon({
          className: '',
          html: `<div style="background:${t.color};color:#001;font-weight:700;font-size:11px;` +
                `padding:2px 6px;border-radius:5px;white-space:nowrap;box-shadow:0 0 8px ${t.color}">` +
                `${t.badge} → ${t.to}</div>`,
          iconAnchor: [20, 10],
        }),
      }).addTo(map);
      trainMarkers.set(t.key, m);
    }
    m.setLatLng([t.lat, t.lon]);
  }
  for (const [k, m] of trainMarkers) {
    if (!seen.has(k)) { map.removeLayer(m); trainMarkers.delete(k); }
  }
}

// -------------------------------------------------------------- AR mode ----

let renderer, scene, camera, arBuilt = false;
let origin = null;            // {lat, lon} of ENU origin
let yawOffset = 0;            // manual compass calibration, radians
let pitchOffset = 0;
let deviceQuat = null;        // from sensors
let mouseLook = { yaw: 0, pitch: -0.5, active: false };
let hasSensors = false;
const trainMeshes = new Map();

function toENU(lon, lat) {
  return {
    x: (lon - origin.lon) * mPerDegLon(origin.lat),
    z: -((lat - origin.lat) * M_PER_DEG_LAT),
  };
}

function buildARScene() {
  if (arBuilt) return;
  arBuilt = true;
  origin = { lat: userPos.lat, lon: userPos.lon };
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.1, 8000);
  renderer = new THREE.WebGLRenderer({ canvas: $('ar-canvas'), alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);

  // corridors: tunnel runs as glowing tubes, surface runs as thin ground lines
  for (const c of Object.values(CORRIDORS)) {
    const pts3 = c.path.map((p, i) => {
      const e = toENU(p[0], p[1]);
      return new THREE.Vector3(e.x, Math.min(c.depths[i], -1.2), e.z);
    });
    for (const r of corridorRuns(c)) {
      const seg = pts3.slice(r.from, r.to + 1);
      if (r.tunnel && seg.length > 1) {
        const tube = new THREE.Mesh(
          new THREE.TubeGeometry(new THREE.CatmullRomCurve3(seg), Math.max(8, seg.length * 2), 4, 8, false),
          new THREE.MeshBasicMaterial({ color: c.color, transparent: true, opacity: 0.28, depthTest: false }));
        tube.renderOrder = 1;
        scene.add(tube);
      }
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(seg),
        new THREE.LineBasicMaterial({ color: c.color, transparent: true,
          opacity: r.tunnel ? 0.9 : 0.4, depthTest: false }));
      line.renderOrder = 2;
      scene.add(line);
    }
  }
  // other tunnels, faint
  for (const w of TUNNEL_DATA.render) {
    if (CORRIDORS[w.name]) continue;
    const pts = w.pts.map(p => { const e = toENU(p[0], p[1]); return new THREE.Vector3(e.x, 15 * w.layer, e.z); });
    scene.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0x666666, transparent: true, opacity: 0.3, depthTest: false })));
  }
  buildLandmarks();
}

// landmark pillars: faint reference columns, highlighted while aligning
const landmarkMeshes = new Map();  // name -> {pillar, label}
function buildLandmarks() {
  for (const lm of LANDMARKS) {
    const e = toENU(lm.lon, lm.lat);
    const g = new THREE.Group();
    g.position.set(e.x, 0, e.z);
    const pillar = new THREE.Mesh(
      new THREE.CylinderGeometry(2.5, 2.5, lm.h, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, depthTest: false }));
    pillar.position.y = lm.h / 2;
    pillar.renderOrder = 2;
    g.add(pillar);
    const label = makeLabelSprite(lm.name, '#ffffff', 2);
    label.position.y = lm.h + 25;
    label.visible = false;   // only shown while aligning
    g.add(label);
    scene.add(g);
    landmarkMeshes.set(lm.name, { pillar, label });
  }
}

function makeLabelSprite(text, color, scale = 1) {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 128;
  const cx = cv.getContext('2d');
  cx.fillStyle = 'rgba(0,0,0,0.65)';
  cx.beginPath(); cx.roundRect(0, 14, 512, 100, 24); cx.fill();
  cx.fillStyle = color;
  cx.font = 'bold 64px -apple-system, Arial';
  cx.textBaseline = 'middle';
  cx.fillText(text.slice(0, 20), 24, 66);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(cv), transparent: true, depthTest: false }));
  sp.scale.set(60 * scale, 15 * scale, 1);
  sp.renderOrder = 5;
  return sp;
}

function trainMesh(t) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(4.5, 5, 100),
    new THREE.MeshBasicMaterial({ color: t.color, transparent: true, opacity: 0.95, depthTest: false }));
  body.renderOrder = 3;
  g.add(body);
  // beacon: vertical line + ring at ground level so you can spot it under the street
  const beaconGeo = new THREE.BufferGeometry().setFromPoints(
    [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 200, 0)]);
  const beacon = new THREE.Line(beaconGeo,
    new THREE.LineBasicMaterial({ color: t.color, transparent: true, opacity: 0.5, depthTest: false }));
  beacon.renderOrder = 3;
  g.add(beacon);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(6, 8, 32),
    new THREE.MeshBasicMaterial({ color: t.color, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthTest: false }));
  ring.rotation.x = -Math.PI / 2;
  ring.renderOrder = 4;
  g.add(ring);
  g.userData.ring = ring;
  const label = makeLabelSprite(`${t.badge} → ${t.to}`, t.color);
  label.position.y = 18;
  g.add(label);
  return g;
}

function updateAR(list, now) {
  const seen = new Set();
  for (const t of list) {
    seen.add(t.key);
    let m = trainMeshes.get(t.key);
    if (!m) { m = trainMesh(t); trainMeshes.set(t.key, m); scene.add(m); }
    const e = toENU(t.lon, t.lat);
    const y = Math.min(t.depth, -1.4);
    m.position.set(e.x, y, e.z);
    m.rotation.y = -t.bearing;             // bearing: cw from north; three yaw: ccw
    m.userData.ring.visible = t.depth < -4;        // ring at street level, only when underground
    m.userData.ring.position.y = -y - 1.4;
    const pulse = 1 + 0.25 * Math.sin(now / 300);
    m.userData.ring.scale.set(pulse, pulse, 1);
  }
  for (const [k, m] of trainMeshes) {
    if (!seen.has(k)) { scene.remove(m); trainMeshes.delete(k); }
  }
  // camera
  const ue = toENU(userPos.lon, userPos.lat);
  camera.position.set(ue.x, 0, ue.z);
  if (deviceQuat) {
    camera.quaternion.copy(deviceQuat);
    camera.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), yawOffset);
  } else {
    camera.quaternion.setFromEuler(
      new THREE.Euler(mouseLook.pitch, mouseLook.yaw + yawOffset, 0, 'YXZ'));
  }
  renderer.render(scene, camera);
}

// device orientation -> quaternion (classic DeviceOrientationControls math)
const _zee = new THREE.Vector3(0, 0, 1);
const _euler = new THREE.Euler();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));

function orientationToQuat(alphaDeg, betaDeg, gammaDeg, orientDeg) {
  const alpha = THREE.MathUtils.degToRad(alphaDeg);
  const beta = THREE.MathUtils.degToRad(betaDeg);
  const gamma = THREE.MathUtils.degToRad(gammaDeg);
  const orient = THREE.MathUtils.degToRad(orientDeg);
  const q = new THREE.Quaternion();
  _euler.set(beta, alpha, -gamma, 'YXZ');
  q.setFromEuler(_euler);
  q.multiply(_q1);
  q.multiply(_q0.setFromAxisAngle(_zee, -orient));
  return q;
}

function screenAngle() {
  return (screen.orientation && screen.orientation.angle) || window.orientation || 0;
}

// Tracking strategy: the RELATIVE (gyro) orientation drives the camera — it is
// smooth and world-locked, so the tunnels stay put while the phone turns. The
// noisy magnetic compass is folded into yawOffset ONCE (averaged over its
// first samples) just to establish where north is; a manual 🎯 landmark
// alignment (or swipe) replaces that reference and freezes it for good.
// Feeding the compass into the camera continuously — what this used to do —
// makes the whole scene swim/drag whenever the phone rotates.
let userAligned = false, autoRefDone = false, lastRelEvent = 0;
const _autoSamples = [];
const _fwd = new THREE.Vector3();

function quatBearing(q) { // forward bearing of an orientation, cw from north
  _fwd.set(0, 0, -1).applyQuaternion(q);
  return Math.atan2(_fwd.x, -_fwd.z);
}

function feedAutoRef(qAbs, label) {
  if (userAligned || autoRefDone || !deviceQuat) return;
  headingSource = label;
  _autoSamples.push(normAngle(quatBearing(deviceQuat) - quatBearing(qAbs)));
  if (_autoSamples.length >= 20) {
    let sx = 0, sy = 0;
    for (const a of _autoSamples) { sx += Math.cos(a); sy += Math.sin(a); }
    yawOffset = Math.atan2(sy, sx);   // circular mean of the sampled offsets
    autoRefDone = true;
  }
}

function onOrientationRel(e) { // 'deviceorientation': relative on modern phones
  if (e.alpha === null && e.webkitCompassHeading === undefined) return;
  hasSensors = true;
  lastRelEvent = performance.now();
  deviceQuat = orientationToQuat(e.alpha || 0, e.beta || 0, e.gamma || 0, screenAngle());
  if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
    feedAutoRef(orientationToQuat(360 - e.webkitCompassHeading, e.beta || 0, e.gamma || 0,
                                  screenAngle()), 'compass (iOS)');
  } else if (!autoRefDone && !userAligned) {
    headingSource = 'gyro — tap 🎯 Align';
  }
}

function onOrientationAbs(e) { // 'deviceorientationabsolute': Android compass
  if (e.alpha === null) return;
  hasSensors = true;
  const qAbs = orientationToQuat(e.alpha, e.beta || 0, e.gamma || 0, screenAngle());
  // no relative stream on this device (no gyro): track with the compass itself
  if (performance.now() - lastRelEvent > 1000) deviceQuat = qAbs;
  feedAutoRef(qAbs, 'compass (abs)');
}

async function startAR() {
  // sensors (iOS needs explicit permission from a user gesture)
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== 'granted') throw new Error('denied');
    }
    window.addEventListener('deviceorientationabsolute', onOrientationAbs);
    window.addEventListener('deviceorientation', onOrientationRel);
  } catch (e) { headingSource = 'mouse/drag'; }

  // camera
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' }, audio: false });
    const v = $('camera');
    v.srcObject = stream;
    v.style.display = 'block';
  } catch (e) { /* no camera (desktop) — dark background */ }

  buildARScene();
  setMode('ar');

  // fallback look controls if no sensor data arrives
  setTimeout(() => { if (!hasSensors) headingSource = 'mouse/drag'; }, 1500);

  const hint = $('calib-hint');
  hint.style.opacity = 1;
  setTimeout(() => hint.style.opacity = 0, 12000);
}

// ----------------------------------------------- landmark alignment mode ----
// Point the crosshair at a known landmark and confirm: the compass error is
// then exactly (current camera bearing − true bearing to the landmark), and is
// folded into yawOffset. No more swiping around to find the right heading.

let alignMode = false, alignTargets = [], alignIdx = 0;

function cameraBearing() {  // cw from north, radians
  const d = new THREE.Vector3();
  camera.getWorldDirection(d);
  return Math.atan2(d.x, -d.z);
}

function bearingToLandmark(lm) {  // cw from north, radians
  return Math.atan2((lm.lon - userPos.lon) * mPerDegLon(userPos.lat),
                    (lm.lat - userPos.lat) * M_PER_DEG_LAT);
}

function normAngle(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }

function setAlignHighlight() {
  const sel = alignTargets[alignIdx];
  for (const [name, m] of landmarkMeshes) {
    const isSel = sel && name === sel.lm.name;
    m.label.visible = alignMode;
    m.label.material.opacity = isSel ? 1 : 0.35;
    m.pillar.material.color.set(isSel ? 0x4dd2ff : 0xffffff);
    m.pillar.material.opacity = isSel ? 0.55 : 0.12;
  }
}

function enterAlign() {
  if (!arBuilt) return;
  alignTargets = LANDMARKS
    .map(lm => ({ lm, d: geoDist([lm.lon, lm.lat], [userPos.lon, userPos.lat]) }))
    .filter(t => t.d > 60)   // too close: bearing is meaningless
    .sort((a, b) => a.d - b.d)
    .slice(0, 6);
  if (!alignTargets.length) return;
  alignIdx = 0;
  alignMode = true;
  $('align-ui').style.display = 'block';
  trainlistEl.style.display = 'none';
  setAlignHighlight();
  updateAlignHint();
}

function exitAlign() {
  alignMode = false;
  $('align-ui').style.display = 'none';
  trainlistEl.style.display = '';
  setAlignHighlight();
}

function updateAlignHint() {
  const t = alignTargets[alignIdx];
  if (!t) return;
  const distTxt = t.d < 1000 ? Math.round(t.d) + ' m' : (t.d / 1000).toFixed(1) + ' km';
  const delta = normAngle(bearingToLandmark(t.lm) - cameraBearing());
  const deg = Math.round(Math.abs(delta) * 180 / Math.PI);
  const turn = deg < 4 ? '✓ centered — tap “aligned”'
    : delta < 0 ? `◀ turn left ${deg}°` : `turn right ${deg}° ▶`;
  $('align-text').innerHTML =
    `Center <b>${t.lm.name}</b> (${distTxt}) in the crosshair<br>${turn}`;
}

function confirmAlign() {
  const t = alignTargets[alignIdx];
  if (t) {
    yawOffset += cameraBearing() - bearingToLandmark(t.lm);
    userAligned = true;   // user reference beats the compass from now on
    if (hasSensors) headingSource = 'landmark ✓';
  }
  exitAlign();
}

// drag: with sensors -> calibrate yaw; without -> free look
let dragLast = null;
addEventListener('pointerdown', e => {
  if (mode !== 'ar' || e.target.closest('#controls') || e.target.closest('#align-panel')) return;
  dragLast = { x: e.clientX, y: e.clientY };
});
addEventListener('pointermove', e => {
  if (!dragLast || mode !== 'ar') return;
  const dx = e.clientX - dragLast.x, dy = e.clientY - dragLast.y;
  dragLast = { x: e.clientX, y: e.clientY };
  if (hasSensors) {
    yawOffset += dx * 0.003;
    userAligned = true;   // manual tweak: stop the compass from overriding it
  } else {
    mouseLook.yaw += dx * 0.005;
    mouseLook.pitch = Math.max(-1.5, Math.min(1.5, mouseLook.pitch + dy * 0.005));
  }
});
addEventListener('pointerup', () => dragLast = null);

addEventListener('resize', () => {
  if (!renderer) return;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// --------------------------------------------------------------- radar -----

const radarEl = $('radar');
function drawRadar(list) {
  const ctx = radarEl.getContext('2d');
  const W = radarEl.width, R = W / 2, range = 700; // meters shown
  ctx.clearRect(0, 0, W, W);
  ctx.save();
  ctx.translate(R, R);
  const sc = R / range;
  const ue = toENU(userPos.lon, userPos.lat);
  // fov wedge from camera heading
  if (camera) {
    const d = new THREE.Vector3();
    camera.getWorldDirection(d);
    const hdg = Math.atan2(d.x, -d.z);
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath(); ctx.moveTo(0, 0);
    ctx.arc(0, 0, R, hdg - Math.PI / 2 - 0.6, hdg - Math.PI / 2 + 0.6);
    ctx.fill();
  }
  for (const [name, c] of Object.entries(CORRIDORS)) {
    ctx.strokeStyle = c.color; ctx.lineWidth = 3; ctx.globalAlpha = 0.8;
    ctx.beginPath();
    c.path.forEach((p, i) => {
      const e = toENU(p[0], p[1]);
      const x = (e.x - ue.x) * sc, y = (e.z - ue.z) * sc;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  for (const t of list) {
    const e = toENU(t.lon, t.lat);
    ctx.fillStyle = t.color;
    ctx.beginPath();
    ctx.arc((e.x - ue.x) * sc, (e.z - ue.z) * sc, 6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(0, 0, 5, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// ------------------------------------------------------------ mode/boot ----

function setMode(m) {
  mode = m;
  $('map').style.display = m === 'map' ? 'block' : 'none';
  $('ar-canvas').style.display = m === 'ar' ? 'block' : 'none';
  $('camera').style.display = (m === 'ar' && $('camera').srcObject) ? 'block' : 'none';
  radarEl.style.display = m === 'ar' ? 'block' : 'none';
  $('btn-ar').classList.toggle('active', m === 'ar');
  $('btn-map').classList.toggle('active', m === 'map');
  $('btn-align').style.display = m === 'ar' ? '' : 'none';
  if (m !== 'ar' && alignMode) exitAlign();
  if (m === 'map') { initMap(); setTimeout(() => map.invalidateSize(), 50); }
}

function startGPS() {
  if (!navigator.geolocation) return;
  navigator.geolocation.watchPosition(
    p => { userPos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, real: true }; },
    () => {},
    { enableHighAccuracy: true, maximumAge: 2000 });
}

let lastListRender = 0, lastAlignHint = 0;
function frame(now) {
  const list = activeTrains(Date.now());
  if (mode === 'map' && map) updateMap(list);
  if (mode === 'ar' && arBuilt) { updateAR(list, now); drawRadar(list); }
  if (alignMode && now - lastAlignHint > 250) {
    lastAlignHint = now;
    updateAlignHint();
  }
  if (now - lastListRender > 1000) {
    lastListRender = now;
    renderTrainList(list);
    setStatus();
  }
  requestAnimationFrame(frame);
}

$('btn-start-ar').onclick = async () => {
  $('start-overlay').style.display = 'none';
  startGPS();
  await startAR();
};
$('btn-start-map').onclick = () => {
  $('start-overlay').style.display = 'none';
  startGPS();
  setMode('map');
};
$('btn-ar').onclick = () => { if (!arBuilt) { buildARScene(); } setMode('ar'); };
$('btn-map').onclick = () => setMode('map');
$('btn-align').onclick = () => alignMode ? exitAlign() : enterAlign();
$('align-next').onclick = () => { alignIdx = (alignIdx + 1) % alignTargets.length; setAlignHighlight(); updateAlignHint(); };
$('align-done').onclick = confirmAlign;
$('align-cancel').onclick = exitAlign;

// Desktop (no touch): AR adds nothing — go straight to the map
const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
if (!isTouch) {
  $('start-overlay').style.display = 'none';
  startGPS();
  setMode('map');
}

fetchBoards().then(() => {
  if (!trains.size) setTimeout(fetchBoards, 10000); // fast retry if first pass got nothing
});
setInterval(fetchBoards, REFRESH_MS);
requestAnimationFrame(frame);
