#!/usr/bin/env python3
"""Build tunnels.js from OSM data.

Inputs (fetch first if missing — Swiss Overpass mirror strips tags from `out geom`,
hence two passes):

  curl -s -A "zurich-tunnel-ar/0.1" "https://overpass.osm.ch/api/interpreter" \
    --data-urlencode 'data=[out:json][timeout:120];(way["railway"~"^(rail|tram)$"](47.35,8.50,47.44,8.62););out geom;' \
    -o osm_all_rail_geom.json
  curl -s -A "zurich-tunnel-ar/0.1" "https://overpass.osm.ch/api/interpreter" \
    --data-urlencode 'data=[out:json][timeout:120];(way["railway"~"^(rail|tram)$"](47.35,8.50,47.44,8.62););out tags;' \
    -o osm_all_rail_tags.json

Corridor paths are routed over the real track network (ways split at shared
junction nodes, Dijkstra between waypoints), with a per-point depth taken from
tunnel/layer tags. Output: tunnels.js
"""
import json
import heapq
import math
from collections import defaultdict

M_PER_DEG_LAT = 110540


def m_per_deg_lon(lat):
    return 111320 * math.cos(math.radians(lat))


def dist(a, b):  # (lon, lat) -> meters
    return math.hypot((a[0] - b[0]) * m_per_deg_lon((a[1] + b[1]) / 2),
                      (a[1] - b[1]) * M_PER_DEG_LAT)


