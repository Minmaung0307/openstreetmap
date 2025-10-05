(function(start){
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})(function(){

  // ---------------- Tabs & Lang ----------------
  const tabs = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.tabpanel');
  tabs.forEach(b=>b.addEventListener('click', ()=>{
    if (b.id === 'langToggle'){ toggleLang(); return; }
    tabs.forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    panels.forEach(p=>p.classList.remove('active'));
    document.getElementById(b.dataset.tab).classList.add('active');
  }));

  let lang = localStorage.getItem('mmapp.lang') || 'mm';
  function toggleLang(){ lang = (lang==='mm'?'en':'mm'); localStorage.setItem('mmapp.lang', lang); applyLang(); }
  function applyLang(){
    const d = (lang==='mm') ? {
      searchPh:'ကျောင်းနာမည်၊ မြို့/ပြည်နယ် (မြန်မာ/English)',
      states:'States/Regions (အားလုံး)', reset:'Reset', eventsPh:'ပွဲခေါင်းစဉ် / ကျောင်း / မြို့'
    } : {
      searchPh:'Temple name, city/state (Myanmar/English)',
      states:'States/Regions (All)', reset:'Reset', eventsPh:'Search events (title, temple, city)'
    };
    const Q = (id)=>document.getElementById(id);
    if (Q('q')) Q('q').placeholder = d.searchPh;
    if (Q('region')) Q('region').options[0].textContent = d.states;
    if (Q('reset')) Q('reset').textContent = d.reset;
    if (Q('eq')) Q('eq').placeholder = d.eventsPh;
    if (Q('ereset')) Q('ereset').textContent = d.reset;
  }
  applyLang();

  const mmRegions=['Ayeyarwady','Bago','Chin','Kachin','Kayah','Kayin','Magway','Mandalay','Mon','Naypyidaw','Rakhine','Sagaing','Shan','Tanintharyi','Yangon'];
  const regionSel = document.getElementById('region');
  if (regionSel){
    mmRegions.forEach(r=>{
      const opt = document.createElement('option');
      opt.value = r; opt.textContent = r;
      regionSel.appendChild(opt);
    });
  } else {
    console.warn('Region select (#region) not found at init time');
  }

  // ---------------- Map & Overpass ----------------
  const MIN_ZOOM = 9;
  const FETCH_DEBOUNCE_MS = 1200;

  let map = L.map('map', { zoomControl:true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap'}).addTo(map);
  map.setView([21.5,96.0], 6);
  let markerLayer = L.layerGroup().addTo(map);

  const q = document.getElementById('q'),
        tradSel = document.getElementById('trad'),
        resetBtn = document.getElementById('reset'),
        list = document.getElementById('list');

  function norm(x){ return (x||'').toString().toLowerCase().normalize('NFC').trim(); }
  function debounce(fn,ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms); }; }

  // Anti-429 helpers
  const OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://z.overpass-api.de/api/interpreter'
  ];
  let __opIndex = 0;
  function opEndpoint(){ return OVERPASS_ENDPOINTS[(__opIndex++) % OVERPASS_ENDPOINTS.length]; }
  function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
  function jitter(ms){ return ms + Math.floor(Math.random()*250); }

  const BBOX_CACHE_TTL_MS = 3*60*1000;
  const bboxCache = new Map();
  function bboxKeyFromBounds(b){ const r=(x)=>x.toFixed(2); return [r(b.getSouth()),r(b.getWest()),r(b.getNorth()),r(b.getEast())].join(','); }

  async function fetchOverpassWithBackoff(query, tries=0){
    const url = opEndpoint() + '?data=' + encodeURIComponent(query);
    const res = await fetch(url);
    if (res.status === 429){
      const delay = Math.min(5000*Math.pow(1.6, tries), 15000);
      await sleep(jitter(delay));
      return fetchOverpassWithBackoff(query, tries+1);
    }
    if (!res.ok) throw new Error('Overpass failed: ' + res.status);
    return res.json();
  }

  function buildNameRegex(raw){
  // ==== Myanmar-wide fallback (by name) ====
  function buildNameRegexForNationwide(raw){
    const qv = (raw||'').trim();
    if (!qv) return null;
    const aliases = [
      qv, qv.replace(/th/ig,'t'),
      'Sitagu','သီတဂူ','Thathudaza','Thudaza','Thawtuzana','သောတုဇန',
      'Sudhamma','သုဓမ္မ','Sasana','သာသနာ','Vihara','Viharaya','Monastery'
    ];
    const uniq = [...new Set(aliases)].map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
    return `(${uniq.join('|')})`;
  }
  async function searchNationwideByName(qtext){
    const re = buildNameRegexForNationwide(qtext);
    if (!re) return [];
    const query = `[out:json][timeout:30];
      area["ISO3166-1"="MM"]->.mm;
      (
        node(area.mm)["amenity"="place_of_worship"]["religion"="buddhist"]["name"~"${re}", i];
        way (area.mm)["amenity"="place_of_worship"]["religion"="buddhist"]["name"~"${re}", i];
        relation(area.mm)["amenity"="place_of_worship"]["religion"="buddhist"]["name"~"${re}", i];

        node(area.mm)["amenity"="monastery"]["name"~"${re}", i];
        way (area.mm)["amenity"="monastery"]["name"~"${re}", i];
        relation(area.mm)["amenity"="monastery"]["name"~"${re}", i];

        node(area.mm)["building"="monastery"]["name"~"${re}", i];
        way (area.mm)["building"="monastery"]["name"~"${re}", i];
        relation(area.mm)["building"="monastery"]["name"~"${re}", i];

        node(area.mm)["amenity"~"school|college|community_centre", i]["name"~"${re}", i];
        way (area.mm)["amenity"~"school|college|community_centre", i]["name"~"${re}", i];
        relation(area.mm)["amenity"~"school|college|community_centre", i]["name"~"${re}", i];
      ); out center tags;`;
    const data = await fetchOverpassWithBackoff(query);
    const els = (data.elements||[]).map(e=>{
      const lat = e.lat || e.center?.lat, lon = e.lon || e.center?.lon, t = e.tags || {};
      return {
        id:e.id,
        name: t['name:my']||t['name']||t['name:en']||'Unknown',
        name_en: t['name:en']||'',
        name_mm: t['name:my']||'',
        addr: t['addr:full']||'',
        city: t['addr:city']||'',
        state: t['addr:state']||t['is_in:state']||'',
        phone: t['contact:phone']||t['phone']||'',
        website: t['contact:website']||t['website']||'',
        lat, lon, raw:t
      };
    });
    const seen = new Set(); const unique = [];
    for (const it of els){ if(!seen.has(it.id)){ seen.add(it.id); unique.push(it); } }
    return unique.slice(0, 250);
  }

    const qv = (raw||'').trim(); if (!qv) return null;
    const aliases = [qv, qv.replace(/th/ig,'t'),'Sitagu','သီတဂူ','Thathudaza','Thawtuzana','သောတုဇန','Sudhamma','သုဓမ္မ','Sasana','သာသနာ','Vihara','Monastery'];
    const uniq = [...new Set(aliases)].map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
    return `(${uniq.join('|')})`;
  }

  async function fetchTemplesForView(){
    if (map.getZoom() < MIN_ZOOM) return [];
    const b = map.getBounds();
    // cache check
    try{
      const key = bboxKeyFromBounds(b);
      const now = Date.now();
      const cached = bboxCache.get(key);
      if (cached && (now - cached.ts) < BBOX_CACHE_TTL_MS) return cached.items;
    }catch{}

    const bbox = `${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`;
    const nameRE = buildNameRegex(q && q.value);
    const nameBlock = nameRE ? `
      node["name"~"${nameRE}", i](${bbox});
      way ["name"~"${nameRE}", i](${bbox});
      relation["name"~"${nameRE}", i](${bbox});` : '';

    const query = `[out:json][timeout:25];
    (
      node["amenity"="place_of_worship"]["religion"="buddhist"](${bbox});
      way ["amenity"="place_of_worship"]["religion"="buddhist"](${bbox});
      relation["amenity"="place_of_worship"]["religion"="buddhist"](${bbox});

      node["amenity"="monastery"]["religion"="buddhist"](${bbox});
      way ["amenity"="monastery"]["religion"="buddhist"](${bbox});
      relation["amenity"="monastery"]["religion"="buddhist"](${bbox});

      node["building"="monastery"]["religion"="buddhist"](${bbox});
      way ["building"="monastery"]["religion"="buddhist"](${bbox});
      relation["building"="monastery"]["religion"="buddhist"](${bbox});

      ${nameBlock}
    ); out center tags;`;

    const data = await fetchOverpassWithBackoff(query);
    const items = (data.elements||[]).map(e=>{
      const lat=e.lat||e.center?.lat, lon=e.lon||e.center?.lon, t=e.tags||{};
      return {
        id:e.id,
        name:t['name:my']||t['name']||t['name:en']||'Unknown',
        name_en:t['name:en']||'',
        name_mm:t['name:my']||'',
        addr:t['addr:full']||'',
        city:t['addr:city']||'',
        state:t['addr:state']||t['is_in:state']||'',
        phone:t['contact:phone']||t['phone']||'',
        website:t['contact:website']||t['website']||'',
        lat, lon, raw:t
      };
    });

    // de-dup & cache
    const seen=new Set(); const unique=[];
    for (const it of items){ if(!seen.has(it.id)){ seen.add(it.id); unique.push(it); } }
    try{ const key=bboxKeyFromBounds(b); bboxCache.set(key,{ts:Date.now(),items:unique}); }catch{}
    return unique;
  }

  let currentItems = [];

  async function refresh(){
    if (map.getZoom() < MIN_ZOOM){
      list.innerHTML = '<div class="card">🔍 Zoom in (≥'+MIN_ZOOM+') to search monasteries / nunneries</div>';
      markerLayer.clearLayers(); return;
    }
    list.innerHTML = '<div class="card">Searching current map area…</div>';
    markerLayer.clearLayers();
    try{
      const items = await fetchTemplesForView();
      currentItems = items;
      if (!currentItems.length){
        const qEl = document.getElementById('q'); const qv = (qEl && qEl.value || '').trim();
        if (qv){
          list.innerHTML = '<div class="card">No monasteries in this area. <button id="mmwide">Search Myanmar by name</button></div>';
          const btn = document.getElementById('mmwide');
          if (btn){
            btn.addEventListener('click', async ()=>{
              list.innerHTML = '<div class="card">Searching Myanmar nationwide…</div>';
              const rows = await searchNationwideByName(qv);
              currentItems = rows; render();
              const pts = rows.filter(r=>r.lat&&r.lon).map(r=>[r.lat,r.lon]);
              if (pts.length){ const b = L.latLngBounds(pts); if (b.isValid()) map.fitBounds(b.pad(0.2)); }
            }, { once:true });
          }
          return;
        } else {
          list.innerHTML = '<div class="card">No monasteries yet. Try entering a name (e.g., Sitagu / သီတဂူ) or <button id="demoMM">Try a demo</button></div>';
          const d = document.getElementById('demoMM');
          if (d){
            d.addEventListener('click', async ()=>{
              if (qEl) qEl.value='Sitagu';
              list.innerHTML = '<div class="card">Searching Myanmar nationwide…</div>';
              const rows = await searchNationwideByName('Sitagu');
              currentItems = rows; render();
              const pts = rows.filter(r=>r.lat&&r.lon).map(r=>[r.lat,r.lon]);
              if (pts.length){ const b = L.latLngBounds(pts); if (b.isValid()) map.fitBounds(b.pad(0.2)); }
            }, { once:true });
          }
          return;
        }
      }
      render();
    }catch(e){
      console.error(e);
      list.innerHTML = '<div class="card">❌ Network/Overpass error. Please wait and try again.</div>';
    }
  }

  function matchesTemples(t){
    const qq=norm(q.value), reg=regionSel && regionSel.value, trad=tradSel && tradSel.value;
    const tradOk = !trad ||
      (trad==='myanmar' && /monastery|ဗိဟာရ|သာသနာ/i.test(t.name)) ||
      (trad==='thai' && /wat|thai/i.test([t.name,t.name_en].join(' '))) ||
      (trad==='lao' && /lao|xaya?ram/i.test([t.name,t.name_en].join(' '))) ||
      (trad==='khmer' && /khmer|pagoda/i.test([t.name,t.name_en].join(' '))) ||
      (trad==='lanka' && /vihara|viharaya|sri lanka|thera/i.test([t.name,t.name_en].join(' ')));
    const regOk = !reg || (t.state && t.state.toLowerCase().includes(reg.toLowerCase()));
    const textOk = !qq || [t.name,t.name_en,t.name_mm,t.city,t.state,t.addr].some(v=>norm(v).includes(qq));
    return tradOk && regOk && textOk;
  }

  function render(){
    const rows = currentItems.filter(matchesTemples);
    list.innerHTML = '';
    if (!rows.length){
      list.innerHTML = '<div class="card">No monasteries in this area/search. Try zooming/moving the map or clear filters.</div>';
      return;
    }
    const bounds=[];
    rows.forEach(t=>{
      const el=document.createElement('div');
      el.className='card';
      el.innerHTML = `<h3>${t.name}</h3>
        <div class="meta">${[t.city,t.state].filter(Boolean).join(', ')}</div>
        ${t.addr?`<div class="meta">${t.addr}</div>`:''}
        <div class="actions">
          ${t.phone?`<a href="tel:${t.phone}">📞 ${t.phone}</a>`:''}
          ${t.website?`<a href="${t.website}" target="_blank" rel="noopener">🌐 Website</a>`:''}
        </div>`;
      list.appendChild(el);
      if (t.lat && t.lon){
        const m=L.marker([t.lat,t.lon]).bindPopup(`<strong>${t.name}</strong><br>${[t.city,t.state].filter(Boolean).join(', ')}`);
        markerLayer.addLayer(m); bounds.push([t.lat,t.lon]);
      }
    });
    if (bounds.length){
      const b=L.latLngBounds(bounds); if (b.isValid()) map.fitBounds(b.pad(0.2));
    }
  }

  if (q) q.addEventListener('input', debounce(render, 250));
  if (regionSel) regionSel.addEventListener('change', render);
  if (tradSel) tradSel.addEventListener('change', render);
  if (resetBtn) resetBtn.addEventListener('click', ()=>{ if(q) q.value=''; if(regionSel) regionSel.value=''; if(tradSel) tradSel.value=''; render(); });

  map.on('moveend', debounce(refresh, FETCH_DEBOUNCE_MS));
  refresh();

  // ---------------- Events ----------------
  const MONTHS = Array.from({length:12},(_,i)=>new Date(2000,i,1).toLocaleString('en-US',{month:'long'}));
  const emonth = document.getElementById('emonth');
  const estate = document.getElementById('estate');
  const eq = document.getElementById('eq');
  const egrid = document.getElementById('eventGrid');

  (function initEventsUI(){
    if (emonth){
      const o0=document.createElement('option'); o0.value=''; o0.textContent='All Months'; emonth.appendChild(o0);
      MONTHS.forEach((m,i)=>{ const o=document.createElement('option'); o.value=String(i+1).padStart(2,'0'); o.textContent=m; emonth.appendChild(o); });
    }
    if (estate){
      const s0=document.createElement('option'); s0.value=''; s0.textContent='All States'; estate.appendChild(s0);
      ['Ayeyarwady','Bago','Chin','Kachin','Kayah','Kayin','Magway','Mandalay','Mon','Naypyidaw','Rakhine','Sagaing','Shan','Tanintharyi','Yangon']
      .forEach(s=>{ const o=document.createElement('option'); o.value=s; o.textContent=s; estate.appendChild(o); });
    }
  })();

  let eventsData = [];
  async function loadEvents(){
    try{
      const res = await fetch('events-mm.json',{cache:'no-store'});
      if (!res.ok) throw new Error('events-mm.json not found');
      const d = await res.json();
      eventsData = Array.isArray(d)? d : [];
    }catch{ eventsData = []; }
    renderEvents();
  }

  function host(u){ try{ return new URL(u).host.replace(/^www\./,''); }catch{ return 'link'; } }
  function matchEvent(e){
    const t = norm(eq && eq.value);
    const m = emonth && emonth.value;
    const st = estate && estate.value;
    const txt = !t || [e.title,e.templeName,e.city,e.state].some(v=>norm(v).includes(t));
    const mon = !m || String((e.dateStart||'').slice(5,7))===m || String((e.dateEnd||'').slice(5,7))===m;
    const sOk = !st || e.state===st;
    return txt && mon && sOk;
  }

  function renderEvents(){
    if (!egrid) return;
    egrid.innerHTML='';
    const rows = eventsData.filter(matchEvent).sort((a,b)=>(a.dateStart||'').localeCompare(b.dateStart||''));
    if (!rows.length){ egrid.innerHTML='<div class="card">No events yet. Edit <code>events-mm.json</code>.</div>'; return; }
    rows.forEach(e=>{
      const date = (e.dateEnd && e.dateEnd!==e.dateStart)? `${e.dateStart} → ${e.dateEnd}` : (e.dateStart||'');
      const img = e.image || 'images/event-placeholder.jpg';
      const h = e.link? host(e.link) : null;
      const card = document.createElement('article');
      card.className='event-card';
      card.innerHTML = `<img class="event-thumb" src="${img}" alt="${e.title||'Event'}">
        <div class="event-body">
          <div class="event-title">${e.title||''}</div>
          <div class="meta">${date}</div>
          <div>${e.templeName||''}</div>
          <div>${e.city||''}${e.state?', '+e.state:''}</div>
          <div class="meta">${e.address||''}</div>
          <div class="btn-row">${e.link?`<a class="btn-link" href="${e.link}" target="_blank" rel="noopener">🔗 ${h}</a>`:''}</div>
        </div>`;
      egrid.appendChild(card);
    });
  }

  if (eq) eq.addEventListener('input', renderEvents);
  if (emonth) emonth.addEventListener('change', renderEvents);
  if (estate) estate.addEventListener('change', renderEvents);
  const ereset = document.getElementById('ereset');
  if (ereset) ereset.addEventListener('click', ()=>{ if(eq) eq.value=''; if(emonth) emonth.value=''; if(estate) estate.value=''; renderEvents(); });
  loadEvents();

  // ---------------- Submit form (download JSON) ----------------
  const form = document.getElementById('f');
  const status = document.getElementById('status');
  const dlBtn = document.getElementById('downloadJSON');
  if (dlBtn && form && status){
    dlBtn.addEventListener('click', ()=>{
      const data = Object.fromEntries(new FormData(form));
      const blob = new Blob([JSON.stringify({type:'submission', data, ts:Date.now()}, null, 2)], {type:'application/json'});
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'submission.json'; a.click();
      status.textContent = 'Saved as submission.json';
    });
  }

});