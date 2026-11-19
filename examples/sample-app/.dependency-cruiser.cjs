/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'services-no-ui',
      severity: 'error',
      comment: 'services 层不允许依赖 ui 层',
      from: { path: '^src/services' },
      to: { path: '^src/ui' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: '不允许循环依赖',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
  },
}
