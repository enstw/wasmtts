import assert from 'node:assert/strict';

import {rankPilot} from './rank-matcha-g2p-roi.mjs';

const report = rankPilot({
  input: {
    stratifyPrevious: '地',
    stratifiedOccurrences: {慎: 12, 天: 30, 主: 8},
  },
  differenceGroups: [{character: '地', matcha: 'di4', g2pw: 'de5', count: 3}],
  focusContexts: [
    {previous: '慎', g2pw: 'de5', count: 3},
    {previous: '天', g2pw: 'di4', count: 2},
    {previous: '天', g2pw: 'de5', count: 1},
    {previous: '主', g2pw: 'de5', count: 2},
  ],
}, 3);

assert.deepEqual(report.summary, {
  candidates: 3, actionable: 1, consistentCurrent: 0, mixed: 1, insufficient: 1,
});
assert.deepEqual(report.candidates[0], {
  previous: '慎',
  corpusOccurrences: 12,
  samples: 3,
  currentPhones: [{phone: 'di4', count: 3}],
  predictions: [{phone: 'de5', count: 3}],
  status: 'actionable',
  estimatedAffectedCeiling: 12,
});
assert.equal(report.candidates.find((item) => item.previous === '天').status, 'mixed');
assert.equal(report.candidates.find((item) => item.previous === '主').status, 'insufficient');

const followingReport = rankPilot({
  input: {
    stratifyFollowing: '和',
    stratifiedOccurrences: {他: 20, 平: 5},
  },
  differenceGroups: [{character: '和', matcha: 'he2', g2pw: 'han4', count: 3}],
  focusContexts: [
    {following: '他', matcha: 'he2', g2pw: 'han4', count: 3},
    {following: '平', matcha: 'he2', g2pw: 'he2', count: 3},
  ],
}, 3);

assert.equal(followingReport.direction, 'following');
assert.deepEqual(followingReport.candidates[0], {
  following: '他',
  corpusOccurrences: 20,
  samples: 3,
  currentPhones: [{phone: 'he2', count: 3}],
  predictions: [{phone: 'han4', count: 3}],
  status: 'actionable',
  estimatedAffectedCeiling: 20,
});
assert.equal(followingReport.candidates.find((item) => item.following === '平').status, 'consistent-current');

console.log(JSON.stringify(report.summary, null, 2));
