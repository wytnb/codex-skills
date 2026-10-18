const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {prepare,reconcile,bind,ingest,recovery,load,jobsFor,recoverReceipts,main}=require('./workflow.cjs');
const {summarize}=require('./summarize-readings.cjs'),{instant}=require('./reading-validation.cjs'),{distribute}=require('./make-plan.cjs');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'windy-workflow-test-'));
const now=Date.parse('2026-10-18T00:00:00+08:00');
const point=id=>({id,destinationId:'d',label:id,lat:27,lon:118,timeZone:'Asia/Shanghai',terrainElevationM:100,verification:'named map and terrain',verifiedAt:'2026-10-18'});
const atlas={points:[point('p'),point('q')],unresolved:[{id:'gap',destinationId:'d'}]};
let serial=0;
function receipt(dir,b,from,count,{cloudFail=false,wet=true,complete=true}={}){
 const jobs=jobsFor(b.config),after=from+count;
 const rows=jobs.slice(from,after).map(j=>({...j,taskId:b.taskId,shardId:b.shardId,configFingerprint:b.configFingerprint,status:cloudFail&&j.overlay==='clouds'?'needs_review':'ok',value:cloudFail&&j.overlay==='clouds'?null:j.overlay==='rain'?(wet?1:0):90,unit:j.overlay==='rain'?'mm':'%',...(j.overlay==='rain'?{periodHours:3}:{}),model:'ecmwf',lat:27,lon:118,checkedAt:'2026-10-18T00:00:00Z'}));
 const data={taskId:b.taskId,shardId:b.shardId,configFingerprint:b.configFingerprint,from,after,rows,done:after,total:jobs.length,state:complete?'complete':'running',background:{id:b.taskId+'-'+b.shardId,running:!complete},metrics:{startedAt:b.config.windowAnchor}};
 const file=path.join(dir,'exports',String(++serial)+'.json');fs.writeFileSync(file,JSON.stringify({pageId:1,data}));return file;
}
try{
 const dir=path.join(temp,'normal');
 prepare({destinationIds:['d'],dates:['2026-10-23','2026-10-25'],shards:1},atlas,dir,now);
 let s=load(dir);assert.equal(s.expectedJobs.length,12);assert.equal(s.unresolved.length,1);
 let b=bind(dir,1,'s1');assert.throws(()=>bind(dir,2,'s1'));
 const first=receipt(dir,b,0,3,{complete:false});ingest(dir,first);
 assert.equal(recovery(dir,1).rows.length,3);assert.equal(load(dir).bindings[1].cursor,3);
 assert.equal(main(['snapshot',dir]).pending,9);assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'progress.json'),'utf8')).pending,9);
 const before=load(dir).metrics.exportedRows;ingest(dir,first);assert.equal(load(dir).metrics.exportedRows,before);
 assert.throws(()=>reconcile(dir,now));
 const orphan=receipt(dir,b,3,9);recoverReceipts(dir);assert(load(dir).inputs.some(f=>f.endsWith(path.basename(orphan))));
 const next=reconcile(dir,now);assert.equal(next.pending,4); // wet/cloudy -> 18:00 for BOTH points, never one representative replacing another.
 const follow=load(dir).configs.flatMap(jobsFor);assert(follow.every(j=>j.time==='2026-10-23T10:00:00.000Z'));
 b=bind(dir,1,'s1');ingest(dir,receipt(dir,b,0,b.total));reconcile(dir,now);
 assert.equal(load(dir).configs.length,0);
 const resumed=reconcile(dir,Date.parse('2026-10-18T09:00:00+08:00'));assert.equal(resumed.pending,4); // newly in-range Oct25 09:00 only.
 assert(load(dir).configs.flatMap(jobsFor).every(j=>j.time==='2026-10-25T01:00:00.000Z'));
 const dir2=path.join(temp,'missing-cloud');prepare({pointIds:['p'],dates:['2026-10-23'],followup:false},atlas,dir2,now);
 b=bind(dir2,1,'s1');ingest(dir2,receipt(dir2,b,0,b.total,{cloudFail:true}));reconcile(dir2,now);
 assert.deepEqual(load(dir2).configs.flatMap(jobsFor).map(j=>j.overlay),['clouds','clouds','clouds']);
 const wrong=JSON.parse(fs.readFileSync(receipt(dir2,bind(dir2,1,'s1'),0,1),'utf8'));wrong.data.taskId='other';
 const badFile=path.join(dir2,'exports','wrong.json');fs.writeFileSync(badFile,JSON.stringify(wrong));assert.throws(()=>ingest(dir2,badFile));
 const r={point:'p',time:'2026-10-23T09:00:00+08:00',status:'ok',model:'ecmwf',overlay:'rain',lat:27,lon:118,value:.5,unit:'mm',periodHours:3,checkedAt:'2026-10-18T00:00:00Z'};
 const merged=summarize(atlas,[{file:'synthetic',data:{rows:[{...r,checkedAt:'invalid-date',value:99},{...r,checkedAt:'2026-10-01T00:00:00Z'},r,{...r,checkedAt:'2026-10-18T02:00:00Z',value:1}]}}],['2026-10-23'],[9]);
 assert.equal(merged.valid[0].value,1);assert.equal(merged.rejected.length,2);assert.equal(merged.summary.wideCohorts,0);assert.equal(merged.revisions.length,1);
 assert(Number.isNaN(instant('2026-02-30T09:00:00Z')));assert(Number.isNaN(instant('2026-10-18T00:00:00')));
 const wide=summarize(atlas,[{file:'x',data:{rows:[r,{...r,overlay:'clouds',unit:'%',value:50,checkedAt:'2026-10-18T02:00:00Z'}]}}],['2026-10-23'],[9]);assert.equal(wide.summary.wideCohorts,1);
 const tasks=[10,1,1,10,1,1].map((n,i)=>({...point('p'+i),times:Array.from({length:n},(_,k)=>String(k))}));
 const loads=distribute(tasks,{shards:2},'test').map(c=>c.estimatedCost);assert.equal(loads[0],loads[1]);
 const largeDir=path.join(temp,'large'),largeAtlas={points:Array.from({length:93},(_,i)=>point('large'+i))};
 prepare({destinationIds:['d'],dates:['2026-10-23','2026-10-24'],shards:3,followup:false},largeAtlas,largeDir,now);
 for(let i=1;i<=3;i++)bind(largeDir,i,'s'+i);
 const snapshot=main(['snapshot',largeDir]);assert(JSON.stringify(snapshot).length<5000);assert(snapshot.configs.every(c=>!c.points));assert.equal(load(largeDir).expectedJobs.length,1116);
 console.log('PASS: invalid dates/window reject; latest valid wins; cohort warning; durable cursors/recovery/orphan receipts; no duplicate shard; exact missing-layer plan; adaptive point-specific evening; moving168h delta; balanced job costs.');
}finally{assert(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep+'windy-workflow-test-'));fs.rmSync(temp,{recursive:true,force:true});}
