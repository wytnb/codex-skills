/* Merge saved browser deltas/checkpoints without loading raw logs into model context. */
const fs=require('node:fs');
const {localISO}=require('./make-plan.cjs');
const {instant,keyOf,rejectReason}=require('./reading-validation.cjs');
function summarize(atlas,inputs,dates=['2026-10-23','2026-10-24'],hours=[9,12,15],options={}){
 const points=new Map(atlas.points.map(p=>[p.id,p])),latest=new Map(),rejected=[];
 const revisions=new Map();let acceptedRows=0;
 for(const input of inputs)for(const r of input.data.rows||[]){
  const p=points.get(r?.point),reason=rejectReason(r,p,options.taskId);
  if(reason){rejected.push({file:input.file,point:r?.point,time:r?.time,overlay:r?.overlay,reason});continue;}
  acceptedRows++;const key=keyOf(r),old=latest.get(key),history=revisions.get(key)||new Map();
  const revisionKey=r.checkedAt+'|'+r.value+'|'+r.unit;
  history.set(revisionKey,{checkedAt:r.checkedAt,value:r.value,unit:r.unit,taskId:r.taskId||null,configFingerprint:r.configFingerprint||null});revisions.set(key,history);
  if(!old||instant(r.checkedAt)>instant(old.checkedAt))latest.set(key,{...r,time:new Date(instant(r.time)).toISOString(),sourceFile:input.file,helperVersion:r.helperVersion||'not-recorded',exportVersion:input.data.version||'unknown'});
 }
 const valid=[...latest.values()],coverage=[],missing=[];
 for(const p of atlas.points){
  let done=0,total=0;
  const slots=options.expectedJobs?options.expectedJobs.filter(j=>j.point===p.id):dates.flatMap(date=>hours.flatMap(hour=>['rain','clouds'].map(overlay=>({point:p.id,date,hour,time:localISO(date,hour,p.timeZone),overlay}))));
  for(const slot of slots){
   total++;const key=keyOf(slot);
   if(latest.has(key))done++;else missing.push(slot);
  }
  coverage.push({point:p.id,destinationId:p.destinationId,done,total});
 }
 const daily=[];
 for(const destinationId of new Set(atlas.points.map(p=>p.destinationId)))for(const date of dates){
  const ps=atlas.points.filter(p=>p.destinationId===destinationId),ids=new Set(ps.map(p=>p.id));
  const selected=valid.filter(r=>ids.has(r.point)&&new Intl.DateTimeFormat('en-CA',{timeZone:points.get(r.point).timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(Date.parse(r.time))===date);
  const rain=selected.filter(r=>r.overlay==='rain'&&r.unit==='mm'),snow=selected.filter(r=>r.overlay==='rain'&&r.unit==='cm'),cloud=selected.filter(r=>r.overlay==='clouds');
  const range=a=>a.length?[Math.min(...a.map(r=>r.value)),Math.max(...a.map(r=>r.value))]:null;
  daily.push({destinationId,date,rainMm:range(rain),snowCm:range(snow),rainPeriods:[...new Set([...rain,...snow].map(r=>r.periodHours))],cloudPct:range(cloud),sampleRows:selected.length,missing:missing.filter(x=>ids.has(x.point)&&x.date===date).length});
 }
 const cohorts=[];
 for(const p of atlas.points)for(const date of dates){
  const selected=valid.filter(r=>r.point===p.id&&new Intl.DateTimeFormat('en-CA',{timeZone:p.timeZone}).format(instant(r.time))===date);
  if(!selected.length)continue;
  const checked=selected.map(r=>instant(r.checkedAt)),spanMs=Math.max(...checked)-Math.min(...checked);
  cohorts.push({point:p.id,date,firstRead:new Date(Math.min(...checked)).toISOString(),lastRead:new Date(Math.max(...checked)).toISOString(),spanMs,needsReview:spanMs>(options.maxCohortSpanMs??30*60000),modelRun:'unverified',configFingerprints:[...new Set(selected.map(r=>r.configFingerprint||'not-recorded'))]});
 }
 return {createdAt:new Date().toISOString(),valid,rejected,coverage,missing,daily,cohorts,revisions:[...revisions].filter(([,h])=>h.size>1).map(([key,h])=>({key,readings:[...h.values()]})),summary:{points:atlas.points.length,destinations:new Set(atlas.points.map(p=>p.destinationId)).size,validRows:valid.length,duplicateExports:acceptedRows-[...revisions.values()].reduce((n,h)=>n+h.size,0),completePoints:coverage.filter(x=>x.done===x.total&&x.total>0).length,missingRows:missing.length,rejectedRows:rejected.length,wideCohorts:cohorts.filter(c=>c.needsReview).length}};
}
if(require.main===module){
 const[atlasFile,requestFile,outFile,...files]=process.argv.slice(2);
 if(!outFile||!files.length)throw new Error('Usage: node summarize-readings.cjs atlas.json request.json out.json input1.json ...');
 const read=f=>JSON.parse(fs.readFileSync(f,'utf8')),request=read(requestFile);
 const r=summarize(read(atlasFile),files.map(file=>({file,data:read(file)})),request.dates,request.hours||[9,12,15]);
 fs.writeFileSync(outFile,JSON.stringify(r));console.log(JSON.stringify({output:outFile,...r.summary}));
}
module.exports={summarize};
