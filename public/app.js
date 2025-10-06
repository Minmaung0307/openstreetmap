(function(){
  // Map
  const map = L.map('map', { zoomControl:true }).setView([19.8,96.0], 6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
    maxZoom: 19, attribution: '&copy; OpenStreetMap'
  }).addTo(map);
  const markers = L.layerGroup().addTo(map);

  // UI
  const nameEl = document.getElementById('nameSearch');
  const nameBtn = document.getElementById('nameBtn');
  const stateEl = document.getElementById('state');
  const stateBtn = document.getElementById('stateBtn');
  const tsEl = document.getElementById('township');
  const tsBtn = document.getElementById('tsBtn');
  const clearBtn = document.getElementById('clearBtn');
  const statusEl = document.getElementById('status');
  const countEl = document.getElementById('count');
  const listEl = document.getElementById('list');
  const csvBtn = document.getElementById('csvBtn');
  const geojsonBtn = document.getElementById('geojsonBtn');

  // States
  const STATES = ["Ayeyarwady","Bago","Chin","Kachin","Kayah","Kayin","Magway","Mandalay","Mon","Naypyidaw","Rakhine","Sagaing","Shan","Tanintharyi","Yangon"];
  STATES.forEach(s=>{ const o=document.createElement('option'); o.value=s; o.textContent=s; stateEl.appendChild(o); });

  // Helpers
  function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
  function esc(s){ return String(s||'').replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
  function toCSV(rows){
    const head = ['id','name','name_en','name_mm','address','city','state','phone','website','lat','lon'];
    const esc2 = v => '\"'+String(v??'').replace(/\"/g,'\"\"')+'\"';
    return [head.join(',')].concat(rows.map(r=>head.map(k=>esc2(r[k])).join(','))).join('\\n');
  }
  function toGeoJSON(rows){
    return { type:'FeatureCollection', features: rows.filter(r=>r.lat&&r.lon).map(r=>({
      type:'Feature', geometry:{ type:'Point', coordinates:[r.lon,r.lat] }, properties:r
    }))};
  }
  function download(filename, blob){
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=filename; a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  }
  function boundsFromBBox(b){ return L.latLngBounds([b[0],b[1]],[b[2],b[3]]); }

  // Overpass & Nominatim
  const OPS = ['https://overpass-api.de/api/interpreter','https://overpass.kumi.systems/api/interpreter','https://z.overpass-api.de/api/interpreter'];
  let opi = 0, coolUntil = 0;
  async function overpass(query){
    if (coolUntil && Date.now() < coolUntil){ await sleep(coolUntil - Date.now()); }
    const url = OPS[opi++ % OPS.length] + '?data=' + encodeURIComponent(query);
    const res = await fetch(url);
    if (res.status === 429){ coolUntil = Date.now()+8000; await sleep(1000); return overpass(query); }
    if (!res.ok) throw new Error('Overpass '+res.status);
    const ct=(res.headers.get('content-type')||'').toLowerCase();
    if (!ct.includes('application/json')){ const t=await res.text(); throw new Error('Overpass non-JSON: '+t.slice(0,80)); }
    return res.json();
  }
  async function nominatim(q){
    const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q='+encodeURIComponent(q);
    const res = await fetch(url, { headers:{'Accept-Language':'en'} });
    if (!res.ok) throw new Error('Nominatim failed');
    const arr = await res.json();
    if (!arr.length) throw new Error('No match');
    const r = arr[0];
    if (r.boundingbox){
      return [parseFloat(r.boundingbox[0]), parseFloat(r.boundingbox[2]), parseFloat(r.boundingbox[1]), parseFloat(r.boundingbox[3])];
    }
    const lat=parseFloat(r.lat), lon=parseFloat(r.lon);
    return [lat-0.05, lon-0.05, lat+0.05, lon+0.05];
  }

  // Query builders
  function nameRegex(raw){
    const q=(raw||'').trim(); if(!q) return null;
    const aliases=[q, q.replace(/th/ig,'t'),'Sitagu','သီတဂူ','Thilashin','သီလရှင်','Sudhamma','Sasana','Vihara','Viharaya','Monastery','Nunnery'];
    const uniq=[...new Set(aliases)].map(esc);
    return '('+uniq.join('|')+')';
  }
  function mapElements(data){
    const out = (data.elements||[]).map(e=>{
      const t=e.tags||{}; const lat=e.lat||e.center?.lat; const lon=e.lon||e.center?.lon;
      return {
        id: e.type+'/'+e.id,
        name: t['name:my']||t['name']||t['name:en']||'Unknown',
        name_en: t['name:en']||'',
        name_mm: t['name:my']||'',
        address: t['addr:full']||'',
        city: t['addr:city']||'',
        state: t['addr:state']||t['is_in:state']||'',
        phone: t['contact:phone']||t['phone']||'',
        website: t['contact:website']||t['website']||'',
        lat, lon
      };
    });
    const seen=new Set(); const uniq=[];
    for(const r of out){ if(!seen.has(r.id)){ seen.add(r.id); uniq.push(r); } }
    return uniq;
  }

  async function queryNationwideByName(qtext){
    const re = nameRegex(qtext); if(!re) return [];
    const query = `[out:json][timeout:30];
      area["ISO3166-1"="MM"]->.mm;
      (
        node(area.mm)["amenity"~"monastery|nunnery|place_of_worship", i]["religion"="buddhist"]["name"~"${re}", i];
        way (area.mm)["amenity"~"monastery|nunnery|place_of_worship", i]["religion"="buddhist"]["name"~"${re}", i];
        relation(area.mm)["amenity"~"monastery|nunnery|place_of_worship", i]["religion"="buddhist"]["name"~"${re}", i];

        node(area.mm)["building"~"monastery|nunnery", i]["name"~"${re}", i];
        way (area.mm)["building"~"monastery|nunnery", i]["name"~"${re}", i];
        relation(area.mm)["building"~"monastery|nunnery", i]["name"~"${re}", i];
      );
      out center tags;`;
    const data = await overpass(query);
    return mapElements(data);
  }

  async function queryBBox(bbox, qtext){
    const re = nameRegex(qtext);
    const nameBlock = re ? (
      'node["name"~"'+re+'", i]('+bbox+');'+
      'way ["name"~"'+re+'", i]('+bbox+');'+
      'relation["name"~"'+re+'", i]('+bbox+');'
    ) : '';
    const query = `[out:json][timeout:25];
      (
        node["amenity"~"monastery|nunnery|place_of_worship", i]["religion"="buddhist"](${bbox});
        way ["amenity"~"monastery|nunnery|place_of_worship", i]["religion"="buddhist"](${bbox});
        relation["amenity"~"monastery|nunnery|place_of_worship", i]["religion"="buddhist"](${bbox});

        node["building"~"monastery|nunnery", i](${bbox});
        way ["building"~"monastery|nunnery", i](${bbox});
        relation["building"~"monastery|nunnery", i](${bbox});

        ${nameBlock}
      );
      out center tags;`;
    const data = await overpass(query);
    return mapElements(data);
  }

  async function queryTownshipsInState(stateName){
    // Try multiple OSM naming variants to get the state/region area
    const variants = [
      stateName,
      stateName + " Region",
      stateName + " State",
      stateName + " Division",
      stateName + " Union Territory"
    ];
    for (const v of variants){
      const q = `[out:json][timeout:25];
        area["ISO3166-1"="MM"]->.mm;
        // Try to resolve the chosen state to an area
        area.mm["name"="${esc(v)}"]["boundary"="administrative"]["admin_level"~"4|5"]->.st;
        // Fetch township-level admin boundaries inside this state area
        relation(area.st)["boundary"="administrative"]["admin_level"~"6|7"];
        out bb tags;`;
      try{
        const data = await overpass(q);
        const rows = (data.elements||[]).map(e=>{
          const t=e.tags||{};
          const bb = e.bounds? [e.bounds.minlat, e.bounds.minlon, e.bounds.maxlat, e.bounds.maxlon] : null;
          return { id:e.id, name: t['name:my']||t['name']||t['name:en']||'Unknown', bbox: bb };
        }).filter(x=>x.bbox);
        if (rows.length){
          rows.sort((a,b)=> a.name.localeCompare(b.name));
          return rows;
        }
      }catch(e){
        // try next variant
      }
    }
    // Fallback: use Nominatim bbox for the state and query townships within bbox
    try{
      const bb = await nominatim(stateName + ", Myanmar");
      const bbox = `${bb[0]},${bb[1]},${bb[2]},${bb[3]}`;
      const q2 = `[out:json][timeout:25];
        (
          relation["boundary"="administrative"]["admin_level"~"6|7"](${bbox});
        );
        out bb tags;`;
      const data2 = await overpass(q2);
      const rows2 = (data2.elements||[]).map(e=>{
        const t=e.tags||{};
        const bbx = e.bounds? [e.bounds.minlat, e.bounds.minlon, e.bounds.maxlat, e.bounds.maxlon] : null;
        return { id:e.id, name: t['name:my']||t['name']||t['name:en']||'Unknown', bbox: bbx };
      }).filter(x=>x.bbox);
      rows2.sort((a,b)=> a.name.localeCompare(b.name));
      return rows2;
    }catch(e){
      throw new Error("Unable to load townships for "+stateName);
    }
  }

  // Render & Export
  let current = [];
  function draw(rows){
    markers.clearLayers();
    const pts=[];
    rows.forEach(r=>{
      if(!(r.lat&&r.lon)) return;
      pts.push([r.lat,r.lon]);
      const html = `<strong>${r.name}</strong><br>
        ${[r.city,r.state].filter(Boolean).join(', ')}<br>
        ${r.address? r.address+'<br>':''}
        ${r.phone? '📞 '+r.phone+'<br>':''}
        ${r.website? '<a href="'+r.website+'" target="_blank">🌐 Website</a><br>':''}
        <a href="https://www.google.com/maps/dir/?api=1&destination=${r.lat},${r.lon}" target="_blank">Directions</a>`;
      L.marker([r.lat,r.lon]).bindPopup(html).addTo(markers);
    });
    if (pts.length){ const b=L.latLngBounds(pts); if (b.isValid()) map.fitBounds(b.pad(0.2)); }
  }
  function renderList(rows){
    listEl.innerHTML='';
    if (!rows.length){ listEl.innerHTML='<div class="card">No matches.</div>'; return; }
    rows.forEach(r=>{
      const card=document.createElement('div'); card.className='card';
      card.innerHTML = `<h3>${r.name}</h3>
        <div class="meta">${[r.city,r.state].filter(Boolean).join(', ')}</div>
        <div class="meta">${r.address||''}</div>
        <div class="row">
          ${r.phone?`<a href="tel:${r.phone}">📞 ${r.phone}</a>`:''}
          ${r.website?`<a href="${r.website}" target="_blank">🌐 Website</a>`:''}
          ${r.lat&&r.lon?`<a href="https://www.openstreetmap.org/?mlat=${r.lat}&mlon=${r.lon}#map=18/${r.lat}/${r.lon}" target="_blank">OSM</a>`:''}
        </div>`;
      listEl.appendChild(card);
    });
  }
  function setStatus(msg){ statusEl.textContent = msg; }

  // Wiring
  nameBtn.addEventListener('click', async ()=>{
    const q = nameEl.value.trim();
    if (!q){ setStatus('Enter a name (e.g., Sitagu / သီလရှင်)'); return; }
    setStatus('Nationwide search…');
    try{
      const rows = await queryNationwideByName(q);
      current = rows; countEl.textContent = rows.length + ' places';
      draw(rows); renderList(rows); setStatus('Done.');
    }catch(e){ setStatus(e.message||String(e)); }
  });
  nameEl.addEventListener('keydown', ev=>{ if(ev.key==='Enter') nameBtn.click(); });

  stateBtn.addEventListener('click', async ()=>{
    const st = stateEl.value;
    if (!st){ setStatus('Select a state/region.'); return; }
    setStatus('Loading townships in '+st+'… (trying name variants)');
    tsEl.innerHTML = '<option value="">(All in State)</option>';
    tsEl.disabled = true; tsBtn.disabled = true;
    try{
      const ts = await queryTownshipsInState(st);
      ts.forEach(t=>{
        const o=document.createElement('option'); o.value=JSON.stringify(t.bbox); o.textContent=t.name; tsEl.appendChild(o);
      });
      tsEl.disabled = false; tsBtn.disabled = false;
      try {
        const bb = await nominatim(st+', Myanmar');
        map.fitBounds(boundsFromBBox(bb).pad(0.1));
      }catch{ /* ignore */ }
      setStatus('Townships loaded.');
    }catch(e){ setStatus(e.message||String(e)); }
  });

  tsBtn.addEventListener('click', async ()=>{
    const q = nameEl.value.trim();
    if (!q){ setStatus('Enter a name first, then choose a township.'); return; }
    const val = tsEl.value;
    if (!val){ setStatus('Choose a township.'); return; }
    const bbox = JSON.parse(val);
    const bboxStr = `${bbox[0]},${bbox[1]},${bbox[2]},${bbox[3]}`;
    setStatus('Searching within township…');
    try{
      const rows = await queryBBox(bboxStr, q);
      current = rows; countEl.textContent = rows.length + ' places';
      map.fitBounds(boundsFromBBox(bbox).pad(0.05));
      draw(rows); renderList(rows); setStatus('Done.');
    }catch(e){ setStatus(e.message||String(e)); }
  });

  clearBtn.addEventListener('click', ()=>{
    nameEl.value=''; stateEl.value=''; tsEl.innerHTML='<option value="">(All in State)</option>'; tsEl.disabled=true; tsBtn.disabled=true;
    markers.clearLayers(); listEl.innerHTML=''; countEl.textContent=''; setStatus('Cleared.');
  });

  csvBtn.addEventListener('click', ()=>{
    if (!current.length){ setStatus('Nothing to export.'); return; }
    const csv = toCSV(current);
    download('monasteries.csv', new Blob([csv], {type:'text/csv'}));
  });
  geojsonBtn.addEventListener('click', ()=>{
    if (!current.length){ setStatus('Nothing to export.'); return; }
    const gj = JSON.stringify(toGeoJSON(current), null, 2);
    download('monasteries.geojson', new Blob([gj], {type:'application/geo+json'}));
  });

  // Demo hint
  nameEl.placeholder += " • e.g. 'Dagon' or 'Sitagu'";
})();