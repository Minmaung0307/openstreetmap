(function(){
  // Map
  const map = L.map('map', { zoomControl:true }).setView([19.8,96.0], 6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
    maxZoom: 19, attribution: '&copy; OpenStreetMap'
  }).addTo(map);
  const markers = L.layerGroup().addTo(map);

  // UI
  const stateEl = document.getElementById('state');
  const loadStateBtn = document.getElementById('loadState');
  const tsEl = document.getElementById('township');
  const applyTsBtn = document.getElementById('applyTownship');
  const forceBtn = document.createElement('button'); forceBtn.textContent='Force Refresh'; forceBtn.id='forceRefresh'; document.querySelector('header .row').appendChild(forceBtn);
  const nameEl = document.getElementById('name');
  const applyNameBtn = document.getElementById('applyName');
  const clearBtn = document.getElementById('clearAll');
  const statusEl = document.getElementById('status');
  const countEl = document.getElementById('count');
  const listEl = document.getElementById('list');
  const csvBtn = document.getElementById('csvBtn');
  const geojsonBtn = document.getElementById('geojsonBtn');

  // States
  const STATES = ["Ayeyarwady","Bago","Chin","Kachin","Kayah","Kayin","Magway","Mandalay","Mon","Naypyidaw","Rakhine","Sagaing","Shan","Tanintharyi","Yangon"];
  STATES.forEach(s=>{ const o=document.createElement('option'); o.value=s; o.textContent=s; stateEl.appendChild(o); });

  // Helpers
  function setStatus(m){ statusEl.textContent = m; }
  function spin(m){ setStatus('⏳ '+m); }
  function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
  function esc(s){ return String(s||'').replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
  function norm(x){ return (x||'').toString().toLowerCase().normalize('NFC').trim(); }
  function withinBBox(lat,lon,b){ return lat>=b[0] && lat<=b[2] && lon>=b[1] && lon<=b[3]; }
  function toCSV(rows){
    const head = ['id','name','name_en','name_mm','address','city','state','phone','website','lat','lon'];
    const esc2 = v => '\"'+String(v??'').replace(/\"/g,'\"\"')+'\"';
    return [head.join(',')].concat(rows.map(r=>head.map(k=>esc2(r[k])).join(','))).join('\n');
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

  // Nationwide-by-name query then clip to bbox
  async function nationwideByName(qtext){
    const escJs = s => s.replace(/\\/g,'\\\\').replace(/"/g,'\\"');
    const q = (qtext||'').trim();
    if (!q) return [];
    const aliases=[q, q.replace(/th/ig,'t'),'Sitagu','စိတ္တဂူ','သီတဂူ','Thathudaza','Thudaza','Thawtuzana','သောတုဇန','Sudhamma','သုဓမ္မ','Sasana','သာသနာ','Vihara','Viharaya','Monastery','Nunnery','Thilashin','သီလရှင်'];
    const uniq=[...new Set(aliases)].map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
    const re = '('+uniq.join('|')+')';
    const query = `[out:json][timeout:30];
      area["ISO3166-1"="MM"]->.mm;
      (
        node(area.mm)["amenity"~"monastery|nunnery|place_of_worship", i]["religion"="buddhist"]["name"~"${re}", i];
        way (area.mm)["amenity"~"monastery|nunnery|place_of_worship", i]["religion"="buddhist"]["name"~"${re}", i];
        relation(area.mm)["amenity"~"monastery|nunnery|place_of_worship", i]["religion"="buddhist"]["name"~"${re}", i];

        node(area.mm)["building"~"monastery|nunnery", i]["name"~"${re}", i];
        way (area.mm)["building"~"monastery|nunnery", i]["name"~"${re}", i];
        relation(area.mm)["building"~"monastery|nunnery", i]["name"~"${re}", i];
      ); out center tags;`;
    const data = await overpass(query);
    return mapElements(data);
  }

  // Load optional local overrides
  async function loadLocalOverrides(){
    try{
      const res = await fetch('local-overrides.json', { cache:'no-store' });
      if (!res.ok) return [];
      const arr = await res.json();
      if (!Array.isArray(arr)) return [];
      return arr.map((r,i)=>({
        id: r.id || ('local-'+i),
        name: r.name || 'Unknown',
        name_en: r.name_en || '',
        name_mm: r.name_mm || '',
        address: r.address || '',
        city: r.city || '',
        state: r.state || '',
        phone: r.phone || '',
        website: r.website || '',
        lat: r.lat, lon: r.lon,
        __local: true
      })).filter(r=> typeof r.lat==='number' && typeof r.lon==='number');
    }catch{ return []; }
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
    return [lat-0.1, lon-0.1, lat+0.1, lon+0.1];
  }

  // Mapping & storage
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

  async function queryBBoxAll(bbox){
    const q = `[out:json][timeout:25];
      (
        node["amenity"~"monastery|nunnery|place_of_worship", i]["religion"="buddhist"](${bbox});
        way ["amenity"~"monastery|nunnery|place_of_worship", i]["religion"="buddhist"](${bbox});
        relation["amenity"~"monastery|nunnery|place_of_worship", i]["religion"="buddhist"](${bbox});

        node["building"~"monastery|nunnery", i](${bbox});
        way ["building"~"monastery|nunnery", i](${bbox});
        relation["building"~"monastery|nunnery", i](${bbox});
      ); out center tags;`;
    const data = await overpass(q);
    return mapElements(data);
  }

  async function queryTownshipsInState(stateName){
    const variants = [stateName, stateName+' Region', stateName+' State', stateName+' Division', stateName+' Union Territory'];
    for(const v of variants){
      const q = `[out:json][timeout:25];
        area["ISO3166-1"="MM"]->.mm;
        area.mm["name"="${esc(v)}"]["boundary"="administrative"]["admin_level"~"4|5"]->.st;
        relation(area.st)["boundary"="administrative"]["admin_level"~"6|7"];
        out bb tags;`;
      try{
        const data = await overpass(q);
        const rows = (data.elements||[]).map(e=>{
          const t=e.tags||{};
          const bb = e.bounds? [e.bounds.minlat, e.bounds.minlon, e.bounds.maxlat, e.bounds.maxlon] : null;
          return { id:e.id, name: t['name:my']||t['name']||t['name:en']||'Unknown', bbox: bb };
        }).filter(x=>x.bbox);
        if (rows.length){ rows.sort((a,b)=>a.name.localeCompare(b.name)); return rows; }
      }catch(_){}
    }
    // Fallback by state bbox
    const bb = await nominatim(stateName+', Myanmar');
    const bbox = `${bb[0]},${bb[1]},${bb[2]},${bb[3]}`
    const q2 = `[out:json][timeout:25];
      relation["boundary"="administrative"]["admin_level"~"6|7"](${bbox});
      out bb tags;`;
    const data2 = await overpass(q2);
    const rows2 = (data2.elements||[]).map(e=>{
      const t=e.tags||{};
      const bbx = e.bounds? [e.bounds.minlat, e.bounds.minlon, e.bounds.maxlat, e.bounds.maxlon] : null;
      return { id:e.id, name: t['name:my']||t['name']||t['name:en']||'Unknown', bbox: bbx };
    }).filter(x=>x.bbox);
    rows2.sort((a,b)=>a.name.localeCompare(b.name));
    return rows2;
  }

  // Fuzzy filter by name (show all similar)
  function fuzzyFilter(rows, q){
    const s = norm(q);
    if (!s) return rows.slice();
    const aliases = [s, s.replace(/th/g,'t'), 'sitagu','သီတဂူ','thilashin','သီလရှင်','sudhamma','sasana','vihara','viharaya'];
    return rows.filter(r=>{
      const hay = norm([r.name,r.name_en,r.name_mm].join(' '));
      return aliases.some(a => hay.includes(a));
    });
  }

  // Render
  function draw(rows){
    markers.clearLayers();
    const pts=[];
    rows.forEach(r=>{
      if(!(r.lat&&r.lon)) return;
      pts.push([r.lat,r.lon]);
      const html = `<strong>${r.name}${r.__local?' <em>(local)</em>':''}</strong><br>
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
      card.innerHTML = `<h3>${r.name}${r.__local?' <span class="meta">(local)</span>':''}</h3>`
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

  // Data state
  let stateBBox = null;
  let stateAll = [];   // all places in state
  let tsBBox = null;   // selected township bbox
  let current = [];    // filtered set currently shown

  // Wiring
  loadStateBtn.addEventListener('click', async ()=>{
    const s = stateEl.value;
    if (!s){ setStatus('Select a state/region.'); return; }
    spin('Loading state…');
    try{
      const bb = await nominatim(s+', Myanmar');
      stateBBox = bb;
      map.fitBounds(boundsFromBBox(bb).pad(0.1));
      // Fetch all monasteries/nunneries in state
      const bboxStr = `${bb[0]},${bb[1]},${bb[2]},${bb[3]}`;
      const rows = await queryBBoxAll(bboxStr);
      stateAll = rows.slice();
      tsBBox = null;
      // Load townships
      setStatus('Loading townships…');
      const tss = await queryTownshipsInState(s);
      tsEl.innerHTML = '<option value="">(All in state)</option>';
      tss.forEach(t=>{ const o=document.createElement('option'); o.value=JSON.stringify(t.bbox); o.textContent=t.name; tsEl.appendChild(o); });
      tsEl.disabled=false; applyTsBtn.disabled=false;
      // Merge local overrides
      try{ const local = await loadLocalOverrides(); if (local.length && bb){ const merged = stateAll.concat(local.filter(r=> withinBBox(r.lat,r.lon, bb))); const seen=new Set(); stateAll = merged.filter(x=>{ if(seen.has(x.id)) return false; seen.add(x.id); return true; }); } }catch{}
      // Show all state results for now
      current = stateAll.slice();

      const nameQ = nameEl.value.trim();
      if (nameQ) current = fuzzyFilter(current, nameQ);
      // If still zero and we have a township bbox, try nationwide by name then clip
      if ((!current.length) && tsBBox){
        try{
          const wide = await nationwideByName(nameQ);
          current = wide.filter(r=> r.lat && r.lon && withinBBox(r.lat,r.lon, tsBBox));
        }catch{ /* ignore */ }
      }

      if (nameQ) current = fuzzyFilter(current, nameQ);
      countEl.textContent = current.length + ' places';
      draw(current); renderList(current);
      setStatus('Done.');
    }catch(e){ setStatus('⚠️ '+(e.message||String(e))); }
  });

  applyTsBtn.addEventListener('click', async ()=>{
    if (!stateBBox || !stateAll.length){ setStatus('Load a state first.'); return; }
    const val = tsEl.value;
    spin('Applying township…');
    try{
      if (!val){
        tsBBox = null;
        current = stateAll.slice();
      } else {
        const bb = JSON.parse(val);
        tsBBox = bb;
        // Filter state set by township bbox
        const filtered = stateAll.filter(r=> r.lat && r.lon && withinBBox(r.lat,r.lon, bb));
        // If too few (maybe missing centers), do a direct bbox query to be safe
        if (filtered.length < 3){
          const bboxStr = `${bb[0]},${bb[1]},${bb[2]},${bb[3]}`;
          const fresh = await queryBBoxAll(bboxStr);
          current = fresh;
        } else {
          current = filtered;
        }
        map.fitBounds(boundsFromBBox(bb).pad(0.05));
      }

      const nameQ = nameEl.value.trim();
      if (nameQ) current = fuzzyFilter(current, nameQ);
      // If still zero and we have a township bbox, try nationwide by name then clip
      if ((!current.length) && tsBBox){
        try{
          const wide = await nationwideByName(nameQ);
          current = wide.filter(r=> r.lat && r.lon && withinBBox(r.lat,r.lon, tsBBox));
        }catch{ /* ignore */ }
      }

      if (nameQ) current = fuzzyFilter(current, nameQ);
      countEl.textContent = current.length + ' places';
      draw(current); renderList(current);
      setStatus('Done.');
    }catch(e){ setStatus('⚠️ '+(e.message||String(e))); }
  });

  applyNameBtn.addEventListener('click', ()=>{
    if (!stateAll.length){ setStatus('Load a state first.'); return; }
    const q = nameEl.value.trim();
    let base = [];
    if (tsBBox){
      base = stateAll.filter(r=> r.lat && r.lon && withinBBox(r.lat,r.lon, tsBBox));
    } else {
      base = stateAll.slice();
    }
    current = fuzzyFilter(base, q);
    countEl.textContent = current.length + ' places';
    draw(current); renderList(current);
    setStatus('Done.');
  });
  nameEl.addEventListener('keydown', ev=>{ if(ev.key==='Enter') applyNameBtn.click(); });

  clearBtn.addEventListener('click', ()=>{
    stateEl.value=''; tsEl.innerHTML='<option value=\"\">(All in state)</option>'; tsEl.disabled=true; applyTsBtn.disabled=true;
    nameEl.value=''; stateBBox=null; tsBBox=null; stateAll=[]; current=[];
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


  forceBtn.addEventListener('click', async ()=>{
    if (!stateBBox){ setStatus('Load a state first.'); return; }
    spin('Force refreshing…');
    try{
      let bboxToUse = stateBBox;
      if (tsBBox) bboxToUse = tsBBox;
      const bboxStr = `${bboxToUse[0]},${bboxToUse[1]},${bboxToUse[2]},${bboxToUse[3]}`;
      const rows = await queryBBoxAll(bboxStr);
      // merge local again
      try{ const local = await loadLocalOverrides(); if (local.length){ const merged = rows.concat(local.filter(r=> withinBBox(r.lat,r.lon, bboxToUse))); const seen=new Set(); current = merged.filter(x=>{ if(seen.has(x.id)) return false; seen.add(x.id); return true; }); } else { current = rows; } }catch{ current = rows; }
      const nameQ = nameEl.value.trim();
      if (nameQ) current = fuzzyFilter(current, nameQ);
      countEl.textContent = current.length + ' places';
      draw(current); renderList(current);
      setStatus('Done.');
    }catch(e){ setStatus('⚠️ '+(e.message||String(e))); }
  });

})();