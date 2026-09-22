import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { compareConfirmed } from './compare-integrated-benchmarks.mjs'

const [directory, scenario] = process.argv.slice(2)
const report = JSON.parse(await readFile(join(directory, 'BENCHMARK_REPORT.json'), 'utf8'))
const result = compareConfirmed(report, 'pacquet')
const base = (await readFile('revision-main.txt', 'utf8')).trim()
const head = (await readFile('revision-HEAD.txt', 'utf8')).trim()
console.log(`### ${scenario}

Baseline: \`${base}\`; candidate: \`${head}\`.

Both release binaries run on the same machine. The existing comparator requires a median slowdown exceeding 5% or 2 ms (whichever is larger), separated sample distributions after trimming up to 10% from each tail, and confirmation with reversed target order. Overlapping or unconfirmed results remain inconclusive. This noise guard does not establish statistical confidence or rule out smaller regressions.

| Baseline median | Candidate median | Change | Tolerance | Result |
| ---: | ---: | ---: | ---: | --- |
| ${(result.base * 1000).toFixed(2)} ms | ${(result.head * 1000).toFixed(2)} ms | ${((result.ratio - 1) * 100).toFixed(1)}% | ${(result.tolerance * 1000).toFixed(2)} ms | ${result.status} |
`)
process.exitCode = result.status === 'Regression' ? 1 : 0
