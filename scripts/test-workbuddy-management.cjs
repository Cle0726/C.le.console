// Offline regression checks: no network access and no user credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function loadTypeScript(relativePath, dependencies) {
  const filename = path.join(__dirname, '..', relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports,
    require(name) {
      if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected dependency: ${name}`);
      return dependencies[name];
    },
  }, { filename });
  return module.exports;
}

(async () => {
  let response;
  const service = loadTypeScript('src/services/workbuddyService.ts', {
    '@tauri-apps/api/core': { invoke: async () => response },
  });
  response = {
    success_count: 1, failed_count: 1,
    results: [
      { account_id: 'a', email: 'a@example.invalid', success: true },
      { account_id: 'b', email: 'b@example.invalid', success: false, error: '额度查询失败 (http=403)' },
    ],
  };
  await assert.rejects(service.refreshAllWorkbuddyTokens(), /1 个成功，1 个失败[\s\S]*b@example.invalid[\s\S]*http=403/);
  response = { success_count: 2, failed_count: 0, results: [] };
  assert.equal(await service.refreshAllWorkbuddyTokens(), 2);
  response = 3;
  assert.equal(await service.refreshAllWorkbuddyTokens(), 3);

  const parser = loadTypeScript('src/utils/codebuddy-suite/parser.ts', {
    '../../types/codebuddy-suite': { PACKAGE_CODE: {}, RESOURCE_STATUS: { valid: 0, usedUp: 3 } },
  });
  assert.equal(parser.getAccountQuotaUpdatedAtMs({ last_used: 999, usage_updated_at: 5 }), 5000);
  assert.equal(parser.getAccountQuotaUpdatedAtMs({ last_used: 999, usage_updated_at: 5, quota_query_last_error: 'failed' }), 5000);
  assert.equal(parser.getAccountQuotaUpdatedAtMs({ last_used: 999, quota_query_last_error: 'failed' }), null);
  assert.equal(parser.getAccountQuotaUpdatedAtMs({ last_used: 999 }), 999000);
  console.log('WorkBuddy frontend: 7 offline regression checks passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
