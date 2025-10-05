const tabs=document.querySelectorAll('.tab');const panels=document.querySelectorAll('.tabpanel');
tabs.forEach(b=>b.addEventListener('click',()=>{if(b.id==='langToggle'){toggleLang();return}tabs.forEach(x=>x.classList.remove('active'));b.classList.add('active');panels.forEach(p=>p.classList.remove('active'));document.getElementById(b.dataset.tab).classList.add('active')}));
let lang=localStorage.getItem('mmapp.lang')||'mm';function toggleLang(){lang=(lang==='mm'?'en':'mm');localStorage.setItem('mmapp.lang',lang);applyLang()}
function applyLang(){const d=lang==='mm'?{searchPh:'ကျောင်းနာမည်၊ မြို့/ပြည်နယ် (မြန်မာ/English)',states:'States/Regions (အားလုံး)',reset:'Reset',eventsPh:'ပွဲခေါင်းစဉ် / ကျောင်း / မြို့'}:{searchPh:'Temple name, city/state (Myanmar/English)',states:'States/Regions (All)',reset:'Reset',eventsPh:'Search events (title, temple, city)'};document.getElementById('q').placeholder=d.searchPh;document.getElementById('region').options[0].textContent=d.states;document.getElementById('reset').textContent=d.reset;document.getElementById('eq').placeholder=d.eventsPh;document.getElementById('ereset').textContent=d.reset}applyLang();
const mmRegions=['Ayeyarwady','Bago','Chin','Kachin','Kayah','Kayin','Magway','Mandalay','Mon','Naypyidaw','Rakhine','Sagaing','Shan','Tanintharyi','Yangon'];const regionSel=document.getElementById('region');mmRegions.forEach(r=>{const o=document.createElement('option');o.value=r;o.textContent=r;regionSel.appendChild(o)});
const MIN_ZOOM = 8;
let map=L.map('map',{zoomControl:true});L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap'}).addTo(map);map.setView([21.5,96.0],6);let markerLayer=L.layerGroup().addTo(map);
const q=document.getElementById('q'),tradSel=document.getElementById('trad'),resetBtn=document.getElementById('reset'),list=document.getElementById('list');function norm(x){return (x||'').toString().toLowerCase().normalize('NFC').trim()}
async function fetchTemplesForView(){const b=map.getBounds();const bbox=`${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`;const query=`[out:json][timeout:25];(node["amenity"="place_of_worship"]["religion"="buddhist"](${bbox});way["amenity"="place_of_worship"]["religion"="buddhist"](${bbox});relation["amenity"="place_of_worship"]["religion"="buddhist"](${bbox}););out center tags;`;const url='https://overpass-api.de/api/interpreter?data='+encodeURIComponent(query);const res=await fetch(url);if(!res.ok)throw new Error('Overpass failed: '+res.status);const data=await res.json();return (data.elements||[]).map(e=>{const lat=e.lat||e.center?.lat;const lon=e.lon||e.center?.lon;const t=e.tags||{};return{id:e.id,name:t['name:my']||t['name']||t['name:en']||'Unknown',name_en:t['name:en']||'',name_mm:t['name:my']||'',addr:t['addr:full']||'',city:t['addr:city']||'',state:t['addr:state']||t['is_in:state']||'',phone:t['contact:phone']||t['phone']||'',website:t['contact:website']||t['website']||'',lat,lon,raw:t}})}
let currentItems=[];async function refresh(){list.innerHTML='<div class="card">Searching current map area…</div>';markerLayer.clearLayers();try{const items=await fetchTemplesForView();currentItems=items;render()}catch(e){console.error(e);list.innerHTML='<div class="card">❌ Network error or Overpass rate limit. Zoom/change area and retry.</div>'}}
function matchesTemples(t){const qq=norm(q.value);const reg=regionSel.value;const trad=tradSel.value;const tradOk=!trad||(trad==='myanmar'&&/monastery|ဗိဟာရ|သာသနာ/i.test(t.name))||(trad==='thai'&&/wat|thai/i.test([t.name,t.name_en].join(' ')))||(trad==='lao'&&/lao|xaya?ram/i.test([t.name,t.name_en].join(' ')))||(trad==='khmer'&&/khmer|pagoda/i.test([t.name,t.name_en].join(' ')))||(trad==='lanka'&&/vihara|viharaya|sri lanka|thera/i.test([t.name,t.name_en].join(' ')));const regOk=!reg||(t.state&&t.state.toLowerCase().includes(reg.toLowerCase()));const textOk=!qq||[t.name,t.name_en,t.name_mm,t.city,t.state,t.addr].some(v=>norm(v).includes(qq));return tradOk&&regOk&&textOk}

