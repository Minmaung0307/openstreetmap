(function(){
  // ---------- map ----------
  const map = L.map('map', { zoomControl:true }).setView([19.8,96.0], 6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap'
  }).addTo(map);
  const markers = L.layerGroup().addTo(map);

  // ---------- ui ----------
  const statusEl = document.getElementById('status');
  const countEl = document.getElementById('count');
  const listEl = document.getElementById('list');
  const freeEl = document.getElementById('free');
  const geocodeBtn = document.getElementById('geocodeBtn');
  const stateSel = document.getElementById('state');
  const stateBtn = document.getElementById('stateBtn');
  const clearBtn = document.getElementById('clearBtn');
  const csvBtn = document.getElementById('csvBtn');
  const geojsonBtn = document.getElementById('geojsonBtn');

  // ---------- states ----------
  const STATES = {
    "Ayeyarwady":[14.0,94.5,18.0,96.5],
    "Bago":[16.5,95.0,19.5,97.5],
    "Chin":[20.5,92.2,24.5,94.2],
    "Kachin":[23.6,96.0,28.7,99.8],
    "Kayah":[18.5,96.9,19.9,97.9],
    "Kayin":[15.1,97.2,18.6,98.6],
    "Magway":[18.0,93.9,22.1,95.9],
    "Mandalay":[20.6,95.6,23.8,96.9],
    "Mon":[14.5,96.7,17.6,98.1],
    "Naypyidaw":[19.6,95.9,20.2,96.3],
    "Rakhine":[16.2,92.2,21.7,94.1],
    "Sagaing":[22.1,94.1,26.0,96.6],
    "Shan":[19.2,96.7,24.3,101.5],
    "Tanintharyi":[9.6,97.4,15.1,99.5],
    "Yangon":[16.6,95.9,17.2,96.4]
  };
  for (const k of Object.keys(STATES)){
    const opt=document.createElement('option');
    opt.value = k; opt.textContent = k;
    stateSel.appendChild(opt);
  }

  // ---------- helpers ----------
  function bboxToBounds(b){
    const sw=[b[0],b[1]], ne=[b[2],b[3]];
    return L.latLngBounds(sw, ne);
  }
  function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
  function debounce(fn,ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms); }; }
  function toCSV(rows){
    const head = ['id','name','name_en','name_mm','address','city','state','phone','website','lat','lon'];
    const esc = s => ('"'+String(s).replace(/"/g,'""')+'"');
    const all = [head.join(',')].concat(rows.map(r=> head.map(k=>esc(r[k]??'')).join(',')));
    return all.join('\n');
  }
  function toGeoJSON(rows){
    return {
      type:'FeatureCollection',
      features: rows.filter(r=>r.lat&&r.lon).map(r=>({
        type:'Feature',
        geometry:{ type:'Point', coordinates:[r.lon, r.lat] },
        properties:r
      }))
    };
  }
  function download(filename, blob){
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download=filename; a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- Overpass client (gentle) ----------
  const ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://z.overpass-api.de/api/interpreter'
  ];
  let epIdx = 0;
  let coolUntil = 0;
  async function fetchOverpass(query, tries=0){
    if (coolUntil && Date.now() < coolUntil){
      await sleep(coolUntil - Date.now());
    }
    const url = ENDPOINTS[epIdx % ENDPOINTS.length] + '?data=' + encodeURIComponent(query);
    epIdx++;
    const res = await fetch(url);
    if (res.status === 429){
      coolUntil = Date.now() + 8000;
      await sleep(1000);
      return fetchOverpass(query, tries+1);
    }
    if (!res.ok) throw new Error('Overpass ' + res.status);
    const ct = (res.headers.get('content-type')||'').toLowerCase();
    if (!ct.includes('application/json')){
      const txt = await res.text();
      throw new Error('Non-JSON from Overpass: ' + txt.slice(0,80));
    }
    return res.json();
  }

  // ---------- search ----------
  let current = [];

  async function queryBBox(bbox){
    statusEl.textContent = 'Searching…';
    const q = `[out:json][timeout:25];
      (
        node["amenity"="place_of_worship"]["religion"="buddhist"](${bbox});
        way ["amenity"="place_of_worship"]["religion"="buddhist"](${bbox});
        relation["amenity"="place_of_worship"]["religion"="buddhist"](${bbox});

        node["amenity"="monastery"](${bbox});
        way ["amenity"="monastery"](${bbox});
        relation["amenity"="monastery"](${bbox});

        node["building"="monastery"](${bbox});
        way ["building"="monastery"](${bbox});
        relation["building"="monastery"](${bbox});
      );
      out center tags;`;
    const data = await fetchOverpass(q);
    const rows = (data.elements||[]).map(e=>{
      const t=e.tags||{};
      const lat = e.lat || (e.center && e.center.lat);
      const lon = e.lon || (e.center && e.center.lon);
      return {
        id: e.type + '/' + e.id,
        name: t['name:my'] || t['name'] || t['name:en'] || 'Unknown',
        name_en: t['name:en'] || '',
        name_mm: t['name:my'] || '',
        address: t['addr:full'] || '',
        city: t['addr:city'] || '',
        state: t['addr:state'] || t['is_in:state'] || '',
        phone: t['contact:phone'] || t['phone'] || '',
        website: t['contact:website'] || t['website'] || '',
        lat, lon
      };
    });
    current = rows;
    renderList();
    drawMarkers();
  }

  function drawMarkers(){
    markers.clearLayers();
    const pts = [];
    current.forEach(r=>{
      if (!(r.lat&&r.lon)) return;
      pts.push([r.lat,r.lon]);
      const html = `<strong>${r.name}</strong><br>
        ${[r.city,r.state].filter(Boolean).join(', ')}<br>
        ${r.address? r.address+'<br>':''}
        ${r.phone? '📞 '+r.phone+'<br>':''}
        ${r.website? '<a href="'+r.website+'" target="_blank">🌐 Website</a><br>':''}
        <a href="https://www.openstreetmap.org/?mlat=${r.lat}&mlon=${r.lon}#map=18/${r.lat}/${r.lon}" target="_blank">OSM</a> ·
        <a href="https://www.google.com/maps/dir/?api=1&destination=${r.lat},${r.lon}" target="_blank">Directions</a>`;
      L.marker([r.lat,r.lon]).bindPopup(html).addTo(markers);
    });
    if (pts.length){
      const b = L.latLngBounds(pts);
      if (b.isValid()) map.fitBounds(b.pad(0.2));
    }
    countEl.textContent = `${current.length} places`;
    statusEl.textContent = 'Done.';
  }

  function renderList(){
    listEl.innerHTML = '';
    if (!current.length){
      listEl.innerHTML = '<div class="card">No places found. Try another area or zoom in.</div>';
      return;
    }
    current.forEach(r=>{
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `<h3>${r.name}</h3>
        <div class="meta">${[r.city,r.state].filter(Boolean).join(', ')}</div>
        <div class="meta">${r.address||''}</div>
        <div class="row">
          ${r.phone?`<a href="tel:${r.phone}">📞 ${r.phone}</a>`:''}
          ${r.website?`<a href="${r.website}" target="_blank">🌐 Website</a>`:''}
          ${r.lat&&r.lon?`<a href="https://www.openstreetmap.org/?mlat=${r.lat}&mlon=${r.lon}#map=18/${r.lat}/${r.lon}" target="_blank">OSM</a>`:''}
          ${r.lat&&r.lon?`<a href="https://www.google.com/maps/dir/?api=1&destination=${r.lat},${r.lon}" target="_blank">Directions</a>`:''}
        </div>`;
      listEl.appendChild(card);
    });
  }

  // ---------- Geocoding ----------
  async function geocodeFree(text){
    statusEl.textContent = 'Geocoding…';
    const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' + encodeURIComponent(text + ', Myanmar');
    const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    if (!res.ok) throw new Error('Geocoding failed');
    const arr = await res.json();
    if (!arr.length) throw new Error('No match');
    const r = arr[0];
    if (r.boundingbox){
      const bb = [parseFloat(r.boundingbox[0]), parseFloat(r.boundingbox[2]), parseFloat(r.boundingbox[1]), parseFloat(r.boundingbox[3])];
      return bb;
    } else {
      const lat = parseFloat(r.lat), lon = parseFloat(r.lon);
      return [lat-0.05, lon-0.05, lat+0.05, lon+0.05];
    }
  }

  // ---------- Wiring ----------
  const runState = async ()=>{
    const k = stateSel.value;
    if (!k) return;
    const b = STATES[k];
    const bbox = `${b[0]},${b[1]},${b[2]},${b[3]}`;
    map.fitBounds(bboxToBounds(b).pad(0.1));
    try{ await queryBBox(bbox); }catch(e){ statusEl.textContent = e.message||String(e); }
  };
  stateBtn.addEventListener('click', runState);
  stateSel.addEventListener('change', runState);

  geocodeBtn.addEventListener('click', async ()=>{
    const t = freeEl.value.trim();
    if (!t) return;
    try{
      const b = await geocodeFree(t);
      const bbox = `${b[0]},${b[1]},${b[2]},${b[3]}`;
      map.fitBounds(bboxToBounds(b).pad(0.1));
      await queryBBox(bbox);
    }catch(e){
      statusEl.textContent = e.message || String(e);
    }
  });

  clearBtn.addEventListener('click', ()=>{
    freeEl.value = ''; stateSel.value = '';
    markers.clearLayers(); listEl.innerHTML=''; countEl.textContent=''; statusEl.textContent='Cleared.'; current=[];
  });

  csvBtn.addEventListener('click', ()=>{
    if (!current.length){ statusEl.textContent='Nothing to export.'; return; }
    const csv = toCSV(current);
    download('monasteries.csv', new Blob([csv], {type:'text/csv'}));
  });
  geojsonBtn.addEventListener('click', ()=>{
    if (!current.length){ statusEl.textContent='Nothing to export.'; return; }
    const gj = JSON.stringify(toGeoJSON(current), null, 2);
    download('monasteries.geojson', new Blob([gj], {type:'application/geo+json'}));
  });

  // Quick start: Yangon button alike
  stateSel.value = 'Yangon';
  runState();

})(); 
