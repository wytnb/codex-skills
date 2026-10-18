const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {createScope, syncScope, loadScope, read, write} = require('./recommendation-scope.cjs');
const {checkCoverage, assertReady, writeOfficialReport, render} = require('./recommendation.cjs');
const {load, bind, ingest, jobsFor, reconcile} = require('./workflow.cjs');
const {keyOf} = require('./reading-validation.cjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(),'windy-recommendation-test-'));
const start = Date.parse('2026-10-18T00:00:00+08:00');
const now = start+120000;
const iso = new Date(start+60000).toISOString();
let tests=0, serial=0;
function test(name, fn) { fn();tests++;console.log('PASS: '+name); }
function setup(label, count=2, date='2026-10-23', followup={}) {
  const root=path.join(temp,label);fs.mkdirSync(root);
  const points=Array.from({length:Math.max(count,2)},(_,i)=>({id:'p'+i,destinationId:'d'+i,label:'Lake '+i,
    lat:27+i*.01,lon:118,timeZone:'Asia/Shanghai',terrainElevationM:100,
    verification:'map and independent terrain',verifiedAt:'2026-10-18'}));
  const atlas={points,unresolved:[]};
  const registry={version:1,travelDates:[date],followup,candidates:points.slice(0,count).map((p,i)=>({id:p.destinationId,
    name:'Destination '+i,status:'B',pointIds:[p.id],dates:[date]}))};
  const registryFile=path.join(root,'candidates.json'),atlasFile=path.join(root,'atlas.json'),dir=path.join(root,'scope');
  write(registryFile,registry);write(atlasFile,atlas);
  const scope=createScope(dir,registryFile,atlasFile,start);
  return {root,dir,registryFile,atlasFile,scope,registry,atlas};
}
function fill(f, indices, modify=r=>r) {
  for (const index of indices) {
    const run=f.scope.runs[index],dir=path.join(f.dir,run.relativeDir),state=load(dir);
    if(!state.configs.length)continue;
    const b=bind(dir,1,'s1'),jobs=jobsFor(b.config);
    const rows=jobs.map(j=>{const p=f.atlas.points.find(p=>p.id===j.point);return modify({...j,
      taskId:b.taskId,configFingerprint:b.configFingerprint,status:'ok',model:'ecmwf',lat:p.lat,lon:p.lon,
      value:j.overlay==='rain'?0:10,unit:j.overlay==='rain'?'mm':'%',...(j.overlay==='rain'?{periodHours:3}:{}),checkedAt:iso});});
    const file=path.join(dir,'exports',++serial+'.json');
    write(file,{pageId:1,data:{taskId:b.taskId,configFingerprint:b.configFingerprint,shardId:b.shardId,
      from:0,after:rows.length,done:rows.length,total:rows.length,rows,state:'complete',background:{id:b.taskId+'-'+b.shardId,running:false}}});
    ingest(dir,file);
  }
}
function ranking(f) {
  return {weights:[7,10,7,7,2,8,9,6,6,7],ranked:f.registry.candidates.filter(c=>['A','B'].includes(c.status)).map(c=>({id:c.id,
    name:c.name,status:c.status,score:80,scores:Array(10).fill(8),weather:'calm samples'})),
    excluded:f.registry.candidates.filter(c=>!['A','B'].includes(c.status)).map(c=>({id:c.id,name:c.name,status:c.status}))};
}
function proof(f,text='Public source observed with complete date and geographic scope.') {
  const file='evidence-'+(++serial)+'.txt';fs.writeFileSync(path.join(f.dir,file),text);
  return {file,sha256:crypto.createHash('sha256').update(text).digest('hex'),quote:text};
}
function fallback(f,slots,reason='beyond-168h') {
  return {id:'fallback-'+(++serial),reason,checkedAt:iso,slots,
    source:{level:'scenic-daily',kind:'forecast',url:'https://example.org/public-forecast',geographicScope:'Explicit scenic area',
      summary:'Daily cloud and precipitation outlook',limitations:'Daily forecast does not resolve individual hours',
      pointIds:[...new Set(slots.map(r=>r.point))],dates:[...new Set(slots.map(r=>r.date))],artifact:proof(f)}};
}
try {
  test('full 54-candidate registry automatically prepares all 54 runs; 15 finished cannot hide 39',()=>{
    const f=setup('54-vs-15',54);assert.equal(f.scope.runs.length,54);assert.equal(f.scope.requirements.length,324);
    fill(f,Array.from({length:15},(_,i)=>i));
    // A forged aggregate claiming completion must have no effect.
    write(path.join(f.dir,f.scope.runs[15].relativeDir,'summary.json'),{summary:{missingRows:0,validRows:99999}});
    const result=checkCoverage(f.dir,undefined,now);
    assert.equal(result.ready,false);assert.equal(result.direct,90);assert.equal(result.missing.length,234);
    assert.equal(result.candidates.filter(c=>c.missing).length,39);
    assert.throws(()=>assertReady(f.dir,ranking(f),undefined,now),/39 candidates/);
    const out=path.join(f.root,'official.md'),json=path.join(f.root,'official.json');
    assert.throws(()=>writeOfficialReport(f.dir,ranking(f),'text',out,json,undefined,now));
    assert(!fs.existsSync(out));assert(!fs.existsSync(json));
    fs.writeFileSync(out,'previous artifact');
    assert.throws(()=>writeOfficialReport(f.dir,ranking(f),'text',out,json,undefined,now));
    assert.equal(fs.readFileSync(out,'utf8'),'previous artifact');
  });
  test('fully validated original receipts allow the real report writer and include coverage identity',()=>{
    const f=setup('positive');fill(f,[0,1]);const r=ranking(f),out=path.join(f.root,'ok.md'),json=path.join(f.root,'ok.json');
    const result=writeOfficialReport(f.dir,r,render(r),out,json,undefined,now);
    assert.equal(result.ready,true);assert.equal(result.direct,12);assert.equal(result.fallback,0);
    assert(fs.readFileSync(out,'utf8').includes(f.scope.scopeId));assert.equal(read(json).weatherCoverage.ready,true);
    assert.throws(()=>assertReady(f.dir,{...r,ranked:r.ranked.slice(0,1)},undefined,now),/exactly match/);
    assert.throws(()=>assertReady(f.dir,{...r,ranked:r.ranked.map(x=>({...x,status:'A'}))},undefined,now),/identity\/status/);
    const bad=structuredClone(r);bad.ranked[0].scores.pop();assert.throws(()=>assertReady(f.dir,bad,undefined,now),/subscores/);
    bad.ranked[0].scores=Array(10).fill(8);bad.ranked[0].score=99;assert.throws(()=>assertReady(f.dir,bad,undefined,now),/weighted/);
  });
  test('wrong model, bad coordinates, missing layer and stale/future task reads never count as verified',()=>{
    const mutations=[r=>({...r,model:'gfs'}),r=>({...r,lat:40}),r=>r.overlay==='clouds'?({...r,status:'needs_review',value:null}):r,
      r=>({...r,checkedAt:new Date(start-1).toISOString()}),r=>({...r,checkedAt:new Date(now+1).toISOString()}),r=>({...r,unit:'bad'})];
    mutations.forEach((modify,i)=>{const f=setup('invalid-'+i,1);fill(f,[0],modify);assert.equal(checkCoverage(f.dir,undefined,now).ready,false);});
  });
  test('in-range seasonal text, missing failure proof and tampered artifact cannot authorize fallback',()=>{
    const f=setup('unjustified',1),record=fallback(f,f.scope.requirements);
    write(path.join(f.dir,'evidence.json'),{fallbacks:[record]});assert.equal(checkCoverage(f.dir,undefined,now).fallback,0);
    record.reason='query-failed';record.attemptId='none';write(path.join(f.dir,'evidence.json'),{fallbacks:[record]});
    assert.equal(checkCoverage(f.dir,undefined,now).fallback,0);
    const attempt={id:'a',checkedAt:iso,reason:'restricted',slots:f.scope.requirements,artifact:proof(f,'Observed Premium restriction at the exact requested point/time/layer.')};
    record.attemptId='a';record.source.artifact.sha256='a'.repeat(64);
    write(path.join(f.dir,'evidence.json'),{attempts:[attempt],fallbacks:[record]});assert.equal(checkCoverage(f.dir,undefined,now).ready,false);
    record.source.artifact=proof(f);record.source.level='seasonal';record.source.kind='seasonal';
    write(path.join(f.dir,'evidence.json'),{attempts:[attempt],fallbacks:[record]});assert.equal(checkCoverage(f.dir,undefined,now).ready,false);
    record.earlierSources=['scenic-daily','trend','nearby','historical'].map(level=>({level,outcome:'unavailable',checkedAt:iso,artifact:proof(f,'Actual attempted source unavailable for the requested dates: '+level)}));
    write(path.join(f.dir,'evidence.json'),{scopeId:f.scope.scopeId,attempts:[attempt],fallbacks:[record]});
    assert.equal(checkCoverage(f.dir,undefined,now).ready,true);assert.equal(checkCoverage(f.dir,undefined,now).fallback,6);
    // One local failure must not cover a different slot.
    attempt.slots=attempt.slots.slice(0,1);write(path.join(f.dir,'evidence.json'),{attempts:[attempt],fallbacks:[record]});
    assert.equal(checkCoverage(f.dir,undefined,now).ready,false);
  });
  test('documented beyond-168h fallback works only until the moving window reaches those slots',()=>{
    const f=setup('later',1,'2026-10-27'),record=fallback(f,f.scope.requirements);
    write(path.join(f.dir,'evidence.json'),{fallbacks:[record]});
    assert.equal(checkCoverage(f.dir,undefined,now).ready,true);
    assert.equal(checkCoverage(f.dir,undefined,start+4*86400000).ready,false);
    record.source.dates=['2026-10-26'];write(path.join(f.dir,'evidence.json'),{fallbacks:[record]});
    assert.equal(checkCoverage(f.dir,undefined,now).ready,false);
    const later=start+4*86400000;
    reconcile(path.join(f.dir,f.scope.runs[0].relativeDir),later);
    fill(f,[0],r=>({...r,checkedAt:new Date(later+60000).toISOString()}));
    assert.equal(checkCoverage(f.dir,undefined,later+120000).ready,true);
  });
  test('registry edits are detected; sync adds candidates but refuses deletion, date/point/hour shrinkage',()=>{
    const f=setup('extend',1);fill(f,[0]);
    f.registry.candidates.push({id:'d1',name:'Destination 1',status:'A',pointIds:['p1'],dates:['2026-10-23']});
    write(f.registryFile,f.registry);assert.throws(()=>checkCoverage(f.dir,undefined,now),/registry changed/);
    f.scope=syncScope(f.dir,undefined,now);assert.equal(f.scope.runs.length,2);assert.equal(checkCoverage(f.dir,undefined,now).ready,false);
    fill(f,[1]);assert.equal(checkCoverage(f.dir,undefined,now).ready,true);
    const full=structuredClone(f.registry);f.registry.candidates.pop();write(f.registryFile,f.registry);
    assert.throws(()=>syncScope(f.dir,undefined,now),/remove candidate/);
    write(f.registryFile,full);full.candidates[0].hours=[9,12];write(f.registryFile,full);
    assert.throws(()=>syncScope(f.dir,undefined,now),/9\/12\/15/);
    full.candidates[0].hours=[9,12,15];full.followup=false;write(f.registryFile,full);
    assert.throws(()=>syncScope(f.dir,undefined,now),/authorization/);
  });
  test('point/date expansion queues only new slots; multiple points do not lose old run coverage',()=>{
    const f=setup('delta',1);f.registry.travelDates.push('2026-10-24');f.registry.candidates[0].dates.push('2026-10-24');
    write(f.registryFile,f.registry);f.scope=syncScope(f.dir,undefined,now);assert.equal(f.scope.runs.length,2);
    assert.deepEqual(f.scope.runs[1].request.dates,['2026-10-24']);
    f.atlas.points.push({...f.atlas.points[0],id:'p2',lat:27.02});f.registry.candidates[0].pointIds.push('p2');
    write(f.registryFile,f.registry);write(f.atlasFile,f.atlas);f.scope=syncScope(f.dir,f.atlasFile,now);
    assert.equal(f.scope.runs.length,3);assert.deepEqual(f.scope.runs[2].request.pointIds,['p2']);
    assert.deepEqual(f.scope.runs[2].request.dates,['2026-10-23','2026-10-24']);
    const keys=f.scope.runs.flatMap(run=>run.request.pointIds.flatMap(id=>run.request.dates.flatMap(date=>run.request.hours.map(hour=>id+'|'+date+'|'+hour))));
    assert.equal(keys.length,new Set(keys).size);
    f.registry.candidates[0].dates=['2026-10-24'];write(f.registryFile,f.registry);assert.throws(()=>syncScope(f.dir,undefined,now),/shrink/);
  });
  test('C/D/X reclassification retains candidates and requires real classification evidence; no scoring allowed',()=>{
    const f=setup('reclass',2);fill(f,[0]);f.registry.candidates[1]={...f.registry.candidates[1],status:'C',exclusion:{reason:'Verified constraint',...proof(f,'Official transport restriction proves this candidate cannot satisfy the requested dates.')}};
    write(f.registryFile,f.registry);f.scope=syncScope(f.dir,undefined,now);assert.equal(assertReady(f.dir,ranking(f),undefined,now).ready,true);
    const r=ranking(f);r.excluded[0].score=5;assert.throws(()=>assertReady(f.dir,r,undefined,now),/must not be scored/);
    fs.appendFileSync(path.resolve(f.dir,f.registry.candidates[1].exclusion.file),'changed');assert.equal(checkCoverage(f.dir,undefined,now).ready,false);
  });
  test('wet/cloud-changing primary reads require independent evening slots even if a run summary says complete',()=>{
    const f=setup('followup',1,'2026-10-23',{});fill(f,[0],r=>r.overlay==='rain'?({...r,value:2}):r);
    const result=checkCoverage(f.dir,undefined,now);assert.equal(result.requirements,8);assert.equal(result.missing.length,2);
    assert(result.missing.every(r=>r.hour===18));
  });
  test('active/unknown browser starts, altered run requests and foreign task receipts cannot pass',()=>{
    const f=setup('run-identity',1);fill(f,[0]);const runDir=path.join(f.dir,f.scope.runs[0].relativeDir),file=path.join(runDir,'state.json'),state=read(file);
    state.bindings[1].running=true;write(file,state);assert.equal(checkCoverage(f.dir,undefined,now).ready,false);
    state.bindings[1].running=false;state.request.dates=['2026-10-24'];write(file,state);
    assert.equal(checkCoverage(f.dir,undefined,now).ready,false);
    const other=setup('foreign',1);fill(other,[0]);const foreign=other.scope.runs[0];
    fs.cpSync(path.join(other.dir,foreign.relativeDir),path.join(f.dir,foreign.relativeDir),{recursive:true});
    f.scope.runs=[foreign];write(path.join(f.dir,'scope.json'),f.scope);
    assert.equal(checkCoverage(f.dir,undefined,now).ready,false);
  });
  test('wide read cohorts block until documented review, and mismatched scope evidence is rejected',()=>{
    const f=setup('cohort',1),later=now+3600000;
    fill(f,[0],r=>r.overlay==='clouds'?({...r,checkedAt:new Date(start+3500000).toISOString()}):r);
    const result=checkCoverage(f.dir,undefined,later);assert.equal(result.missing.length,0);assert.equal(result.ready,false);
    write(path.join(f.dir,'evidence.json'),{scopeId:f.scope.scopeId,cohortReviews:[{point:'p0',date:'2026-10-23',reason:'Reviewed forecast revisions without claiming a common model run',artifact:proof(f)}]});
    assert.equal(checkCoverage(f.dir,undefined,later).ready,true);
    write(path.join(f.dir,'evidence.json'),{scopeId:'another-task'});assert.throws(()=>checkCoverage(f.dir,undefined,later),/another scope/);
  });
  test('exclude/re-add cannot evade historical scope, and an all-excluded result still verifies evidence',()=>{
    const f=setup('reenter',1);f.registry.travelDates.push('2026-10-24');f.registry.candidates[0].dates.push('2026-10-24');write(f.registryFile,f.registry);
    f.scope=syncScope(f.dir,undefined,now);
    f.registry.candidates[0].status='C';f.registry.candidates[0].exclusion={reason:'Verified constraint',...proof(f)};
    write(f.registryFile,f.registry);f.scope=syncScope(f.dir,undefined,now);
    assert.equal(assertReady(f.dir,ranking(f),undefined,now).ready,true);
    f.registry.candidates[0].status='B';f.registry.candidates[0].dates=['2026-10-23'];write(f.registryFile,f.registry);
    assert.throws(()=>syncScope(f.dir,undefined,now),/shrink/);
  });
  test('CLI check/report fail closed for missing scope and do not create formal artifacts',()=>{
    const f=setup('cli',1),input=path.join(f.root,'ranking.json'),out=path.join(f.root,'official.md');write(input,ranking(f));
    const script=path.join(__dirname,'recommendation.cjs');
    const result=spawnSync(process.execPath,[script,'report',f.dir,input,out],{encoding:'utf8'});
    assert.notEqual(result.status,0);assert(!fs.existsSync(out));
    const missing=spawnSync(process.execPath,[script,'check',path.join(f.root,'not-a-scope')],{encoding:'utf8'});assert.notEqual(missing.status,0);
  });
  console.log('PASS: '+tests+' candidate-scope/report-gate scenarios. Synthetic data is confined to isolated test directories.');
} finally {
  assert(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep+'windy-recommendation-test-'));
  fs.rmSync(temp,{recursive:true,force:true});
}
