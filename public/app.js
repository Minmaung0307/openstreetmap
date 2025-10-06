(function(){
  // Map init
  var map = L.map('map', { zoomControl:true }).setView([19.8,96.0], 6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
    maxZoom: 19, attribution: '&copy; OpenStreetMap'
  }).addTo(map);
  var markers = L.layerGroup().addTo(map);

  // UI refs (expect index.html v3 layout)
  var stateEl = document.getElementById('state');
  var loadStateBtn = document.getElementById('loadState');
  var tsEl = document.getElementById('township');
  var applyTsBtn = document.getElementById('applyTownship');
  var nameEl = document.getElementById('name');
  var applyNameBtn = document.getElementById('applyName');
  var clearBtn = document.getElementById('clearAll');
  var statusEl = document.getElementById('status');
  var countEl = document.getElementById('count');
  var listEl = document.getElementById('list');
  var csvBtn = document.getElementById('csvBtn');
  var geojsonBtn = document.getElementById('geojsonBtn');

  // States list
  var STATES = ["Ayeyarwady","Bago","Chin","Kachin","Kayah","Kayin","Magway","Mandalay","Mon","Naypyidaw","Rakhine","Sagaing","Shan","Tanintharyi","Yangon"];
  if (stateEl && stateEl.options.length <= 1){
    STATES.forEach(function(s){
      var o=document.createElement('option'); o.value=s; o.textContent=s; stateEl.appendChild(o);
    });
  }

  // Helpers
  function setStatus(m){ if(statusEl) statusEl.textContent = m; }
  function spin(m){ setStatus('⏳ ' + m); }
  function sleep(ms){ return new Promise(function(r){ setTimeout(r,ms); }); }
  function norm(x){ return (x||'').toString().toLowerCase().normalize('NFC').trim(); }
  function withinBBox(lat,lon,b){ return (typeof lat==='number' && typeof lon==='number' && lat>=b[0] && lat<=b[2] && lon>=b[1] && lon<=b[3]); }
  function toCSV(rows){
    var head = ['id','name','name_en','name_mm','address','city','state','phone','website','lat','lon'];
    function esc2(v){ return '"' + String(v==null?'':v).replace(/"/g,'""') + '"'; }
    var all = [head.join(',')];
    rows.forEach(function(r){ all.push(head.map(function(k){ return esc2(r[k]); }).join(',')); });
    return all.join('\n');
  }
  function toGeoJSON(rows){
    return { type:'FeatureCollection', features: rows.filter(function(r){return r.lat&&r.lon;}).map(function(r){
      return { type:'Feature', geometry:{ type:'Point', coordinates:[r.lon,r.lat] }, properties:r };
    })};
  }
  function download(filename, blob){
    var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=filename; a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); },1000);
  }
  function boundsFromBBox(b){ return L.latLngBounds([b[0],b[1]],[b[2],b[3]]); }
  function esc(s){ return String(s||'').replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }

  // Overpass & Nominatim
  var OPS = ['https://overpass-api.de/api/interpreter','https://overpass.kumi.systems/api/interpreter','https://z.overpass-api.de/api/interpreter'];
  var opi = 0, coolUntil = 0;
  async function overpass(query){
    if (coolUntil && Date.now() < coolUntil){ await sleep(coolUntil - Date.now()); }
    var url = OPS[opi++ % OPS.length] + '?data=' + encodeURIComponent(query);
    var res = await fetch(url);
    if (res.status === 429){ coolUntil = Date.now()+8000; await sleep(1200); return overpass(query); }
    if (!res.ok) throw new Error('Overpass '+res.status);
    var ct=(res.headers.get('content-type')||'').toLowerCase();
    if (ct.indexOf('application/json') === -1){ var t=await res.text(); throw new Error('Overpass non-JSON: '+t.slice(0,80)); }
    return res.json();
  }
  async function nominatim(q){
    var url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q='+encodeURIComponent(q);
    var res = await fetch(url, { headers:{'Accept-Language':'en'} });
    if (!res.ok) throw new Error('Nominatim failed');
    var arr = await res.json();
    if (!arr.length) throw new Error('No match');
    var r = arr[0];
    if (r.boundingbox){
      return [parseFloat(r.boundingbox[0]), parseFloat(r.boundingbox[2]), parseFloat(r.boundingbox[1]), parseFloat(r.boundingbox[3])];
    }
    var lat=parseFloat(r.lat), lon=parseFloat(r.lon);
    return [lat-0.1, lon-0.1, lat+0.1, lon+0.1];
  }

  // Mapping
  function mapElements(data){
    var out = (data.elements||[]).map(function(e){
      var t=e.tags||{}; var lat=e.lat||(e.center&&e.center.lat); var lon=e.lon||(e.center&&e.center.lon);
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
        lat: lat, lon: lon
      };
    });
    var seen={}; var uniq=[];
    out.forEach(function(r){ if(!seen[r.id]){ seen[r.id]=1; uniq.push(r); } });
    return uniq;
  }

  async function queryBBoxAll(bboxStr){
    var q = '[out:json][timeout:25];('
          + 'node["amenity"~"monastery|nunnery|place_of_worship", i]["religion"="buddhist"](' + bboxStr + ');'
          + 'way["amenity"~"monastery|nunnery|place_of_worship", i]["religion"="buddhist"](' + bboxStr + ');'
          + 'relation["amenity"~"monastery|nunnery|place_of_worship", i]["religion"="buddhist"](' + bboxStr + ');'
          + 'node["building"~"monastery|nunnery", i](' + bboxStr + ');'
          + 'way["building"~"monastery|nunnery", i](' + bboxStr + ');'
          + 'relation["building"~"monastery|nunnery", i](' + bboxStr + ');'
          + ');out center tags;';
    var data = await overpass(q);
    return mapElements(data);
  }

  async function nationwideByName(qtext){
    var q = (qtext||'').trim(); if(!q) return [];
    var aliases=[q, q.replace(/th/ig,'t'),'Sitagu','စိတ္တဂူ','သီတဂူ','Thathudaza','Thudaza','Thawtuzana','သောတုဇန','Thilashin','သီလရှင်','Sudhamma','သုဓမ္မ','Sasana','သာသနာ','Vihara','Viharaya','Monastery','Nunnery'];
    var uniq=[]; var seen={};
    aliases.forEach(function(a){ var k=a.toLowerCase(); if(!seen[k]){ seen[k]=1; uniq.push(a); } });
    var re = '(' + uniq.map(esc).join('|') + ')';
    var query = '[out:json][timeout:30];area["ISO3166-1"="MM"]->.mm;('
              + 'node(area.mm)["amenity"~"monastery|nunnery|place_of_worship", i]["religion"="buddhist"]["name"~"' + re + '", i];'
              + 'way(area.mm)["amenity"~"monastery|nunnery|place_of_worship", i]["religion"="buddhist"]["name"~"' + re + '", i];'
              + 'relation(area.mm)["amenity"~"monastery|nunnery|place_of_worship", i]["religion"="buddhist"]["name"~"' + re + '", i];'
              + 'node(area.mm)["building"~"monastery|nunnery", i]["name"~"' + re + '", i];'
              + 'way(area.mm)["building"~"monastery|nunnery", i]["name"~"' + re + '", i];'
              + 'relation(area.mm)["building"~"monastery|nunnery", i]["name"~"' + re + '", i];'
              + ');out center tags;';
    var data = await overpass(query);
    return mapElements(data);
  }

  async function loadLocalOverrides(){
    try{
      var res = await fetch('local-overrides.json', { cache:'no-store' });
      if (!res.ok) return [];
      var arr = await res.json();
      if (!Array.isArray(arr)) return [];
      return arr.map(function(r,i){
        return {
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
        };
      }).filter(function(r){ return typeof r.lat==='number' && typeof r.lon==='number'; });
    }catch(_){ return []; }
  }

  // Render
  function markerPopupHTML(r){
    var parts = [];
    parts.push('<strong>' + (r.name||'Unknown') + (r.__local?' <em>(local)</em>':'') + '</strong><br>');
    var line2 = [];
    if (r.city) line2.push(r.city);
    if (r.state) line2.push(r.state);
    parts.push(line2.join(', ') + '<br>');
    if (r.address) parts.push(r.address + '<br>');
    if (r.phone) parts.push('📞 ' + r.phone + '<br>');
    if (r.website) parts.push('<a href="' + r.website + '" target="_blank">🌐 Website</a><br>');
    if (r.lat && r.lon){
      parts.push('<a href="https://www.google.com/maps/dir/?api=1&destination=' + r.lat + ',' + r.lon + '" target="_blank">Directions</a>');
    }
    return parts.join('');
  }

  function draw(rows){
    markers.clearLayers();
    var pts=[];
    rows.forEach(function(r){
      if(!(r.lat&&r.lon)) return;
      pts.push([r.lat,r.lon]);
      L.marker([r.lat,r.lon]).bindPopup(markerPopupHTML(r)).addTo(markers);
    });
    if (pts.length){
      var b=L.latLngBounds(pts);
      if (b.isValid()) map.fitBounds(b.pad(0.2));
    }
  }

  function renderList(rows){
    listEl.innerHTML='';
    if (!rows.length){ listEl.innerHTML='<div class="card">No matches.</div>'; return; }
    rows.forEach(function(r){
      var card=document.createElement('div'); card.className='card';
      var metaTag = r.__local ? ' <span class="meta">(local)</span>' : '';
      var html = '';
      html += '<h3>' + (r.name||'Unknown') + metaTag + '</h3>';
      var line2 = [];
      if (r.city) line2.push(r.city);
      if (r.state) line2.push(r.state);
      html += '<div class="meta">' + line2.join(', ') + '</div>';
      html += '<div class="meta">' + (r.address||'') + '</div>';
      html += '<div class="row">';
      if (r.phone) html += '<a href="tel:' + r.phone + '">📞 ' + r.phone + '</a>';
      if (r.website) html += '<a href="' + r.website + '" target="_blank">🌐 Website</a>';
      if (r.lat&&r.lon) html += '<a href="https://www.openstreetmap.org/?mlat=' + r.lat + '&mlon=' + r.lon + '#map=18/' + r.lat + '/' + r.lon + '" target="_blank">OSM</a>';
      html += '</div>';
      card.innerHTML = html;
      listEl.appendChild(card);
    });
  }

  // Data state
  var stateBBox = null;
  var stateAll = [];
  var tsBBox = null;
  var current = [];

  function fuzzyFilter(rows, q){
    var s = norm(q);
    if (!s) return rows.slice();
    var aliases = [s, s.replace(/th/g,'t'), 'sitagu','စိတ္တဂူ','သီတဂူ','thathudaza','thudaza','thawtuzana','သောတုဇန','thilashin','သီလရှင်','sudhamma','သုဓမ္မ','sasana','သာသနာ','vihara','viharaya'];
    return rows.filter(function(r){
      var hay = norm((r.name||'')+' '+(r.name_en||'')+' '+(r.name_mm||''));
      for (var i=0;i<aliases.length;i++){ if (hay.indexOf(aliases[i]) !== -1) return true; }
      return false;
    });
  }

  // Wiring
  if (loadStateBtn){
    loadStateBtn.addEventListener('click', async function(){
      var s = stateEl.value;
      if (!s){ setStatus('Select a state/region.'); return; }
      spin('Loading state…');
      try{
        var bb = await nominatim(s+', Myanmar');
        stateBBox = bb;
        map.fitBounds(boundsFromBBox(bb).pad(0.1));
        // Fetch all monasteries/nunneries in state
        var bboxStr = bb[0] + ',' + bb[1] + ',' + bb[2] + ',' + bb[3];
        var rows = await queryBBoxAll(bboxStr);
        stateAll = rows.slice();
        tsBBox = null;
        // Load townships
        setStatus('Loading townships…');
        var tss = await (async function queryTownshipsInState(stateName){
          var variants = [stateName, stateName+' Region', stateName+' State', stateName+' Division', stateName+' Union Territory'];
          for(var vi=0; vi<variants.length; vi++){
            var v = variants[vi];
            var q = '[out:json][timeout:25];area["ISO3166-1"="MM"]->.mm;area.mm["name"="'+esc(v)+'"]["boundary"="administrative"]["admin_level"~"4|5"]->.st;relation(area.st)["boundary"="administrative"]["admin_level"~"6|7"];out bb tags;';
            try{
              var d = await overpass(q);
              var rowsX = (d.elements||[]).map(function(e){
                var t=e.tags||{};
                var bbx = e.bounds ? [e.bounds.minlat, e.bounds.minlon, e.bounds.maxlat, e.bounds.maxlon] : null;
                return { id:e.id, name: t['name:my']||t['name']||t['name:en']||'Unknown', bbox: bbx };
              }).filter(function(x){ return x.bbox; });
              if (rowsX.length){ rowsX.sort(function(a,b){ return a.name.localeCompare(b.name); }); return rowsX; }
            }catch(_){}
          }
          // Fallback: by bbox
          var bb2 = await nominatim(stateName + ', Myanmar');
          var bbox2 = bb2[0] + ',' + bb2[1] + ',' + bb2[2] + ',' + bb2[3];
          var d2 = await overpass('[out:json][timeout:25];relation["boundary"="administrative"]["admin_level"~"6|7"](' + bbox2 + ');out bb tags;');
          var rows2 = (d2.elements||[]).map(function(e){
            var t=e.tags||{};
            var bbx2 = e.bounds ? [e.bounds.minlat, e.bounds.minlon, e.bounds.maxlat, e.bounds.maxlon] : null;
            return { id:e.id, name: t['name:my']||t['name']||t['name:en']||'Unknown', bbox: bbx2 };
          }).filter(function(x){ return x.bbox; });
          rows2.sort(function(a,b){ return a.name.localeCompare(b.name); });
          return rows2;
        })(s);
        tsEl.innerHTML = '<option value="">(All in state)</option>';
        tss.forEach(function(t){ var o=document.createElement('option'); o.value=JSON.stringify(t.bbox); o.textContent=t.name; tsEl.appendChild(o); });
        tsEl.disabled=false; applyTsBtn.disabled=false;

        // Merge local overrides within state bbox
        try{
          var local = await loadLocalOverrides();
          if (local.length){
            var merged = stateAll.concat(local.filter(function(r){ return withinBBox(r.lat,r.lon, bb); }));
            var seenIds={}; stateAll = merged.filter(function(x){ if(seenIds[x.id]) return false; seenIds[x.id]=1; return true; });
          }
        }catch(_){}

        // Show state results (+ optional name filter)
        current = stateAll.slice();
        var nameQ = nameEl.value.trim();
        if (nameQ) current = fuzzyFilter(current, nameQ);
        countEl.textContent = current.length + ' places';
        draw(current); renderList(current);
        setStatus('Done.');
      }catch(e){ setStatus('⚠️ ' + (e.message||String(e))); }
    });
  }

  if (applyTsBtn){
    applyTsBtn.addEventListener('click', async function(){
      if (!stateBBox || !stateAll.length){ setStatus('Load a state first.'); return; }
      var val = tsEl.value;
      spin('Applying township…');
      try{
        if (!val){
          tsBBox = null;
          current = stateAll.slice();
        } else {
          var bb = JSON.parse(val);
          tsBBox = bb;
          var filtered = stateAll.filter(function(r){ return r.lat && r.lon && withinBBox(r.lat,r.lon, bb); });
          if (filtered.length < 3){
            var bboxStr = bb[0] + ',' + bb[1] + ',' + bb[2] + ',' + bb[3];
            var fresh = await queryBBoxAll(bboxStr);
            // merge local overrides in this bbox
            try{
              var local2 = await loadLocalOverrides();
              if (local2.length){
                var merged = fresh.concat(local2.filter(function(r){ return withinBBox(r.lat,r.lon, bb); }));
                var seen2={}; filtered = merged.filter(function(x){ if(seen2[x.id]) return false; seen2[x.id]=1; return true; });
              } else {
                filtered = fresh;
              }
            }catch(_){ filtered = fresh; }
          }
          current = filtered;
          map.fitBounds(boundsFromBBox(bb).pad(0.05));
        }
        var nameQ = nameEl.value.trim();
        if (nameQ) current = fuzzyFilter(current, nameQ);
        // If still zero and we have a township bbox, try nationwide then clip
        if ((!current.length) && tsBBox){
          try{
            var wide = await nationwideByName(nameQ);
            current = wide.filter(function(r){ return r.lat && r.lon && withinBBox(r.lat,r.lon, tsBBox); });
          }catch(_){}
        }
        countEl.textContent = current.length + ' places';
        draw(current); renderList(current);
        setStatus('Done.');
      }catch(e){ setStatus('⚠️ ' + (e.message||String(e))); }
    });
  }

  if (applyNameBtn){
    applyNameBtn.addEventListener('click', async function(){
      if (!stateAll.length){ setStatus('Load a state first.'); return; }
      var q = nameEl.value.trim();
      var base = tsBBox ? stateAll.filter(function(r){ return r.lat && r.lon && withinBBox(r.lat,r.lon, tsBBox); }) : stateAll.slice();
      current = fuzzyFilter(base, q);
      // If zero with township selected, nationwide fallback clipped
      if ((!current.length) && tsBBox && q){
        try{
          var wide = await nationwideByName(q);
          current = wide.filter(function(r){ return r.lat && r.lon && withinBBox(r.lat,r.lon, tsBBox); });
        }catch(_){}
      }
      countEl.textContent = current.length + ' places';
      draw(current); renderList(current);
      setStatus('Done.');
    });
    nameEl.addEventListener('keydown', function(ev){ if(ev.key==='Enter') applyNameBtn.click(); });
  }

  if (clearBtn){
    clearBtn.addEventListener('click', function(){
      stateEl.value=''; tsEl.innerHTML='<option value="">(All in state)</option>'; tsEl.disabled=true; applyTsBtn.disabled=true;
      nameEl.value=''; stateBBox=null; tsBBox=null; stateAll=[]; current=[];
      markers.clearLayers(); listEl.innerHTML=''; countEl.textContent=''; setStatus('Cleared.');
    });
  }

  // Force Refresh button inject (safe even if already added)
  (function ensureForceRefresh(){
    var row = document.querySelector('header .row');
    if (!row) return;
    if (!document.getElementById('forceRefresh')){
      var btn=document.createElement('button'); btn.id='forceRefresh'; btn.textContent='Force Refresh'; row.appendChild(btn);
      btn.addEventListener('click', async function(){
        if (!stateBBox){ setStatus('Load a state first.'); return; }
        spin('Force refreshing…');
        try{
          var bboxToUse = tsBBox ? tsBBox : stateBBox;
          var bboxStr = bboxToUse[0] + ',' + bboxToUse[1] + ',' + bboxToUse[2] + ',' + bboxToUse[3];
          var rows = await queryBBoxAll(bboxStr);
          // merge local overrides again in active bbox
          try{
            var local3 = await loadLocalOverrides();
            if (local3.length){
              var merged = rows.concat(local3.filter(function(r){ return withinBBox(r.lat,r.lon, bboxToUse); }));
              var seen3={}; current = merged.filter(function(x){ if(seen3[x.id]) return false; seen3[x.id]=1; return true; });
            } else { current = rows; }
          }catch(_){ current = rows; }
          var nameQ = nameEl.value.trim();
          if (nameQ) current = fuzzyFilter(current, nameQ);
          countEl.textContent = current.length + ' places';
          draw(current); renderList(current);
          setStatus('Done.');
        }catch(e){ setStatus('⚠️ ' + (e.message||String(e))); }
      });
    }
  })();

  // Export
  if (csvBtn){
    csvBtn.addEventListener('click', function(){
      if (!current.length){ setStatus('Nothing to export.'); return; }
      var csv = toCSV(current);
      download('monasteries.csv', new Blob([csv], {type:'text/csv'}));
    });
  }
  if (geojsonBtn){
    geojsonBtn.addEventListener('click', function(){
      if (!current.length){ setStatus('Nothing to export.'); return; }
      var gj = JSON.stringify(toGeoJSON(current), null, 2);
      download('monasteries.geojson', new Blob([gj], {type:'application/geo+json'}));
    });
  }
})();