def length(pts):
    return sum(dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


# station/stop coordinates (lon, lat) — from transport.opendata.ch /locations
STATIONS = {
    'HB':                (8.540192, 47.378177),
    'Oerlikon':          (8.544115, 47.411529),
    'Stadelhofen':       (8.548466, 47.366611),
    'Stettbach':         (8.596132, 47.397317),
    'Wipkingen':         (8.529371, 47.393028),
    'Hardbrücke':        (8.517686, 47.385087),
    'Wiedikon':          (8.523475, 47.371468),
    'Enge':              (8.530818, 47.364095),
    'Tiefenbrunnen':     (8.561384, 47.350120),
    'Wollishofen':       (8.533600, 47.347428),
    'Selnau':            (8.532124, 47.372916),
    'Giesshübel':        (8.522010, 47.362604),
    'Milchbuck':         (8.541775, 47.397777),
    'Tierspital':        (8.551797, 47.401891),
    'Waldgarten':        (8.557200, 47.403709),
    'Ueberlandpark':     (8.563872, 47.405938),
    'Schwamendingerplatz': (8.571649, 47.404684),
}

# corridor -> (graph key, waypoint chain, tunnel_bias). Waypoint syntaxes:
#   '<Station>'          station coordinate
#   'mid:<Tunnelname>'   middle vertex of that named tunnel (forces the line)
#   'end:<Tunnelname>:<Station>'  named tunnel's end nearest that station —
#                        e.g. Weinberg trains depart from the UNDERGROUND
#                        Löwenstrasse platforms; snapping to the surface HB
#                        node routes a 8 km detour via Wipkingen instead.
#   'pt:<lon>,<lat>'     raw coordinate (Käferbergtunnel is unnamed in OSM)
# tunnel_bias doubles the cost of surface edges so through-tunnel corridors
# don't take a parallel surface line. Graph 'szu' is the operator=SZU
# subnetwork — from the mainline, the SZU terminal under HB is only reachable
# via a 5 km detour through the Giesshübel link, so route it separately.
CORRIDOR_ROUTES = {
    'weinberg':       ('rail', ['end:Weinbergtunnel:HB', 'mid:Weinbergtunnel', 'Oerlikon'], True),
    'hirschengraben': ('rail', ['HB', 'mid:Hirschengrabentunnel', 'Stadelhofen'], True),
    'zuerichberg':    ('rail', ['Stadelhofen', 'mid:Zürichbergtunnel', 'Stettbach'], True),
    'wipkingen-a':    ('rail', ['HB', 'Wipkingen'], False),
    'wipkingen-b':    ('rail', ['Wipkingen', 'Oerlikon'], True),
    'kaeferberg':     ('rail', ['Hardbrücke', 'pt:8.5247,47.4003', 'Oerlikon'], True),
    'ulmberg-a':      ('rail', ['HB', 'Wiedikon'], True),
    'ulmberg-b':      ('rail', ['Wiedikon', 'Enge'], True),
    'enge':           ('rail', ['Enge', 'Wollishofen'], True),
    'riesbach':       ('rail', ['Stadelhofen', 'Tiefenbrunnen'], True),
    'szu-a':          ('szu',  ['HB', 'Selnau'], True),
    'szu-b':          ('szu',  ['Selnau', 'Giesshübel'], True),
}

# Multi-stop chains routed in ONE pass and split at the stops' projections —
# routing stop-to-stop snaps adjacent stops onto the two parallel tunnel tubes
# and detours around via the portals.
CHAIN_ROUTES = {
    'tram': ('tram', ['Milchbuck', 'Tierspital', 'Waldgarten', 'Ueberlandpark',
                      'Schwamendingerplatz'],
             True, ['tram-a', 'tram-b', 'tram-c', 'tram-d']),
}


def load_ways():
    geom = json.load(open('osm_all_rail_geom.json'))
    tags = json.load(open('osm_all_rail_tags.json'))
    tmap = {e['id']: e.get('tags', {}) for e in tags['elements']}
    ways = []
    for w in geom['elements']:
        t = tmap.get(w['id'], {})
        if t.get('railway') not in ('rail', 'tram'):
            continue
        ways.append({
            'cls': t['railway'],
            'operator': t.get('operator', ''),
            'nodes': w['nodes'],
            'pts': [(p['lon'], p['lat']) for p in w['geometry']],
            'tunnel': t.get('tunnel') in ('yes', 'building_passage', 'covered'),
            'layer': int(t['layer']) if t.get('layer', '').lstrip('-').isdigit() else -1,
            'name': t.get('tunnel:name', ''),
        })
    return ways


def build_graph(ways, key):
    """Split ways at shared junction nodes; graph over OSM node ids."""
    if key == 'szu':
        subset = [w for w in ways if w['cls'] == 'rail' and w['operator'] == 'SZU']
    else:
        subset = [w for w in ways if w['cls'] == key]
    use = defaultdict(int)
    for w in subset:
        for n in w['nodes']:
            use[n] += 1
        use[w['nodes'][0]] += 1   # endpoints always graph nodes
        use[w['nodes'][-1]] += 1
    adj = defaultdict(list)
    coords = {}
    for w in subset:
        cut = [0] + [i for i in range(1, len(w['nodes']) - 1) if use[w['nodes'][i]] > 1] \
              + [len(w['nodes']) - 1]
        for a, b in zip(cut, cut[1:]):
            u, v = w['nodes'][a], w['nodes'][b]
            pts = w['pts'][a:b + 1]
            if len(pts) < 2:
                continue
            L = length(pts)
            depth = min(-12, 15 * w['layer']) if w['tunnel'] else 0
            adj[u].append((v, L, pts, depth))
            adj[v].append((u, L, pts[::-1], depth))
            coords[u], coords[v] = pts[0], pts[-1]
    return adj, coords


def dijkstra(adj, s, t, tunnel_bias=False):
    dd = {s: 0.0}
    prev = {}
    n = 0  # heap tie-breaker (node ids mix int and str)
    pq = [(0.0, 0, s)]
    while pq:
        d0, _, u = heapq.heappop(pq)
        if u == t:
            break
        if d0 > dd.get(u, 1e18):
            continue
        for v, L, pts, depth in adj[u]:
            nd = d0 + (L if depth < 0 or not tunnel_bias else 2 * L)
            if nd < dd.get(v, 1e18):
                dd[v] = nd
                prev[v] = (u, pts, depth)
                n += 1
                heapq.heappush(pq, (nd, n, v))
    if t not in dd:
        return None
    segs = []
    cur = t
    while cur != s:
        u, pts, depth = prev[cur]
        segs.append((pts, depth))
        cur = u
    path, depths = [], []
    for pts, depth in segs[::-1]:
        start = 0 if not path else 1
        path += pts[start:]
        depths += [depth] * len(pts[start:])
    return path, depths


def snap_virtual(adj, coords, pt, vid):
    """Snap pt to the nearest vertex ON any edge polyline (not just graph
    nodes — a 3 km tunnel mapped as one way is a single edge whose interior
    would otherwise be unreachable). Splits the edge with a virtual node."""
    best = None  # (d, u, v, pts, depth, i)
    seen = set()
    for u, edges in list(adj.items()):
        if isinstance(u, str):
            continue  # don't snap onto earlier virtual split edges
        for v, L, pts, depth in edges:
            if isinstance(v, str):
                continue
            ek = (min(u, v), max(u, v), round(L, 1))
            if ek in seen:
                continue
            seen.add(ek)
            for i, p in enumerate(pts):
                d = dist(p, pt)
                if best is None or d < best[0]:
                    best = (d, u, v, pts, depth, i)
    d, u, v, pts, depth, i = best
    to_u, to_v = pts[i::-1], pts[i:]
    adj[vid] = []
    if len(to_u) > 1:
        adj[vid].append((u, length(to_u), to_u, depth))
        adj[u].append((vid, length(to_u), to_u[::-1], depth))
    if len(to_v) > 1:
        adj[vid].append((v, length(to_v), to_v, depth))
        adj[v].append((vid, length(to_v), to_v[::-1], depth))
    coords[vid] = pts[i]
    return d


_route_n = 0


def route(adj, coords, from_pt, to_pt, tunnel_bias=False, debug=''):
    global _route_n
    _route_n += 1
    sid, tid = f'_s{_route_n}', f'_t{_route_n}'
    ds = snap_virtual(adj, coords, from_pt, sid)
    dt = snap_virtual(adj, coords, to_pt, tid)
    if debug:
        print(f'    {debug}: snapped start {ds:.0f} m, end {dt:.0f} m from stops')
    r = dijkstra(adj, sid, tid, tunnel_bias)
    if not r:
        raise RuntimeError('no route found for ' + debug)
    return r


def longest_named(ways, name):
    return max((w for w in ways if w['name'] == name), key=lambda w: length(w['pts']))


def resolve_waypoint(ways, spec):
    if spec.startswith('mid:'):
        pts = longest_named(ways, spec[4:])['pts']
        return pts[len(pts) // 2]
    if spec.startswith('end:'):
        _, name, stn = spec.split(':')
        pts = longest_named(ways, name)['pts']
        return min((pts[0], pts[-1]), key=lambda p: dist(p, STATIONS[stn]))
    if spec.startswith('pt:'):
        lon, lat = spec[3:].split(',')
        return (float(lon), float(lat))
    return STATIONS[spec]


def main():
    ways = load_ways()
    graphs = {g: build_graph(ways, g) for g in ('rail', 'tram', 'szu')}
    corridors = {}

    def emit(key, path, depths):
        L = length(path)
        tunnel_m = sum(dist(path[i], path[i + 1])
                       for i in range(len(path) - 1) if depths[i] < 0 or depths[i + 1] < 0)
        corridors[key] = {
            'path': [[round(x, 6), round(y, 6)] for x, y in path],
            'depths': depths,
        }
        print(f'{key:16s} {L:6.0f} m total, {tunnel_m:6.0f} m underground, {len(path)} pts')

    for key, (gkey, chain, bias) in CORRIDOR_ROUTES.items():
        adj, coords = graphs[gkey]
        wpts = [resolve_waypoint(ways, c) for c in chain]
        path, depths = [], []
        for a, b in zip(wpts, wpts[1:]):
            p, d = route(adj, coords, a, b, bias, debug=key)
            start = 0 if not path else 1
            path += p[start:]
            depths += d[start:]
        emit(key, path, depths)

    for _, (gkey, stops, bias, seg_keys) in CHAIN_ROUTES.items():
        adj, coords = graphs[gkey]
        wpts = [resolve_waypoint(ways, c) for c in stops]
        path, depths = route(adj, coords, wpts[0], wpts[-1], bias, debug=seg_keys[0])
        # split at each intermediate stop's nearest path vertex (monotonic)
        cut = [0]
        for w in wpts[1:-1]:
            lo = cut[-1] + 1
            cut.append(min(range(lo, len(path)), key=lambda i: dist(path[i], w)))
        cut.append(len(path) - 1)
        for k, (a, b) in zip(seg_keys, zip(cut, cut[1:])):
            emit(k, path[a:b + 1], depths[a:b + 1])

    render = [{'name': w['name'], 'layer': w['layer'],
               'pts': [[round(x, 6), round(y, 6)] for x, y in w['pts']]}
              for w in ways if w['tunnel']]
    out = {
        'stations': {k: [round(v[0], 6), round(v[1], 6)] for k, v in STATIONS.items()},
        'corridors': corridors,
        'render': render,
    }
    with open('tunnels.js', 'w') as f:
        f.write('const TUNNEL_DATA = ')
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
        f.write(';\n')
    print(f'tunnels.js written ({len(render)} context tunnel ways)')


if __name__ == '__main__':
    main()
