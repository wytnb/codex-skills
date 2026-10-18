const assert=require('node:assert/strict');
const {resolveDates}=require('./read-official-forecast.js');
const now=Date.parse('2026-10-17T23:00:00+08:00');
assert.deepEqual(resolveDates(['周六（24日）','周日（25日）','周一（26日）','周二（27日）'],now),
  ['2026-10-24','2026-10-25','2026-10-26','2026-10-27']);
assert.throws(()=>resolveDates(['周一（17日）','周二（18日）'],now));
assert.throws(()=>resolveDates(['周六（24日）','周二（25日）'],now));
assert.throws(()=>resolveDates(['周六（24日）','周一（26日）'],now));
const crossMonth=Date.parse('2026-10-25T12:00:00+08:00');
assert.deepEqual(resolveDates(['周日（1日）','周一（2日）'],crossMonth),['2026-11-01','2026-11-02']);
console.log('PASS: date horizon, weekday, stale dates, sequence, month boundary.');
