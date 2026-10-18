/* Browser helper: inject as a classic script using Chrome evaluate_script. */
(function install(root) {
  'use strict';
  const VERSION = '2.3.0';
  if (root.WindyQuery?.version === VERSION) return root.WindyQuery.capabilities();
  if(root.WindyQuery?.status?.().background?.running||root.WindyQuery?.status?.().state==='running')throw new Error('Active runner: save/finish/cancel before changing helper version.');
  const GAP = 5100, SETTLE = 5500;
  const eventTimes = {read: 0, action: Date.now()};
  let plan = [], cursor = 0, rows = [], excluded = [];
  let busy = false, stopped = false, failure = null;
  let verifyMode = 'strict', background = null, heartbeat = null, configuration = null, displayTimeZone = 'Asia/Shanghai';
  let taskId=null,shardId=null,configFingerprint=null,attempt=0;
  const metrics = {actions: 0, reads: 0, startedAt: null};
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const fail = message => { throw new Error(message); };
  const api = () => root.W || fail('Windy W unavailable; open the normal Windy page.');
  const q = selector => root.document.querySelector(selector);
  const text = selector => q(selector)?.innerText?.trim() || q(selector)?.textContent?.trim() || '';
  const visible = el => !!el && el.getClientRects().length > 0 &&
    root.getComputedStyle(el).visibility !== 'hidden' && root.getComputedStyle(el).display !== 'none' &&
    root.getComputedStyle(el).opacity !== '0';
  const near = (a, b) => !!a && Math.abs(a.lat - b.lat) < 0.00015 &&
    Math.abs((a.lon ?? a.lng) - b.lon) < 0.00015;
  function capabilities() {
    const w = root.W;
    return {version: VERSION, ready: !!(w?.store?.get && w?.store?.set &&
      w?.map?.map?.latLngToContainerPoint && w?.map?.map?.setView && q('.box-text')),
      host: root.location?.hostname, model: w?.store?.get?.('product')};
  }
  function parse(raw, overlay) {
    const primary = raw.match(overlay === 'rain' ? /(-?\d+(?:[.,]\d+)?)\s*(mm|cm)\b/i : /(\d+(?:[.,]\d+)?)\s*%/);
    if (/unavailable|无法|premium|订阅/i.test(raw))fail('Picker restricted or unavailable.');
    if (/loading|加载/i.test(raw))fail('Picker still loading.');
    if (!primary)fail('Picker numeric value missing.');
    const value = Number(primary[1].replace(',', '.'));
    if (!Number.isFinite(value) || value < 0 || (overlay === 'clouds' && value > 100)) fail('Invalid value.');
    const period = overlay === 'rain' ? raw.match(/\((\d+(?:\.\d+)?)\s*h\)/i) : null;
    if (overlay === 'rain' && !period) fail('Rain accumulation duration missing; do not assume 3h.');
    if(period&&(!Number.isFinite(Number(period[1]))||Number(period[1])<=0))fail('Invalid accumulation duration.');
    const unit=overlay==='rain'?primary[2].toLowerCase():'%';
    return {value, unit,
      ...(unit==='cm'?{quantity:'snow-depth',phase:/湿雪|wet snow/i.test(raw)?'wet-snow':'snow'}:{}),
      ...(period ? {periodHours: Number(period[1])} : {})};
  }
  function normalize(config, now = Date.now()) {
    if (!config || !Array.isArray(config.points) || !config.points.length ||
      (!(Array.isArray(config.times)&&config.times.length) && !config.points.every(p=>Array.isArray(p.times)&&p.times.length)))
      fail('points and global or per-point times are required.');
    const ids = new Set(), points = [];
    for (const p of config.points) {
      if (!p.id || !Number.isFinite(p.lat) || !Number.isFinite(p.lon) || Math.abs(p.lat) > 85 ||
        Math.abs(p.lon) > 180 || !p.verifiedAt || !p.verification || !Number.isFinite(p.terrainElevationM))
        fail('Each point needs id, valid coordinates, verifiedAt, verification, and terrainElevationM.');
      if (ids.has(p.id)) {
        const old = points.find(x => x.id === p.id);
        if (old.lat !== p.lat || old.lon !== p.lon) fail('Same point id has conflicting coordinates.');
        continue;
      }
      ids.add(p.id); points.push({...p});
    }
    const layers = [...new Set(config.overlays || ['rain', 'clouds'])];
    if (!layers.length || layers.some(x => !['rain', 'clouds'].includes(x))) fail('Supported overlays: rain, clouds.');
    const times = [], outside = [];
    for (const iso of [...new Set(config.times || [])]) {
      if (typeof iso !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(iso))
        fail('Every time must be an ISO timestamp with explicit timezone.');
      const ts = Date.parse(iso);
      if (!Number.isFinite(ts)) fail('Invalid timestamp.');
      if (ts < now || ts - now > 168 * 3600000) outside.push({time: iso, reason: 'outside-future-168h'});
      else if (!times.some(t => t.ts === ts)) times.push({iso, ts});
    }
    times.sort((a, b) => a.ts - b.ts);
    return {jobs: points.flatMap(point => {
      if (point.times) {
        const isolated={...point};delete isolated.times;delete isolated.overlayTimes;
        if(point.overlayTimes){
          const jobs=[];
          for(const overlay of layers){const ts=point.overlayTimes[overlay]||[];if(!ts.length)continue;
            const sub=normalize({points:[isolated],times:ts,overlays:[overlay]},now);
            outside.push(...sub.excluded.map(e=>({...e,point:point.id})));jobs.push(...sub.jobs);
          }
          return jobs;
        }
        const sub=normalize({points:[isolated],times:point.times,overlays:layers},now);
        outside.push(...sub.excluded.map(e=>({...e,point:point.id})));
        return sub.jobs;
      }
      return layers.flatMap(overlay => times.map(t => ({point, overlay, ...t})));
    }),
      excluded: outside};
  }
  async function pace(kind='read') {
    await sleep(Math.max(0, GAP - (Date.now() - eventTimes[kind])));
    if (stopped) fail('Cancelled.');
    eventTimes[kind] = Date.now();
  }
  async function act(fn) { await pace('action'); metrics.actions++; fn(); await sleep(SETTLE); }
  function checkCapabilities() {
    if (!capabilities().ready || !/(^|\.)windy\.com$/.test(root.location.hostname)) fail('Windy adapter unavailable.');
    if (api().store.get('product') !== 'ecmwf') fail('Select ECMWF in the page model selector first.');
  }
  async function selectPoint(point) {
    const w = api(), map = w.map.map;
    if (visible(q('#plugin-detail'))) await act(() => q('#plugin-detail .closing-x')?.click());
    if (near(w.store.get('pickerLocation'), point) && visible(q('.picker'))) return;
    let p = map.latLngToContainerPoint([point.lat, point.lon]);
    const move=p.x<400||p.x>root.innerWidth-330||p.y<100||p.y>root.innerHeight-140;
    if(q('.picker__closing-x')||move) await act(()=>{
      q('.picker__closing-x')?.click();
      if(move)map.setView([point.lat,point.lon],14,{animate:false});
    });
    await act(() => {
      p = map.latLngToContainerPoint([point.lat, point.lon]);
      const el = root.document.elementFromPoint(p.x, p.y);
      if (!el || !q('#map-container')?.contains(el) || el.closest('.picker, #plugin-detail'))
        fail('Map click obstructed; inspect the current map before retrying.');
      el.dispatchEvent(new root.MouseEvent('click', {bubbles: true, clientX: p.x, clientY: p.y}));
    });
    if (!near(w.store.get('pickerLocation'), point)) fail('Clicked point differs from requested coordinates.');
  }
  function read(job) {
    metrics.reads++;
    const w = api(), point = w.store.get('pickerLocation');
    const model = w.store.get('product'), overlay = w.store.get('overlay');
    const timestamp = w.store.get('timestamp'), label = text('.box-text');
    const raw = text('.picker'), title = text('.picker__title');
    const selected = q(`a.selected[data-ident="${job.overlay}"]`);
    if (!near(point, job.point) || model !== 'ecmwf' || overlay !== job.overlay || timestamp !== job.ts || !selected)
      fail('Context mismatch: '+JSON.stringify({expected:{point:job.point.id,lat:job.point.lat,lon:job.point.lon,model:'ecmwf',overlay:job.overlay,timestamp:job.ts},actual:{point,model,overlay,timestamp,selected:!!selected}}));
    if (!visible(q('.picker')) || !visible(q('.box-text'))) fail('Picker/time label not visible.');
    // The displayed map clock can differ from each destination's local timezone.
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {timeZone: displayTimeZone,
      day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).formatToParts(job.ts)
      .filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
    const clock = label.match(/(\d{1,2}):(\d{2})/);
    const day = label.match(/(?:周.|星期.)\s*(\d{1,2})/);
    if (!clock || Number(clock[1]) !== Number(parts.hour) || clock[2] !== parts.minute ||
      (day && Number(day[1]) !== Number(parts.day))) fail('Visible local time does not match configured displayTimeZone.');
    if (!(job.overlay === 'rain' ? /雨|rain/i : /云|cloud/i).test(title)) fail('Picker title mismatch.');
    if ([...root.document.querySelectorAll('.picker .loading, .timecode .loading')].some(visible))
      fail('Picker/timeline still loading.');
    return {point: job.point.id, time: job.iso, model, overlay, helperVersion:VERSION,taskId,shardId,configFingerprint,attemptId:background?.attemptId||null, ...parse(raw, overlay),
      lat: point.lat, lon: point.lon ?? point.lng, label, raw, checkedAt: new Date().toISOString(),
      url: root.location.href};
  }
  async function sample(job) {
    const startedAt = performance.now();
    checkCapabilities();
    if(job.ts<Date.now()||job.ts-Date.now()>168*3600000)fail('Slot is now outside future 168h.');
    let repainted = false, lastMutation = Date.now();
    const observer = new root.MutationObserver(changes => {
      if (changes.some(c => (c.target.nodeType === 1 ? c.target : c.target.parentElement)
        ?.closest('.picker__content'))) { repainted = true; lastMutation = Date.now(); }
    });
    observer.observe(root.document.body, {subtree: true, childList: true, characterData: true});
    let changed = !near(api().store.get('pickerLocation'), job.point) || !visible(q('.picker'));
    try {
      await selectPoint(job.point);
      if (verifyMode === 'fast') {
        const layerChanged = api().store.get('overlay') !== job.overlay;
        const timeChanged = api().store.get('timestamp') !== job.ts;
        if (layerChanged || timeChanged) {
          changed = true;
          // Different actions share one settle window; repeated same actions remain paced.
          await act(() => {
            if (layerChanged) {
              const menu = q(`a[data-ident="${job.overlay}"]`);
              if (!visible(menu)) fail('Layer menu unavailable.');
              menu.click();
            }
            if (timeChanged) api().store.set('timestamp', job.ts);
          });
        }
        let timeCorrection=false;
        for(let attempt=0;attempt<2;attempt++){
          await pace();
          let current;
          try{current=read(job);}catch(err){
            const w=api();
            if(attempt===0&&near(w.store.get('pickerLocation'),job.point)&&w.store.get('product')==='ecmwf'&&w.store.get('overlay')===job.overlay&&q(`a.selected[data-ident="${job.overlay}"]`)&&w.store.get('timestamp')!==job.ts){
              timeCorrection=true;changed=true;
              await act(()=>w.store.set('timestamp',job.ts));
              continue;
            }
            if(attempt===0&&/numeric value missing|still loading|still loading\./i.test(err.message))continue;
            throw err;
          }
          const quietMs = Date.now() - lastMutation;
          if ((changed && !repainted) || quietMs < 800){
            if(attempt===0)continue;
            fail('No repaint or picker not quiet for 800ms; review required.');
          }
          return {...current, status:'ok', repaintObserved:repainted, quietMs, verifyMode,settleReads:attempt+1,timeCorrection,
            elapsedMs:Math.round(performance.now()-startedAt), freshness:'context-repaint-and-quiet-ui'};
        }
        fail('Picker unavailable after bounded settling.');
      }
      if (api().store.get('overlay') !== job.overlay) {
        changed = true;
        await act(() => {
          const menu = q(`a[data-ident="${job.overlay}"]`);
          if (!visible(menu)) fail('Layer menu unavailable.');
          menu.click();
        });
      }
      if (api().store.get('timestamp') !== job.ts) {
        changed = true;
        await act(() => api().store.set('timestamp', job.ts));
      }
      let previous = null;
      // Bounded settling: two equal, separately paced, fully matched readings.
      for (let attempt = 0; attempt < 3; attempt++) {
        await pace();
        let current;
        try { current = read(job); }
        catch (err) { previous = null; if (attempt === 2) throw err; continue; }
        if (previous && current.raw === previous.raw) {
          if (changed && !repainted) fail('No picker-content repaint observed after changing context; review required.');
          return {...current, status: 'ok', repaintObserved: repainted, verifyMode,
            elapsedMs:Math.round(performance.now()-startedAt),
            freshness: changed ? 'context-repaint-and-stable-ui' : 'existing-view-stable-ui'};
        }
        previous = current;
      }
      fail('Picker did not settle within three paced reads.');
    } finally { observer.disconnect(); }
  }
  function status() { return {version: VERSION,taskId,shardId,configFingerprint, done: cursor, total: plan.length,
    remaining: plan.length - cursor, state: busy ? 'running' : stopped ? 'cancelled' :
      failure ? 'needs_review' : cursor === plan.length ? 'complete' : 'ready', error: failure, excluded,
      verifyMode, background:background ? {...background, heartbeat} : null,
      next: plan[cursor] ? {point:plan[cursor].point.id,time:plan[cursor].iso,overlay:plan[cursor].overlay} : null,
      metrics:{...metrics}}; }
  function init(config) {
    if (busy) fail('A batch or point inspection is running.');
    checkCapabilities();
    const normalized = normalize(config);
    if (!['strict','fast'].includes(config.verifyMode||'strict')) fail('verifyMode must be strict or fast.');
    if (background?.running) fail('Cancel and await the active background runner before initializing.');
    plan = normalized.jobs; excluded = normalized.excluded; cursor = 0; rows = [];
    failure = null; stopped = false;
    verifyMode = config.verifyMode || 'strict';
    displayTimeZone = config.displayTimeZone || 'Asia/Shanghai';
    new Intl.DateTimeFormat('en',{timeZone:displayTimeZone});
    if (!['strict','fast'].includes(verifyMode)) fail('verifyMode must be strict or fast.');
    metrics.actions=0;metrics.reads=0;metrics.startedAt=new Date().toISOString();background=null;
    configuration=JSON.parse(JSON.stringify(config));
    taskId=config.taskId||'manual-'+Date.now()+'-'+Math.random().toString(36).slice(2,8);
    shardId=config.shardId||'s1';configFingerprint=config.configFingerprint||null;attempt=0;
    Object.assign(configuration,{taskId,shardId,configFingerprint});
    return status();
  }
  async function step({maxSamples = 1} = {}) {
    if (busy) fail('Concurrent step rejected.');
    if (!Number.isInteger(maxSamples) || maxSamples < 1 || maxSamples > 2) fail('maxSamples must be 1 or 2.');
    if (failure || stopped) return {...status(), rows: []};
    busy = true; const added = [];
    try {
      for (let n = 0; n < maxSamples && cursor < plan.length; n++) {
        const row = await sample(plan[cursor]); rows.push(row); added.push(row); cursor++;
      }
    } catch (err) { failure = String(err.message || err); }
    finally { busy = false; }
    return {...status(), rows: added};
  }
  function start() {
    if (busy || background?.running || failure || stopped) fail('Runner is busy, paused, or cancelled.');
    background={id:taskId+'-'+shardId,attemptId:Date.now()+'-'+(++attempt),running:true};heartbeat=new Date().toISOString();
    const id=background.id,attemptId=background.attemptId;
    (async () => {
      while (cursor<plan.length && !failure && !stopped && background.attemptId===attemptId) {
        await step({maxSamples:1});heartbeat=new Date().toISOString();
        if (cursor%12===0 || failure || cursor===plan.length) {
          try {root.localStorage?.setItem('windy-query-checkpoint:'+id,JSON.stringify(checkpoint()));} catch(_) {}
        }
      }
      background.running=false;
    })().catch(err=>{failure=String(err.message||err);background.running=false;});
    return status();
  }
  function checkpoint() { return {version:VERSION,configuration,...status(),rows:rows.map(r=>({...r})),jobs:plan.map(j=>({...j,point:{...j.point}}))}; }
  function appendPoints(points,identity={}) {
    if(!configuration||!Array.isArray(points)||!points.length)fail('Initialize first; points required.');
    const known=new Map(configuration.points.map(p=>[p.id,p]));
    const fresh=points.filter(p=>{
      if(!known.has(p.id))return true;
      if(known.get(p.id).lat!==p.lat||known.get(p.id).lon!==p.lon)fail('Existing point coordinates changed; use a separate correction run.');
      return false;
    });
    if(!fresh.length)return status();
    if(configFingerprint&&!identity.configFingerprint)fail('A managed plan needs a new configFingerprint when appending; use workflow reconciliation.');
    const next=normalize({...configuration,points:fresh});
    plan.push(...next.jobs);excluded.push(...next.excluded);configuration.points.push(...fresh);
    if(identity.configFingerprint){configFingerprint=identity.configFingerprint;configuration.configFingerprint=configFingerprint;}
    return status();
  }
  function restore(saved) {
    if (busy || background?.running) fail('A runner is active.');
    if (!saved || !['2.0.0','2.1.0','2.2.0',VERSION].includes(saved.version) || !Array.isArray(saved.rows)) fail('Incompatible checkpoint.');
    if (!Array.isArray(saved.jobs)||!saved.configuration)fail('Checkpoint jobs/configuration missing.');
    // Validate at the original run time, so completed slots can safely be in the past.
    const prepared=normalize(saved.configuration,Date.parse(saved.metrics?.startedAt||''));
    if(!Number.isFinite(Date.parse(saved.metrics?.startedAt||'')))fail('Checkpoint start time missing.');
    if(prepared.jobs.length!==saved.jobs.length||saved.rows.length>saved.jobs.length)fail('Checkpoint plan length mismatch.');
    for(let i=0;i<saved.jobs.length;i++){
      const a=saved.jobs[i],b=prepared.jobs[i];
      if(a.point.id!==b.point.id||a.point.lat!==b.point.lat||a.point.lon!==b.point.lon||a.ts!==b.ts||a.overlay!==b.overlay)
        fail('Checkpoint job differs from validated configuration.');
      if(i<saved.rows.length){const r=saved.rows[i];if(r.point!==a.point.id||r.time!==a.iso||r.overlay!==a.overlay||!['ok','needs_review'].includes(r.status))fail('Checkpoint row order/status invalid.');}
      else if(a.ts<Date.now()||a.ts-Date.now()>168*3600000)fail('Unfinished checkpoint slot is now outside future 168h; create a new plan.');
    }
    init(saved.configuration);
    plan=saved.jobs.map(j=>({...j,point:{...j.point}}));
    configuration={...JSON.parse(JSON.stringify(saved.configuration)),taskId,shardId,configFingerprint};excluded=saved.excluded||[];
    Object.assign(metrics,saved.metrics);
    rows=saved.rows.map(r=>({...r}));cursor=rows.length;return status();
  }
  function skipPoint(reason) {
    if (busy || !failure || !reason) fail('Only a paused failed point may be explicitly skipped with a reason.');
    const id=plan[cursor]?.point.id;
    while (cursor<plan.length && plan[cursor].point.id===id) {
      const job=plan[cursor++];rows.push({point:id,time:job.iso,overlay:job.overlay,taskId,shardId,configFingerprint,status:'needs_review',
        value:null,error:String(reason),checkedAt:new Date().toISOString()});
    }
    failure=null;return status();
  }
  const exported = {version: VERSION, capabilities, init, step, status,
    start, checkpoint, restore, appendPoints, skipPoint,
    recordsSince:(after=0)=>{if(!Number.isInteger(after)||after<0||after>cursor)fail('Invalid persisted cursor; check task identity.');return {...status(),from:after,after:cursor,rows:rows.slice(after)};},
    records: () => ({...status(), rows: rows.map(r => ({...r}))}),
    cancel: () => { stopped = true; return status(); },
    resume: () => { if (busy) fail('Still running.'); failure = null; stopped = false; return status(); }};
  if (typeof module !== 'undefined' && module.exports) module.exports = {parse, normalize, near};
  else root.WindyQuery = exported;
  return capabilities();
})(globalThis);