// ==== Nationwide name search fallback (Myanmar) ====
function buildNameRegexForNationwide(raw){
  const q = (raw||'').trim();
  if (!q) return null;
  const aliases = [
    q,
    q.replace(/th/ig,'t'),
    'Sitagu','သီတဂူ','သီတကု',
    'Thathudaza','Thudaza','Thawtuzana','သောတုဇန',
    'Sudhamma','သုဓမ္မ','Sasana','သာသနာ','Vihara','Viharaya','Monastery','သင်္ဂဟ','ဗိဟာရ'
  ];
  const uniq = [...new Set(aliases)].map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
  return `(${uniq.join('|')})`;
}

async function searchNationwideByName(qtext){
  const re = buildNameRegexForNationwide(qtext);
  if (!re){ return []; }

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

    // Fallback for schools/centres named Sitagu/Thilashin/etc.
    node(area.mm)["amenity"~"school|college|community_centre", i]["name"~"${re}", i];
    way (area.mm)["amenity"~"school|college|community_centre", i]["name"~"${re}", i];
    relation(area.mm)["amenity"~"school|college|community_centre", i]["name"~"${re}", i];
  );
  out center tags;`;

  const data = await fetchOverpass(query);
  const els = (data.elements||[]).map(e=>{
    const lat = e.lat || e.center?.lat; const lon = e.lon || e.center?.lon;
    const t = e.tags || {};
    return {
      id: e.id,
      name: t['name:my'] || t['name'] || t['name:en'] || 'Unknown',
      name_en: t['name:en'] || '',
      name_mm: t['name:my'] || '',
      addr: t['addr:full'] || '',
      city: t['addr:city'] || '',
      state: t['addr:state'] || t['is_in:state'] || '',
      phone: t['contact:phone'] || t['phone'] || '',
      website: t['contact:website'] || t['website'] || '',
      lat, lon, raw: t
    };
  });
  const seen = new Set(); const unique = [];
  for (const it of els){ if (!seen.has(it.id)) { seen.add(it.id); unique.push(it); } }
  return unique.slice(0, 250); // cap for performance
}

function render(){const rows=currentItems.filter(matchesTemples);list.innerHTML='';if(!rows.length){list.innerHTML='<div class="card">No monasteries in this area/search. Try zooming/moving the map or clear filters.</div>'}const bounds=[];rows.forEach(t=>{const el=document.createElement('div');el.className='card';el.innerHTML=`<h3>${t.name}</h3><div class="meta">${[t.city,t.state].filter(Boolean).join(', ')}</div>${t.addr?`<div class="meta">${t.addr}</div>`:''}<div class="actions">${t.phone?`<a href="tel:${t.phone}">📞 ${t.phone}</a>`:''}${t.website?`<a href="${t.website}" target="_blank" rel="noopener">🌐 Website</a>`:''}</div>`;list.appendChild(el);if(t.lat&&t.lon){const m=L.marker([t.lat,t.lon]).bindPopup(`<strong>${t.name}</strong><br>${[t.city,t.state].filter(Boolean).join(', ')}`);markerLayer.addLayer(m);bounds.push([t.lat,t.lon])}});if(bounds.length){const b=L.latLngBounds(bounds);if(b.isValid())map.fitBounds(b.pad(0.2))}}
q.addEventListener('input',debounce(render,250));regionSel.addEventListener('change',render);tradSel.addEventListener('change',render);document.getElementById('reset').addEventListener('click',()=>{q.value='';regionSel.value='';tradSel.value='';render()});map.on('moveend',debounce(refresh,350));refresh();function debounce(fn,ms){let t;return(...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms)}}
const MONTHS=Array.from({length:12},(_,i)=>new Date(2000,i,1).toLocaleString('en-US',{month:'long'}));const emonth=document.getElementById('emonth');const estate=document.getElementById('estate');const eq=document.getElementById('eq');const egrid=document.getElementById('eventGrid');(function(){const o0=document.createElement('option');o0.value='';o0.textContent='All Months';emonth.appendChild(o0);MONTHS.forEach((m,i)=>{const o=document.createElement('option');o.value=String(i+1).padStart(2,'0');o.textContent=m;emonth.appendChild(o)});const s0=document.createElement('option');s0.value='';s0.textContent='All States';estate.appendChild(s0);['Ayeyarwady','Bago','Chin','Kachin','Kayah','Kayin','Magway','Mandalay','Mon','Naypyidaw','Rakhine','Sagaing','Shan','Tanintharyi','Yangon'].forEach(s=>{const o=document.createElement('option');o.value=s;o.textContent=s;estate.appendChild(o)})})();
let eventsData=[];async function loadEvents(){try{const res=await fetch('events-mm.json',{cache:'no-store'});if(!res.ok)throw new Error('events-mm.json not found');const d=await res.json();eventsData=Array.isArray(d)?d:[]}catch{eventsData=[]}renderEvents()}
function host(u){try{return new URL(u).host.replace(/^www\./,'')}catch{return'link'}}
function matchEvent(e){const t=norm(eq.value);const m=emonth.value;const st=estate.value;const txt=!t||[e.title,e.templeName,e.city,e.state].some(v=>norm(v).includes(t));const mon=!m||(String((e.dateStart||'').slice(5,7))===m||String((e.dateEnd||'').slice(5,7))===m);const sOk=!st||(e.state===st);return txt&&mon&&sOk}
function renderEvents(){egrid.innerHTML='';const rows=eventsData.filter(matchEvent).sort((a,b)=>(a.dateStart||'').localeCompare(b.dateStart||''));if(!rows.length){egrid.innerHTML='<div class="card">No events yet. Edit <code>events-mm.json</code>.</div>';return}rows.forEach(e=>{const date=e.dateEnd&&e.dateEnd!==e.dateStart?`${e.dateStart} → ${e.dateEnd}`:(e.dateStart||'');const img=e.image||'images/event-placeholder.jpg';const h=e.link?host(e.link):null;const card=document.createElement('article');card.className='event-card';card.innerHTML=`<img class="event-thumb" src="${img}" alt="${e.title||'Event'}"><div class="event-body"><div class="event-title">${e.title||''}</div><div class="meta">${date}</div><div>${e.templeName||''}</div><div>${e.city||''}${e.state?', '+e.state:''}</div><div class="meta">${e.address||''}</div><div class="btn-row">${e.link?`<a class="btn-link" href="${e.link}" target="_blank" rel="noopener">🔗 ${h}</a>`:''}</div></div>`;egrid.appendChild(card)})}
eq.addEventListener('input',renderEvents);emonth.addEventListener('change',renderEvents);estate.addEventListener('change',renderEvents);document.getElementById('ereset').addEventListener('click',()=>{eq.value='';emonth.value='';estate.value='';renderEvents()});loadEvents();
const form=document.getElementById('f');const status=document.getElementById('status');document.getElementById('downloadJSON').addEventListener('click',()=>{const data=Object.fromEntries(new FormData(form));const blob=new Blob([JSON.stringify({type:'submission',data,ts:Date.now()},null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='submission.json';a.click();status.textContent='Saved as submission.json'});
