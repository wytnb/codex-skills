/* Cached geographic points + local dates -> timezone-safe browser plans. No network. */
const fs=require('node:fs'),path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function distribute(points,request,taskId){
 const shards=request.shards??1;
 if(!Number.isInteger(shards)||shards<1||shards>3)throw new Error('Use 1–3 independently tested pages');
 const configs=Array.from({length:shards},(_,i)=>({taskId,shardId:'s'+(i+1),points:[],overlays:['rain','clouds'],verifyMode:request.verifyMode||'fast',displayTimeZone:request.displayTimeZone||'Asia/Shanghai',estimatedCost:0}));
 const weight=p=>p.overlayTimes?Object.values(p.overlayTimes).reduce((n,t)=>n+t.length,0):p.times.length*2;
 for(const p of [...points].sort((a,b)=>weight(b)-weight(a)||a.id.localeCompare(b.id))){
  const target=[...configs].sort((a,b)=>a.estimatedCost-b.estimatedCost||a.shardId.localeCompare(b.shardId))[0];
  target.points.push(p);target.estimatedCost+=weight(p)+2;
 }
 return configs.filter(c=>c.points.length).map(c=>({...c,configFingerprint:fingerprint({taskId,shardId:c.shardId,points:c.points,overlays:c.overlays,verifyMode:c.verifyMode,displayTimeZone:c.displayTimeZone})}));
}
function geographicReview(p){
 return {point:p.id,destination:p.destination||p.destinationId,label:p.label,lat:p.lat,lon:p.lon,terrainElevationM:p.terrainElevationM,source:p.geoSource||null,coordinateEvidence:p.geometryVerification||'not-recorded',roleStatus:p.roleVerification?.status||'review-on-use',roleEvidence:p.roleVerification?.source||null};
}
function localISO(date,hour,timeZone){
 if(!/^\d{4}-\d\d-\d\d$/.test(date)||!Number.isInteger(hour)||hour<0||hour>23)throw new Error('Invalid local date/hour');
 const [y,m,d]=date.split('-').map(Number),target=Date.UTC(y,m-1,d,hour);
 if(new Date(target).toISOString().slice(0,10)!==date)throw new Error('Invalid calendar date');
 const formatter=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
 let guess=target;
 const parts=t=>Object.fromEntries(formatter.formatToParts(t).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
 for(let n=0;n<4;n++){const p=parts(guess);const rendered=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second);guess+=target-rendered;}
 const p=parts(guess);
 if(p.year!==y||p.month!==m||p.day!==d||p.hour!==hour||p.minute||p.second)throw new Error('Nonexistent or unsupported local wall time');
 return new Date(guess).toISOString();
}
function makePlan(atlas,request,now=Date.now()){
 if(!request||!Array.isArray(request.dates)||!request.dates.length)throw new Error('dates are required');
 if(!Number.isFinite(now)||!['strict','fast'].includes(request.verifyMode||'fast'))throw new Error('Invalid clock or verification mode');
 new Intl.DateTimeFormat('en',{timeZone:request.displayTimeZone||'Asia/Shanghai'});
 if(request.followup&&(!Array.isArray(request.followup.hours||[18])||!(request.followup.hours||[18]).length))throw new Error('Invalid followup hours');
 for(const hour of request.followup?.hours||[])if(!Number.isInteger(hour)||hour<0||hour>23)throw new Error('Invalid followup hour');
 const ids=new Set(request.pointIds||[]),destinations=new Set(request.destinationIds||[]);
 if(!ids.size&&!destinations.size)throw new Error('Select pointIds or destinationIds explicitly; do not accidentally query the entire atlas');
 const points=atlas.points.filter(p=>ids.has(p.id)||destinations.has(p.destinationId));
 for(const id of ids)if(!points.some(p=>p.id===id))throw new Error('Unknown/unverified point: '+id);
 for(const id of destinations)if(!points.some(p=>p.destinationId===id))throw new Error('Unknown/unverified destination: '+id);
 const hours=[...new Set(request.hours||[9,12,15])].sort((a,b)=>a-b),excluded=[],jobs=[];
 if(!hours.length)throw new Error('At least one local hour required');
 const taskId=request.taskId||'windy-'+randomUUID();
 if(!/^[A-Za-z0-9_-]{1,100}$/.test(taskId))throw new Error('Invalid taskId');
 const result=points.map(p=>({...p,times:[...new Set(request.dates)].flatMap(date=>hours.map(h=>localISO(date,h,p.timeZone))).filter(iso=>{
  const ts=Date.parse(iso),valid=ts>=now&&ts-now<=168*3600000;
  if(!valid)excluded.push({point:p.id,time:iso,reason:ts<now?'past-slot':'beyond-168h'});
  else for(const overlay of ['rain','clouds'])jobs.push({point:p.id,time:iso,overlay,kind:'primary'});
  return valid;
 })})).filter(p=>p.times.length);
 const configs=distribute(result,request,taskId);
 return {taskId,createdAt:new Date(now).toISOString(),requestFingerprint:fingerprint(request),configs,excluded,jobs,geographicReview:points.map(geographicReview),
  coverage:{selectedPoints:points.length,queuedPoints:result.length,samples:result.reduce((n,p)=>n+p.times.length*2,0)},
  unresolved:(atlas.unresolved||[]).filter(p=>destinations.has(p.destinationId)||ids.has(p.id))};
}
if(require.main===module){
 const [requestFile,outFile,atlasFile]=process.argv.slice(2);
 if(!requestFile||!outFile)throw new Error('Usage: node make-plan.cjs request.json plan.json [atlas.json]');
 const atlas=JSON.parse(fs.readFileSync(atlasFile||path.join(__dirname,'../references/point-atlas.json'),'utf8'));
 const result=makePlan(atlas,JSON.parse(fs.readFileSync(requestFile,'utf8')));
 fs.writeFileSync(outFile,JSON.stringify(result,null,2));console.log(JSON.stringify({output:outFile,...result.coverage,excluded:result.excluded.length,shards:result.configs.length,unresolved:result.unresolved.map(p=>p.id)}));
}
module.exports={localISO,makePlan,distribute,fingerprint,geographicReview};
