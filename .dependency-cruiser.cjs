/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'shared-is-foundation-only',
      severity: 'error',
      from: { path: '^packages/shared/src' },
      to: { path: '^packages/(daemon|cli|validator|escalation-mcp)/src' },
    },
    {
      name: 'validator-stays-thin',
      severity: 'error',
      from: { path: '^packages/validator/src' },
      to: { path: '^packages/(daemon|cli|escalation-mcp)/src' },
    },
    {
      name: 'cli-does-not-import-daemon',
      severity: 'error',
      from: { path: '^packages/cli/src' },
      to: { path: '^packages/daemon/src' },
    },
  ],
  options: {
    doNotFollow: {
      path: '(^|/)(\\.autopod-data|dist|node_modules)(/|$)',
    },
    exclude: {
      path: '(^|/)(\\.autopod-data|dist|node_modules)(/|$)',
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: 'tsconfig.base.json',
    },
  },
};
