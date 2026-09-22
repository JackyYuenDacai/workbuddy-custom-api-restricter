const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { inspectInstallation, assertConnected } = require('./install-state.cjs');
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbuddy-codex-check-'));
  t.after(() => {
    if (path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('workbuddy-codex-check-')) throw Error('Unexpected cleanup path');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const repo = path.join(dir, 'repo'), configDir = path.join(dir, 'config');
  const skillRel = path.join('skills', 'codex-mcp-tools', 'SKILL.md');
  for (const base of [repo, configDir]) {
    fs.mkdirSync(path.dirname(path.join(base, skillRel)), { recursive: true });
    fs.writeFileSync(path.join(base, skillRel), '---\nname: codex-mcp-tools\ndescription: test\n---\n');
  }
  const config = { configDir, nodePath: process.execPath };
  const mcp = { mcpServers: { 'local-codex-tools': { type: 'stdio', command: process.execPath, args: [path.join(repo, 'codex-tools', 'server.mjs')], disabled: false } }, disabledMcpServers: [] };
  const writeMcp = () => fs.writeFileSync(path.join(configDir, 'mcp.json'), JSON.stringify(mcp));
  writeMcp();
  return { repo, configDir, config, mcp, writeMcp, skillRel };
}
test('valid enabled installation passes, including UTF-8 BOM configuration', t => {
  const x = setup(t);
  fs.writeFileSync(path.join(x.configDir, 'mcp.json'), '\uFEFF' + JSON.stringify(x.mcp));
  assert.deepEqual(inspectInstallation(x.config, x.repo), []);
});
test('disabled server and skill override are reported', t => {
  const x = setup(t);
  x.mcp.disabledMcpServers.push('local-codex-tools'); x.writeMcp();
  fs.writeFileSync(path.join(x.configDir, 'settings.json'), JSON.stringify({ skillOverrides: { 'codex-mcp-tools': 'off' } }));
  const issues = inspectInstallation(x.config, x.repo);
  assert.ok(issues.some(x => x.includes('MCP server is disabled')));
  assert.ok(issues.some(x => x.includes('invocation is overridden')));
});
test('missing and out-of-date skills fail verification', t => {
  const x = setup(t);
  const target = path.join(x.configDir, x.skillRel);
  fs.writeFileSync(target, 'old skill');
  assert.ok(inspectInstallation(x.config, x.repo).some(x => x.includes('differs')));
  fs.unlinkSync(target);
  assert.ok(inspectInstallation(x.config, x.repo).some(x => x.includes('missing')));
});
test('wrong MCP launch target is rejected', t => {
  const x = setup(t);
  x.mcp.mcpServers['local-codex-tools'].args = ['different-server.mjs']; x.writeMcp();
  assert.ok(inspectInstallation(x.config, x.repo).some(x => x.includes('does not point')));
});
test('CLI exit zero alone cannot claim connection success', () => {
  assert.doesNotThrow(() => assertConnected('Status: ✓ Connected'));
  assert.throws(() => assertConnected('Status: ✗ Failed to connect'), /did not report/);
});
test('MCP probe exits nonzero on a failed status tool', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'probe.mjs')], {
    encoding: 'utf8', windowsHide: true, timeout: 15000,
    env: { ...process.env, WORKBUDDY_CODEX_PATH: path.join(__dirname, '__missing_codex_executable__') }
  });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /existing absolute executable/);
});
