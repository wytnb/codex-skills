// Deterministic checks for incorrect units, out-of-window requests, and point errors.
const assert = require('node:assert/strict');
const {parse, normalize, near} = require('./windy-batch.js');
assert.deepEqual(parse('雨、雷暴\n0 mm\n雨、雪 (3h)\n?', 'rain'), {value: 0, unit: 'mm', periodHours: 3});
assert.deepEqual(parse('雨、雷暴\n2.3 mm\n雨 (3h)', 'rain'), {value: 2.3, unit: 'mm', periodHours: 3});
assert.deepEqual(parse('雨、雷暴\n0 cm\n湿雪 (3h)', 'rain'), {value:0,unit:'cm',quantity:'snow-depth',phase:'wet-snow',periodHours:3});
assert.deepEqual(parse('雨、雷暴\n2 cm\n雪 (3h)', 'rain'), {value:2,unit:'cm',quantity:'snow-depth',phase:'snow',periodHours:3});
assert.deepEqual(parse('云\n99 %\n降水: 2.2 mm (3h)', 'clouds'), {value: 99, unit: '%'});
for (const raw of ['雨\n0 mm', '雨\nLoading 0 mm (3h)', 'Premium', '雨\n-1 mm (3h)','雨\n0 mm (0h)'])
  assert.throws(() => parse(raw, 'rain'));
assert.throws(() => parse('云\n101 %', 'clouds'));
const now = Date.parse('2026-10-17T22:00:00+08:00');
const point = {id: 'peak', lat: 27.65, lon: 117.94, terrainElevationM: 391,
  verifiedAt: '2026-10-17', verification: 'map and elevation checked'};
const result = normalize({points: [point, point], overlays: ['rain', 'clouds'], times: [
  '2026-10-24T22:00:00+08:00', // inclusive 168-hour boundary
  '2026-10-24T22:00:00+08:00',
  '2026-10-24T22:00:01+08:00', // excluded, never silently filled as zero
  '2026-10-17T21:59:00+08:00'
]}, now);
assert.equal(result.jobs.length, 2);
assert.equal(result.excluded.length, 2);
assert.throws(() => normalize({points: [point], times: ['2026-10-23T12:00:00']}, now));
assert.throws(() => normalize({points: [point, {...point, lat: 28}], times: ['2026-10-23T12:00:00+08:00']}, now));
assert.throws(() => normalize({points: [{...point, terrainElevationM: undefined}], times: ['2026-10-23T12:00:00+08:00']}, now));
assert.equal(near({lat: 27.65004, lon: 117.94003}, point), true);
assert.equal(near({lat: 27.65, lon: 117.93}, point), false);
// A changed model must pause a running plan without inventing or advancing a row.
const vm = require('node:vm');
const fs = require('node:fs');
let model = 'ecmwf';
const context = {setTimeout, clearTimeout, Date, Intl, console, performance,
  location: {hostname: 'www.windy.com'},
  document: {querySelector: selector => selector === '.box-text' ? {} : null},
  W: {store: {get: key => key === 'product' ? model : undefined, set() {}},
    map: {map: {latLngToContainerPoint() {}, setView() {}}}}};
vm.runInNewContext(fs.readFileSync(require.resolve('./windy-batch.js'), 'utf8'), context);
context.WindyQuery.init({points: [point], times: [new Date(Date.now() + 86400000).toISOString()]});
model = 'gfs';
context.WindyQuery.step().then(result => {
  assert.equal(result.state, 'needs_review');
  assert.equal(result.done, 0);
  assert.equal(result.rows.length, 0);
  assert.match(result.error, /ECMWF/);
  console.log('PASS: units, loading/missing values, timezone, 168h boundary, deduplication, coordinates, model-change pause with no fabricated row.');
}).catch(error => { console.error(error); process.exitCode = 1; });
