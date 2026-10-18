const assert=require('node:assert/strict'),{summarize}=require('./summarize-readings.cjs');
const atlas={points:[{id:'p',destinationId:'d',lat:27,lon:118,timeZone:'Asia/Shanghai'}]};
const row={point:'p',time:'2026-10-23T09:00:00+08:00',overlay:'rain',status:'ok',model:'ecmwf',lat:27,lon:118,value:0,unit:'mm',periodHours:3,checkedAt:'2026-10-18T00:00:00Z'};
const newer={...row,checkedAt:'2026-10-18T00:01:00Z',value:.5};
const r=summarize(atlas,[{file:'a',data:{rows:[row,{...row,point:'wrong'},{...row,lat:28},{...row,unit:'mm/h'},{...row,status:'needs_review',value:null}]}},{file:'b',data:{rows:[newer]}}],['2026-10-23'],[9]);
assert.equal(r.summary.validRows,1);assert.equal(r.valid[0].value,.5);assert.equal(r.summary.rejectedRows,4);assert.equal(r.summary.missingRows,1);assert.deepEqual(r.daily[0].rainMm,[.5,.5]);assert.equal(r.daily[0].cloudPct,null);
const snow=summarize(atlas,[{file:'snow',data:{rows:[{...row,value:2,unit:'cm',quantity:'snow-depth',phase:'wet-snow'}]}}],['2026-10-23'],[9]);
assert.equal(snow.daily[0].rainMm,null);assert.deepEqual(snow.daily[0].snowCm,[2,2]);assert.equal(snow.summary.validRows,1);
console.log('PASS: zero is valid, newest deduplicated by UTC, wrong point/units/review rows excluded, missing clouds remain null.');
