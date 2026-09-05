// Fork-only experiment; do not include this workflow or its mutations in the upstream PR.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import console from 'node:console'
import fs from 'node:fs'
import os from 'node:os'
import process from 'node:process'

const variant = process.argv[2]
const expectations = {
  normal: ['ok', 'ok'],
  'no-retry': ['FAILED', 'FAILED'],
  'cleanup-bypass': ['FAILED', 'ok'],
  'replacement-bypass': ['ok', 'FAILED'],
}
assert.equal(process.platform, 'win32', 'This experiment requires native Windows')
assert(Object.hasOwn(expectations, variant), `Unknown variant: ${variant}`)
console.log({ variant, platform: process.platform, release: os.release(), commit: process.env.GITHUB_SHA })

const retryFile = 'pnpm/crates/fs/src/retry.rs'
const linkerFile = 'pnpm/crates/cmd-shim/src/link_bins.rs'
if (variant === 'no-retry') {
  replaceExactlyOnce(retryFile, `pub fn remove_file_with_retry(path: &Path) -> io::Result<()> {
    retry_transient_file_locks(|| {
        let result = fs::remove_file(path);
        #[cfg(all(windows, feature = "test"))]
        crate::test_support::notify_file_removal(path, &result);
        result
    })
}`, `pub fn remove_file_with_retry(path: &Path) -> io::Result<()> {
    let result = fs::remove_file(path);
    #[cfg(all(windows, feature = "test"))]
    crate::test_support::notify_file_removal(path, &result);
    result
}`)
}
if (variant === 'cleanup-bypass' || variant === 'replacement-bypass') {
  if (variant === 'cleanup-bypass') {
    replaceExactlyOnce(linkerFile, '    remove_if_exists(bin_path)?;', '    remove_without_retry(bin_path)?;')
  } else {
    replaceExactlyOnce(linkerFile, '    remove_if_exists(path)\n        .map_err', '    remove_without_retry(path)\n        .map_err')
  }
  fs.appendFileSync(linkerFile, `
fn remove_without_retry(path: &Path) -> io::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}
`)
}

const result = spawnSync('cargo', [
  'test', '--locked', '-p', 'pnpm-cmd-shim', '--lib', 'windows_native::',
  '--', '--test-threads=2', '--show-output',
], { encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 })
const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
console.log(output)
fs.mkdirSync('.artifacts/windows-bin-removal', { recursive: true })
fs.writeFileSync(`.artifacts/windows-bin-removal/${variant}.log`, output)
assert.ifError(result.error)
assert.equal(result.signal, null, 'Cargo must not be terminated')
assert.match(output, /^running 2 tests\r?$/m, 'Both regression tests must execute')

const tests = ['cleanup_recovers_after_transient_lock', 'replacement_recovers_after_transient_lock']
for (const [index, name] of tests.entries()) {
  const status = expectations[variant][index]
  const qualifiedName = `link_bins::tests::windows_native::${name}`
  assert.match(output, new RegExp(`^test ${qualifiedName} \\.\\.\\. ${status}\\r?$`, 'm'))
  const start = output.indexOf(`---- ${qualifiedName} stdout ----`)
  assert(start >= 0, `Missing captured output for ${name}`)
  const end = output.indexOf('\n---- ', start + 1)
  const section = output.slice(start, end < 0 ? undefined : end)
  if (status === 'ok') {
    assert.match(section, /removal result: Ok\(\(\)\); real filesystem attempts: \[Err\(Some\((5|32|33)\)\)[^\r\n]*Ok\(\(\)\)/)
  } else {
    assert.match(section, /removal result: Err/)
    assert.match(section, /the operation must recover after the deny-delete handle closes/)
    assert.match(section, variant === 'no-retry'
      ? /real filesystem attempts: \[Err\(Some\((5|32|33)\)\)\]/
      : /real filesystem attempts: \[\]/)
  }
}
assert.equal(result.status, variant === 'normal' ? 0 : 101, 'Expected a test result, not a build or runner error')

const summary = `### ${variant}\n\nNative tests ran: 2. Cleanup: ${expectations[variant][0]}. Replacement: ${expectations[variant][1]}.\n\n${variant === 'normal' ? 'Real locked deletion recovered after handle release.' : 'Expected regression detected; this is an ablation result, not a passing mutant.'}\n`
console.log(summary)
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)

function replaceExactlyOnce (file, original, replacement) {
  const source = fs.readFileSync(file, 'utf8')
  assert.equal(source.split(original).length, 2, `Mutation must match exactly once: ${file}`)
  fs.writeFileSync(file, source.replace(original, replacement))
}
