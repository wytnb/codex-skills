/* Persistent plan -> browser receipts -> incremental follow-up -> summary. No weather network calls. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {makePlan,localISO,distribute,fingerprint}=require('./make-plan.cjs');
const {normalize}=require('./windy-batch.js');
const {summarize}=require('./summarize-readings.cjs');
const {keyOf,instant,WINDOW_MS}=require('./reading-validation.cjs');
const VERSION='2.3.0',read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
function write(file,data){const tmp=file+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(data));fs.renameSync(tmp,file);}
function configsFor(atlas,jobs,request,taskId,now){
 const points=atlas.points.map(p=>{const selected=jobs.filter(j=>j.point===p.id),overlayTimes={rain:[],clouds:[]};
  for(const j of selected)overlayTimes[j.overlay].push(j.time);
  for(const k of Object.keys(overlayTimes))overlayTimes[k]=[...new Set(overlayTimes[k])].sort();
  return {...p,times:[...new Set(selected.map(j=>j.time))].sort(),overlayTimes};
 }).filter(p=>p.times.length);
 return distribute(points,request,taskId).map(c=>({...c,windowAnchor:new Date(now).toISOString()}));
}
function jobsFor(config){return normalize(config,instant(config.windowAnchor)).jobs.map(j=>({point:j.point.id,time:j.iso,overlay:j.overlay}));}
function load(dir){return read(path.join(dir,'state.json'));}
function persist(dir,state){state.updatedAt=new Date().toISOString();write(path.join(dir,'state.json'),state);}
function prepare(request,atlas,dir,now=Date.now()){
 if(fs.existsSync(path.join(dir,'state.json')))throw new Error('Existing workflow: reconcile it or choose a new run directory');
 if(fs.existsSync(dir)&&fs.readdirSync(dir).length)throw new Error('New workflow requires a new or empty run directory');
 const plan=makePlan(atlas,request,now),ids=new Set(plan.geographicReview.map(p=>p.point));
 const subset={points:atlas.points.filter(p=>ids.has(p.id)),unresolved:plan.unresolved};
 for(const c of configsFor(subset,plan.jobs,request,plan.taskId,now))jobsFor(c);
 fs.mkdirSync(path.join(dir,'exports'),{recursive:true});fs.mkdirSync(path.join(dir,'archive'),{recursive:true});
 write(path.join(dir,'atlas.json'),subset);
 const state={version:VERSION,taskId:plan.taskId,createdAt:plan.createdAt,request:{...request,taskId:plan.taskId},requestFingerprint:plan.requestFingerprint,atlasFingerprint:fingerprint(subset),expectedJobs:plan.jobs,configs:configsFor(subset,plan.jobs,request,plan.taskId,now),bindings:{},inputs:[],revisions:1,metrics:{observations:0,exportedRows:0,observationTimeouts:0},timeline:[{at:plan.createdAt,event:'prepare',jobs:plan.jobs.length}],geographicReview:plan.geographicReview};
 state.unresolved=plan.unresolved;persist(dir,state);write(path.join(dir,'plan.json'),{...plan,configs:state.configs});
 return reconcile(dir,now);
}
function inputsOf(dir,state){return state.inputs.map(file=>{const receipt=read(path.join(dir,file));return {file,data:receipt.data||receipt};});}
function checkedAtlas(dir,state){const atlas=read(path.join(dir,'atlas.json'));if(fingerprint(atlas)!==state.atlasFingerprint)throw new Error('Atlas changed: use a new correction task');return atlas;}
function reconcile(dir,now=Date.now()){
 const state=load(dir),atlas=checkedAtlas(dir,state);
 if(Object.values(state.bindings).some(b=>b.phase==='start-intent'||b.running||b.state==='ready'||b.state==='needs_review'||b.state==='cancelled'))throw new Error('Save/resolve active or uncertain bindings before reconciliation');
 const current=makePlan(atlas,state.request,now),expected=new Map(state.expectedJobs.map(j=>[keyOf(j),j]));
 for(const j of current.jobs)expected.set(keyOf(j),j);
 let summary=summarize(atlas,inputsOf(dir,state),state.request.dates,state.request.hours||[9,12,15],{taskId:state.taskId,expectedJobs:[...expected.values()],maxCohortSpanMs:state.request.maxCohortSpanMs});
 const valid=new Map(summary.valid.map(r=>[keyOf(r),r])),followup=state.request.followup===false?null:state.request.followup||{};
 const deferred=[...current.excluded];
 if(followup)for(const p of atlas.points)for(const date of state.request.dates){
  const primary=(state.request.hours||[9,12,15]).flatMap(hour=>['rain','clouds'].map(overlay=>({point:p.id,time:localISO(date,hour,p.timeZone),overlay})));
  if(!primary.every(j=>valid.has(keyOf(j))))continue;
  const rows=primary.map(j=>valid.get(keyOf(j))),cloud=rows.filter(r=>r.overlay==='clouds').map(r=>r.value);
  const wet=rows.some(r=>r.overlay==='rain'&&r.value>0),snow=rows.some(r=>r.unit==='cm');
  if(!wet&&!snow&&Math.max(...cloud)-Math.min(...cloud)<(followup.cloudSpan??30)&&Math.max(...cloud)<(followup.cloudMax??60))continue;
  for(const hour of followup.hours||[18]){
   const time=localISO(date,hour,p.timeZone),delta=instant(time)-now;
   if(delta<0||delta>WINDOW_MS){deferred.push({point:p.id,time,reason:delta<0?'past-followup':'beyond-168h-followup'});continue;}
   for(const overlay of ['rain','clouds']){const j={point:p.id,time,overlay,kind:'followup'};if(!expected.has(keyOf(j)))expected.set(keyOf(j),j);}
  }
 }
 state.expectedJobs=[...expected.values()];
 summary=summarize(atlas,inputsOf(dir,state),state.request.dates,state.request.hours||[9,12,15],{taskId:state.taskId,expectedJobs:state.expectedJobs,maxCohortSpanMs:state.request.maxCohortSpanMs});
 const pending=summary.missing.filter(j=>instant(j.time)>=now&&instant(j.time)-now<=WINDOW_MS),expired=summary.missing.filter(j=>instant(j.time)<now);
 const next=configsFor(atlas,pending,state.request,state.taskId,now);
 if(fingerprint(next.map(c=>c.configFingerprint))!==fingerprint(state.configs.map(c=>c.configFingerprint))){state.revisions++;state.configs=next;}
 state.deferred=deferred;state.expired=expired;state.summary=summary.summary;
 state.status=expired.length?'needs_review':pending.length?'ready':deferred.some(d=>d.reason.startsWith('beyond-'))?'windy_complete_with_later_sources_required':'complete';
 state.completedAt=state.status==='complete'?(state.completedAt||new Date(now).toISOString()):null;
 state.timeline.push({at:new Date(now).toISOString(),event:'reconcile',pending:pending.length,expired:expired.length});
 persist(dir,state);write(path.join(dir,'summary.json'),summary);
 write(path.join(dir,'progress.json'),compact(state));writeReport(dir,state,summary);
 return compact(state);
}
function compact(state){return {taskId:state.taskId,status:state.status,coverageBoundary:'submitted-run-only',recommendation:state.request.recommendation||null,revision:state.revisions,selectedPoints:state.geographicReview.length,expected:state.expectedJobs.length,valid:state.summary?.validRows||0,missing:state.summary?.missingRows||0,pending:state.configs.reduce((n,c)=>{const b=Object.values(state.bindings).find(b=>b.configFingerprint===c.configFingerprint);return n+Math.max(0,jobsFor(c).length-(b?.cursor||0));},0),shards:state.configs.length,laterSlots:state.deferred?.filter(d=>d.reason.startsWith('beyond-')).length||0,expired:state.expired?.length||0,geoUnresolved:state.unresolved?.length||0,metrics:state.metrics};}
function bind(dir,pageId,shardId){
 const state=load(dir),config=state.configs.find(c=>c.shardId===shardId);if(!config)throw new Error('No pending shard '+shardId);
 const old=state.bindings[pageId];
 if(Object.entries(state.bindings).some(([id,b])=>String(id)!==String(pageId)&&b.configFingerprint===config.configFingerprint))throw new Error('Shard already bound to another page');
 if(old&&old.configFingerprint===config.configFingerprint)return old;
 if(old&&(old.running||old.phase==='start-intent'||old.state!=='complete'||old.cursor!==old.total))throw new Error('Previous binding not durably complete');
 const binding={taskId:state.taskId,pageId:Number(pageId),shardId,configFingerprint:config.configFingerprint,config,cursor:0,total:jobsFor(config).length,phase:'start-intent',state:'ready',running:false};
 state.bindings[pageId]=binding;persist(dir,state);return binding;
}
function ingest(dir,file){
 const state=load(dir);const absolute=path.resolve(file),exportsDir=path.resolve(dir,'exports')+path.sep;
 if(!absolute.startsWith(exportsDir))throw new Error('Receipt must be inside run exports directory');
 const payload=read(file),data=payload.data,page=payload.pageId,b=state.bindings[page];
 if(!b||data.taskId!==state.taskId||data.configFingerprint!==b.configFingerprint||data.shardId!==b.shardId)throw new Error('Receipt task/config/page identity mismatch');
 if(data.background?.id&&data.background.id!==state.taskId+'-'+b.shardId)throw new Error('Unexpected logical run id');
 const after=data.after??data.done,from=data.from??0,rows=data.rows||[],jobs=jobsFor(b.config);
 if(!Number.isInteger(after)||!Number.isInteger(from)||from<0||after>jobs.length||after<from||rows.length!==after-from||from>b.cursor||data.done!==after||data.total!==jobs.length)throw new Error('Receipt cursor gap or plan size mismatch');
 for(let i=0;i<rows.length;i++)if(keyOf(rows[i])!==keyOf(jobs[from+i])||rows[i].taskId!==state.taskId||rows[i].configFingerprint!==b.configFingerprint)throw new Error('Receipt row order/identity mismatch');
 const relative=path.relative(dir,absolute);
 if(state.inputs.includes(relative))return compact(state);
 if(after<b.cursor)throw new Error('Late observation would rewind cursor');
 state.inputs.push(relative);state.metrics.observations++;state.metrics.exportedRows+=rows.length;
 Object.assign(b,{cursor:after,phase:'observed',state:data.state,running:!!data.background?.running,lastReceipt:relative,metrics:data.metrics,background:data.background,lastBrowserObservedAt:payload.observedAt||new Date().toISOString()});
 state.status=Object.values(state.bindings).some(binding=>binding.running)?'running':data.state;
 persist(dir,state);write(path.join(dir,'progress.json'),compact(state));return compact(state);
}
function recovery(dir,page){
 const state=load(dir),b=state.bindings[page];if(!b)throw new Error('No binding');
 const rows=[];
 for(const input of inputsOf(dir,state)){const data=input.data.data||input.data;if(data.configFingerprint!==b.configFingerprint)continue;const from=data.from??0;for(let i=0;i<(data.rows||[]).length;i++)rows[from+i]=data.rows[i];}
 if(rows.length!==b.cursor||Array.from({length:b.cursor},(_,i)=>i).some(i=>!rows[i]))throw new Error('Missing persisted recovery rows');
 return {version:VERSION,configuration:b.config,rows,jobs:normalize(b.config,instant(b.config.windowAnchor)).jobs,metrics:b.metrics||{startedAt:b.config.windowAnchor},excluded:[],taskId:state.taskId};
}
function recoverPage(dir,page,now=Date.now()){
 const state=load(dir),atlas=checkedAtlas(dir,state),b=state.bindings[page];
 if(!b||b.phase==='start-intent'||!b.cursor)throw new Error('Need a persisted nonempty binding; uncertain start requires explicit resolution');
 const summary=summarize(atlas,inputsOf(dir,state),state.request.dates,state.request.hours||[9,12,15],{taskId:state.taskId,expectedJobs:state.expectedJobs}),valid=new Set(summary.valid.map(keyOf));
 const pending=jobsFor(b.config).filter(j=>!valid.has(keyOf(j)));
 if(!pending.length)throw new Error('No missing samples; reconcile the completed binding instead');
 if(pending.some(j=>instant(j.time)<now||instant(j.time)-now>WINDOW_MS))throw new Error('Recovery has expired slots; preserve gaps and replan explicitly');
 const config=configsFor(atlas,pending,{...state.request,shards:1},state.taskId,now)[0];config.shardId=b.shardId;
 config.configFingerprint=fingerprint({taskId:config.taskId,shardId:config.shardId,points:config.points,overlays:config.overlays,verifyMode:config.verifyMode,displayTimeZone:config.displayTimeZone});
 state.retiredBindings??=[];state.retiredBindings.push({...b,reason:'browser-helper-lost',retiredAt:new Date(now).toISOString()});
 state.configs=state.configs.map(c=>c.shardId===b.shardId?config:c);
 const binding={taskId:state.taskId,pageId:Number(page),shardId:b.shardId,configFingerprint:config.configFingerprint,config,cursor:0,total:pending.length,phase:'start-intent',state:'ready',running:false};state.bindings[page]=binding;
 state.timeline.push({at:new Date(now).toISOString(),event:'recover-missing-only',page,pending:pending.length});persist(dir,state);
 return {config,binding:bindingInfo(binding)};
}
function bindingInfo(b){const {config,...info}=b;return info;}
function recoverReceipts(dir){
 let state=load(dir);const orphan=fs.readdirSync(path.join(dir,'exports')).filter(f=>f.endsWith('.json')&&!state.inputs.includes(path.join('exports',f))).map(f=>({file:path.join(dir,'exports',f),receipt:read(path.join(dir,'exports',f))}));
 orphan.sort((a,b)=>(a.receipt.data.from??0)-(b.receipt.data.from??0)||(a.receipt.data.after??a.receipt.data.done)-(b.receipt.data.after??b.receipt.data.done));
 for(const {file,receipt} of orphan){const b=state.bindings[receipt.pageId];if(!b||receipt.data.taskId!==state.taskId||receipt.data.configFingerprint!==b.configFingerprint)throw new Error('Untracked receipt identity mismatch: '+file);ingest(dir,file);state=load(dir);}
 return state;
}
function writeReport(dir,state,summary){
 const atlas=checkedAtlas(dir,state),points=new Map(atlas.points.map(p=>[p.id,p])),names=new Map(atlas.points.map(p=>[p.destinationId,p.destination||p.destinationId]));
 const checked=summary.valid.map(r=>instant(r.checkedAt));
 const lines=['# Windy 查询进度（仅已提交范围，非正式目的地推荐）','',`任务 ${state.taskId}；状态 ${state.status}。有效读数 ${summary.summary.validRows}，计划缺口 ${summary.missing.length}。`,checked.length?`实际读取时间（UTC）：${new Date(Math.min(...checked)).toISOString()} 至 ${new Date(Math.max(...checked)).toISOString()}。`:'尚无有效读数。','','目的地推荐须另外通过recommendation.cjs的完整候选范围校验；此处complete不代表全部候选完成。','','仅描述实际采样时段；模型ECMWF，起报批次未核验。雨量为原累计周期，云量为百分比。','', '|目的地|日期|雨量范围 mm|雪量范围 cm|云量范围 %|样本数|缺口|','|---|---|---|---|---|---|---|'];
 const show=a=>a?a.join('–'):'未取得';
 for(const d of summary.daily)lines.push(`|${names.get(d.destinationId)}|${d.date}|${show(d.rainMm)}|${show(d.snowCm)}|${show(d.cloudPct)}|${d.sampleRows}|${d.sampleRows?d.missing:'未取得'}|`);
 lines.push('','|实际选点|WGS84纬度，经度|地形海拔|定位/来源|','|---|---|---|---|');
 for(const p of atlas.points){const locator='https://www.windy.com/?'+p.lat.toFixed(6)+','+p.lon.toFixed(6)+',14';lines.push(`|${p.destination||p.destinationId}／${p.label||p.id}|${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}|${p.terrainElevationM}m|[定位](${locator})；${p.geoSource||'来源未记录'}|`);}
 if(summary.valid.length&&summary.valid.length<=32){
  const buckets=new Map();for(const r of summary.valid){const key=r.point+'|'+r.time;if(!buckets.has(key))buckets.set(key,{point:r.point,time:r.time});buckets.get(key)[r.overlay]=r;}
  lines.push('','|点位|当地日期时间|降水及累计周期|云量|','|---|---|---|---|');
  for(const b of [...buckets.values()].sort((a,b)=>a.point.localeCompare(b.point)||a.time.localeCompare(b.time))){const p=points.get(b.point),local=new Intl.DateTimeFormat('zh-CN',{timeZone:p.timeZone,dateStyle:'short',timeStyle:'short',hour12:false}).format(instant(b.time));lines.push(`|${p.label||p.id}|${local}|${b.rain?b.rain.value+' '+b.rain.unit+' / '+b.rain.periodHours+'h':'缺失'}|${b.clouds?b.clouds.value+'%':'缺失'}|`);}
 }
 lines.push('',`读取跨度较大的点日组合：${summary.summary.wideCohorts}；详见summary.json的cohorts。`,`超过168小时的待补其他来源时段：${state.deferred.filter(d=>d.reason.startsWith('beyond-')).length}；详见state.json的deferred。`,'','点位来源、地形海拔和角色核验状态见state.json的geographicReview；计划完成不等于游览区域完整覆盖。');
 fs.writeFileSync(path.join(dir,'report.md'),lines.join('\n'));
}
function main(args){
 const [mode,dir,...rest]=args;if(!mode||!dir)throw new Error('Usage: workflow.cjs prepare runDir request.json [atlas.json] | snapshot/reconcile/recovery/bind/ingest/event runDir ...');
 if(mode==='prepare')return prepare(read(rest[0]),read(rest[1]||path.join(__dirname,'../references/point-atlas.json')),dir);
 if(mode==='helper')return fs.readFileSync(path.join(__dirname,'windy-batch.js'),'utf8');
 if(mode==='snapshot'){const s=recoverReceipts(dir);return {...compact(s),configs:s.configs.map(c=>({taskId:c.taskId,shardId:c.shardId,configFingerprint:c.configFingerprint})),bindings:Object.fromEntries(Object.entries(s.bindings).map(([page,b])=>[page,bindingInfo(b)]))};}
 if(mode==='configuration'){const c=load(dir).configs.find(c=>c.shardId===rest[0]);if(!c)throw new Error('Unknown pending shard');return c;}
 if(mode==='reconcile')return reconcile(dir);
 if(mode==='bind')return bindingInfo(bind(dir,rest[0],rest[1]));
 if(mode==='ingest')return ingest(dir,rest[0]);
 if(mode==='recovery')return recovery(dir,rest[0]);
 if(mode==='recover-page')return recoverPage(dir,rest[0]);
 if(mode==='release-intent'){const s=load(dir),b=s.bindings[rest[0]];if(!b||b.phase!=='start-intent'||b.cursor||b.configFingerprint!==rest[1]||!rest[2])throw new Error('Only a verified empty uncertain start can be released with fingerprint and reason');s.timeline.push({at:new Date().toISOString(),event:'release-intent',page:rest[0],reason:rest[2]});delete s.bindings[rest[0]];persist(dir,s);return compact(s);}
 if(mode==='event'){const s=load(dir);if(rest[0]==='observation-timeout')s.metrics.observationTimeouts++;s.driverObservations??={};if(rest[0]==='observation-start')s.driverObservations[rest[1]]={startedAt:new Date().toISOString(),budgetMs:Number(rest[2]),state:'open'};if(['observation-complete','observation-failed'].includes(rest[0])&&s.driverObservations[rest[1]]){s.driverObservations[rest[1]].state=rest[0]==='observation-complete'?'complete':'failed';s.driverObservations[rest[1]].errorKind=rest[2]||null;}s.timeline.push({at:new Date().toISOString(),event:rest[0],detail:rest[1]});persist(dir,s);return compact(s);}
 if(mode==='benchmark'){
  const s=load(dir),atlas=checkedAtlas(dir,s),summary=summarize(atlas,inputsOf(dir,s),s.request.dates,s.request.hours||[9,12,15],{taskId:s.taskId,expectedJobs:s.expectedJobs});
  const values=summary.valid.map(r=>r.elapsedMs).filter(Number.isFinite).sort((a,b)=>a-b),readTimes=summary.valid.map(r=>instant(r.checkedAt));
  const completed=s.completedAt||(s.status==='complete'?[...s.timeline].reverse().find(e=>e.event==='reconcile'&&e.pending===0&&!e.expired)?.at:null);
  const result={taskId:s.taskId,label:s.request.benchmarkLabel||'not-specified',completedAt:completed||null,wallIncludingIdleMs:instant(completed||new Date().toISOString())-instant(s.createdAt),firstToLastReadMs:readTimes.length?Math.max(...readTimes)-Math.min(...readTimes):null,sampleMedianMs:values.length?values[Math.floor(values.length/2)]:null,sampleElapsedSumMs:values.reduce((a,b)=>a+b,0),validSamples:summary.valid.length,duplicateExports:summary.summary.duplicateExports,receiptFiles:s.inputs.length,receiptBytes:s.inputs.reduce((n,f)=>n+fs.statSync(path.join(dir,f)).size,0),observations:s.metrics.observations,unfinishedDriverObservations:Object.values(s.driverObservations||{}).filter(o=>o.state==='open').length,actualBilledTokens:null,notes:'Wall time includes pauses; sample elapsed sum can overlap across pages; open observations may mean interruption or timeout, not proven runner failure.'};
  write(path.join(dir,'benchmark.json'),result);return result;
 }
 throw new Error('Unknown workflow command');
}
if(require.main===module){let lock;try{const mode=process.argv[2],dir=process.argv[3];if(dir&&!['recovery','prepare'].includes(mode)){lock=path.join(dir,'.controller.lock');fs.writeFileSync(lock,String(process.pid),{flag:'wx'});}console.log(JSON.stringify(main(process.argv.slice(2))));}catch(e){console.error(JSON.stringify({error:e.message}));process.exitCode=1;}finally{if(lock&&fs.existsSync(lock)&&fs.readFileSync(lock,'utf8')===String(process.pid))fs.unlinkSync(lock);}}
module.exports={prepare,reconcile,bind,ingest,recovery,recoverPage,load,compact,jobsFor,configsFor,recoverReceipts,main};
