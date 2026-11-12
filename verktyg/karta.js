// Gör eskilstuna.json och skogstorp.json: vägar och hus från OpenStreetMap, packade så att spelet
// kan starta direkt och utan internet. Kör: node verktyg/karta.js [skogstorp]
// Kartdata © OpenStreetMap-bidragsgivare (ODbL).
"use strict";
const fs = require("fs"), path = require("path");
const PLACES = { eskilstuna: [59.3712, 16.5094, 4000, 3000], skogstorp: [59.32496, 16.48529, 2500, 2000] };
const NAME = process.argv[2] || "eskilstuna", [LAT, LON, R_ROADS, R_HOUSES] = PLACES[NAME];
const ROADS = "motorway_link|trunk|primary|secondary|tertiary|unclassified|residential|living_street|road|trunk_link|primary_link|secondary_link|tertiary_link";
const KEEP = ["highway", "name", "ref", "oneway", "maxspeed", "junction", "motor_vehicle", "motorcar", "access", "area", "crossing", "traffic_calming",
  "bridge", "layer", "lanes", "lanes:forward", "lanes:backward", "turn:lanes", "turn:lanes:forward", "turn:lanes:backward", "width"];
// "ytor" as a second word fetches only the ground areas and adds them to the existing file
// (a big town in one go can be too much for the map server).
const ONLY_LAND = process.argv[3] === "ytor";
const qLand = `[out:json][timeout:180];` +
  `(way["landuse"~"^(forest|grass|meadow|farmland|recreation_ground|cemetery)$"](around:${R_HOUSES},${LAT},${LON});` +
  `way["natural"~"^(wood|water|scrub)$"](around:${R_HOUSES},${LAT},${LON});way["leisure"~"^(pitch|park|playground)$"](around:${R_HOUSES},${LAT},${LON});` +
  `rel["landuse"~"^(forest|meadow|farmland)$"](around:${R_HOUSES},${LAT},${LON});rel["natural"~"^(wood|water)$"](around:${R_HOUSES},${LAT},${LON}););out geom qt;`;
const qFull = `[out:json][timeout:180];way["highway"~"^(${ROADS})$"](around:${R_ROADS},${LAT},${LON});out body qt;node(w);out body qt;` +
  `way["building"](around:${R_HOUSES},${LAT},${LON});out geom qt;` +
  // Ground: forest, water, sports pitches, parks and fields, so the map looks like the satellite image.
  `(way["landuse"~"^(forest|grass|meadow|farmland|recreation_ground|cemetery)$"](around:${R_HOUSES},${LAT},${LON});` +
  `way["natural"~"^(wood|water|scrub)$"](around:${R_HOUSES},${LAT},${LON});way["leisure"~"^(pitch|park|playground)$"](around:${R_HOUSES},${LAT},${LON});` +
  `rel["landuse"~"^(forest|meadow|farmland)$"](around:${R_HOUSES},${LAT},${LON});rel["natural"~"^(wood|water)$"](around:${R_HOUSES},${LAT},${LON}););out geom qt;`;
// What kind of ground an area is, as the game draws it.
function landKind(t) {
  if (!t) return null;
  if (t.natural === "water" || t.water) return "water";
  if (t.leisure === "pitch") return "pitch";
  if (t.landuse === "forest" || t.natural === "wood") return "forest";
  if (t.natural === "scrub") return "scrub";
  if (t.landuse === "farmland") return "field";
  if (t.leisure === "park" || t.leisure === "playground" || /^(grass|meadow|recreation_ground|cemetery)$/.test(t.landuse || "")) return "park";
  return null;
}
// A relation's outer ways joined end to end into closed rings.
function rings(members) {
  const parts = members.filter(m => m.type === "way" && m.role !== "inner" && m.geometry && m.geometry.length > 1).map(m => m.geometry.slice());
  const out = [];
  while (parts.length) {
    let ring = parts.shift(), grew = true;
    const same = (a, b) => a.lat === b.lat && a.lon === b.lon;
    while (grew && !same(ring[0], ring[ring.length - 1])) {
      grew = false;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i], end = ring[ring.length - 1];
        if (same(p[0], end)) ring = ring.concat(p.slice(1));
        else if (same(p[p.length - 1], end)) ring = ring.concat(p.slice(0, -1).reverse());
        else continue;
        parts.splice(i, 1); grew = true; break;
      }
    }
    if (ring.length > 3) out.push(ring);
  }
  return out;
}
const r5 = v => Math.round(v * 1e5) / 1e5;
function tagsOf(t) { if (!t) return null; const o = {}; let any = false; KEEP.forEach(k => { if (t[k] != null) { o[k] = t[k]; any = true; } }); return any ? o : null; }
(async () => {
  const SERVERS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass-api.de/api/interpreter"];
  let res = null;
  for (const url of SERVERS) {
    res = await fetch(url, { method: "POST", body: "data=" + encodeURIComponent(ONLY_LAND ? qLand : qFull),
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "korkort-spel-kartbygge" } }).catch(() => null);
    if (res && res.ok) break;
    console.log(url, res ? res.status : "inget svar", "- provar nästa");
  }
  if (!res.ok) throw new Error("overpass " + res.status);
  const json = await res.json(), out = { lat: LAT, lon: LON, rRoads: R_ROADS, rHouses: R_HOUSES, date: json.osm3s && json.osm3s.timestamp_osm_base, n: [], w: [], b: [], a: [] };
  const flat = geo => { const g = []; geo.forEach(p => { g.push(r5(p.lat), r5(p.lon)); }); return g; };
  json.elements.forEach(e => {
    const lk = (e.type === "way" || e.type === "relation") && !(e.tags && (e.tags.building || e.tags.highway)) ? landKind(e.tags) : null;
    if (lk) {
      if (e.type === "way" && e.geometry && e.geometry.length > 3) out.a.push([lk, flat(e.geometry)]);
      else if (e.type === "relation" && e.members) rings(e.members).forEach(r => out.a.push([lk, flat(r)]));
      return;
    }
    if (e.type === "node") { const t = tagsOf(e.tags); out.n.push(t ? [e.id, r5(e.lat), r5(e.lon), t] : [e.id, r5(e.lat), r5(e.lon)]); }
    else if (e.type === "way" && e.tags && e.tags.building) {
      if (e.tags.building === "roof" || !e.geometry) return;
      const g = []; e.geometry.forEach(p => { g.push(r5(p.lat), r5(p.lon)); });
      out.b.push([e.id, parseFloat(e.tags["building:levels"]) || 0, g]);
    } else if (e.type === "way" && e.tags && e.tags.highway) out.w.push([e.id, e.nodes, tagsOf(e.tags)]);
  });
  const file = path.join(__dirname, "..", NAME + ".json");
  if (ONLY_LAND) { const old = JSON.parse(fs.readFileSync(file, "utf8")); out.n = old.n; out.w = old.w; out.b = old.b; }
  fs.writeFileSync(file, JSON.stringify(out));
  console.log(file, (fs.statSync(file).size / 1e6).toFixed(2) + " MB", out.w.length + " vägar", out.b.length + " hus", out.a.length + " ytor");
})().catch(e => { console.error(e); process.exit(1); });
