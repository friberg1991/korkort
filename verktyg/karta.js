// Gör eskilstuna.json och skogstorp.json: vägar och hus från OpenStreetMap, packade så att spelet
// kan starta direkt och utan internet. Kör: node verktyg/karta.js [skogstorp]
// Kartdata © OpenStreetMap-bidragsgivare (ODbL).
"use strict";
const fs = require("fs"), path = require("path");
const PLACES = { eskilstuna: [59.3712, 16.5094, 4000, 3000], skogstorp: [59.32496, 16.48529, 2500, 2000] };
const NAME = process.argv[2] || "eskilstuna", [LAT, LON, R_ROADS, R_HOUSES] = PLACES[NAME];
const ROADS = "trunk|primary|secondary|tertiary|unclassified|residential|living_street|road|trunk_link|primary_link|secondary_link|tertiary_link";
const KEEP = ["highway", "name", "ref", "oneway", "maxspeed", "junction", "motor_vehicle", "motorcar", "access", "area", "crossing", "traffic_calming"];
const q = `[out:json][timeout:180];way["highway"~"^(${ROADS})$"](around:${R_ROADS},${LAT},${LON});out body qt;node(w);out body qt;` +
  `way["building"](around:${R_HOUSES},${LAT},${LON});out geom qt;`;
const r5 = v => Math.round(v * 1e5) / 1e5;
function tagsOf(t) { if (!t) return null; const o = {}; let any = false; KEEP.forEach(k => { if (t[k] != null) { o[k] = t[k]; any = true; } }); return any ? o : null; }
(async () => {
  const SERVERS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass-api.de/api/interpreter"];
  let res = null;
  for (const url of SERVERS) {
    res = await fetch(url, { method: "POST", body: "data=" + encodeURIComponent(q),
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "korkort-spel-kartbygge" } }).catch(() => null);
    if (res && res.ok) break;
    console.log(url, res ? res.status : "inget svar", "- provar nästa");
  }
  if (!res.ok) throw new Error("overpass " + res.status);
  const json = await res.json(), out = { lat: LAT, lon: LON, rRoads: R_ROADS, rHouses: R_HOUSES, date: json.osm3s && json.osm3s.timestamp_osm_base, n: [], w: [], b: [] };
  json.elements.forEach(e => {
    if (e.type === "node") { const t = tagsOf(e.tags); out.n.push(t ? [e.id, r5(e.lat), r5(e.lon), t] : [e.id, r5(e.lat), r5(e.lon)]); }
    else if (e.type === "way" && e.tags && e.tags.building) {
      if (e.tags.building === "roof" || !e.geometry) return;
      const g = []; e.geometry.forEach(p => { g.push(r5(p.lat), r5(p.lon)); });
      out.b.push([e.id, parseFloat(e.tags["building:levels"]) || 0, g]);
    } else if (e.type === "way" && e.tags && e.tags.highway) out.w.push([e.id, e.nodes, tagsOf(e.tags)]);
  });
  const file = path.join(__dirname, "..", NAME + ".json");
  fs.writeFileSync(file, JSON.stringify(out));
  console.log(file, (fs.statSync(file).size / 1e6).toFixed(2) + " MB", out.w.length + " vägar", out.b.length + " hus");
})().catch(e => { console.error(e); process.exit(1); });
