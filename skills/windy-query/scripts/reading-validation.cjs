const WINDOW_MS=168*3600000;
function instant(value){
 if(typeof value!=='string')return NaN;
 const m=value.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d)(?:\.(\d{1,3}))?)?(Z|([+-])(\d\d):(\d\d))$/);
 if(!m)return NaN;
 const [y,mo,d,h,mi,s]=m.slice(1,7).map(x=>Number(x||0));
 const days=new Date(Date.UTC(y,mo,0)).getUTCDate();
 if(mo<1||mo>12||d<1||d>days||h>23||mi>59||s>59||Number(m[10]||0)>23||Number(m[11]||0)>59)return NaN;
 return Date.parse(value);
}
const keyOf=r=>r.point+'|'+new Date(instant(r.time)).toISOString()+'|'+r.overlay;
function rejectReason(r,p,taskId){
 if(!r||!p)return 'unknown-or-superseded-point';
 const time=instant(r.time),checked=instant(r.checkedAt);
 if(r.status!=='ok')return 'needs_review';
 if(taskId&&r.taskId!==taskId)return 'wrong-task';
 if(r.model!=='ecmwf')return 'wrong-model';
 if(!Number.isFinite(time))return 'invalid-time';
 if(!Number.isFinite(checked))return 'invalid-checkedAt';
 if(time<checked||time-checked>WINDOW_MS)return 'outside-168h-at-read';
 if(!Number.isFinite(r.value)||r.value<0)return 'invalid-value';
 if(!Number.isFinite(r.lat)||!Number.isFinite(r.lon)||Math.abs(r.lat-p.lat)>.00015||Math.abs(r.lon-p.lon)>.00015)return 'coordinates-mismatch';
 if(r.overlay==='rain'&&(!['mm','cm'].includes(r.unit)||r.unit==='cm'&&r.quantity!=='snow-depth'||!Number.isFinite(r.periodHours)||r.periodHours<=0))return 'precipitation-unit-period';
 if(r.overlay==='clouds'&&(r.unit!=='%'||r.value>100))return 'cloud-unit-range';
 if(!['rain','clouds'].includes(r.overlay))return 'unsupported-layer';
 return null;
}
module.exports={instant,keyOf,rejectReason,WINDOW_MS};
