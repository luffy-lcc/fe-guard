/** 粗略耗时采集：只用于报告，不参与判定。 */
export function createTimings() {
  return { checks: {}, packages: [] }
}

export function now() {
  return Number(process.hrtime.bigint() / 1000000n)
}

export function recordCheck(timings, id, ms, status = 'ok') {
  if (!timings) return
  timings.checks[id] = { ms, status }
}

export function recordPackage(timings, check, pkg, ms, status = 'ok', violations = 0, extra = {}) {
  if (!timings) return
  timings.packages.push({
    check,
    package: pkg.name,
    dir: pkg.rel,
    ms,
    status,
    ...(violations ? { violations } : {}),
    ...extra,
  })
}
