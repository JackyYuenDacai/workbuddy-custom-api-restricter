const fs = require('node:fs');
const path = require('node:path');
const { readJson, inspectInstallation, assertConnected } = require('./install-state.cjs');
const { spawnSync } = require('node:child_process');
const name = 'local-codex-tools';
const action = process.argv[2];
if (!['install', 'update', 'check'].includes(action)) throw Error('Usage: node workbuddy-install.cjs install|update|check');
const config = readJson(path.join(__dirname, 'local-install.json'));
for (const key of ['nodePath', 'cliPath', 'configDir']) {
  if (!path.isAbsolute(config[key] || '') || !fs.existsSync(config[key])) throw Error(`Configure an existing absolute ${key} in local-install.json.`);
}
const env = { ...process.env, CODEBUDDY_CONFIG_DIR: config.configDir, WORKBUDDY_CONFIG_DIR: config.configDir };
function cli(args) {
  const r = spawnSync(config.nodePath, [config.cliPath, 'mcp', ...args], { env, windowsHide: true, encoding: 'utf8', timeout: 45000 });
  if (r.error || r.status !== 0) throw Error(r.error?.message || r.stderr || r.stdout || 'WorkBuddy CLI failed.');
  return r.stdout;
}
if (action === 'install') {
  const mcpFile = path.join(config.configDir, 'mcp.json');
  const settingsFile = path.join(config.configDir, 'settings.json');
  const mcp = fs.existsSync(mcpFile) ? readJson(mcpFile) : {};
  const desired = { type: 'stdio', command: config.nodePath, args: [path.join(__dirname, 'server.mjs')], disabled: false };
  if (mcp.mcpServers?.[name]) throw Error('Server already exists; check the current configuration before changing it.');
  const skillSource = path.join(__dirname, '..', 'skills', 'codex-mcp-tools');
  const skillTarget = path.join(config.configDir, 'skills', 'codex-mcp-tools');
  if (fs.existsSync(skillTarget)) throw Error('Skill already exists; compare it with the repository before replacing it.');
  if (!fs.existsSync(path.join(skillSource, 'SKILL.md'))) throw Error('Skill source not found.');
  const backup = path.join(config.configDir, 'backups', `codex-tools-${Date.now()}`);
  fs.mkdirSync(backup, { recursive: true });
  for (const file of [mcpFile, settingsFile]) if (fs.existsSync(file)) fs.copyFileSync(file, path.join(backup, path.basename(file)));
  console.log(cli(['add-json', '--scope', 'user', name, JSON.stringify(desired)]));
  // Merge only this server's enabled state; keep every other server and setting.
  const updated = readJson(mcpFile);
  updated.mcpServers[name].disabled = false;
  if (Array.isArray(updated.disabledMcpServers)) updated.disabledMcpServers = updated.disabledMcpServers.filter(n => n !== name);
  fs.writeFileSync(mcpFile, JSON.stringify(updated, null, 2) + '\n');
  fs.cpSync(skillSource, skillTarget, { recursive: true, errorOnExist: true, force: false });
  if (fs.existsSync(settingsFile)) {
    const settings = readJson(settingsFile);
    if (settings.skillOverrides && Object.hasOwn(settings.skillOverrides, 'codex-mcp-tools')) {
      delete settings.skillOverrides['codex-mcp-tools'];
      fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
    }
  }
  console.log(JSON.stringify({ installed: true, skillTarget, backup }));
}
if (action === 'update') {
  const current = readJson(path.join(config.configDir, 'mcp.json')).mcpServers?.[name];
  if (!current || current.command !== config.nodePath || JSON.stringify(current.args) !== JSON.stringify([path.join(__dirname, 'server.mjs')])) throw Error('Installed MCP target differs; inspect configuration before updating.');
  const source = path.join(__dirname, '..', 'skills', 'codex-mcp-tools', 'SKILL.md');
  const target = path.join(config.configDir, 'skills', 'codex-mcp-tools', 'SKILL.md');
  const backup = path.join(config.configDir, 'backups', `codex-tools-update-${Date.now()}`); fs.mkdirSync(backup, { recursive: true });
  if (fs.existsSync(target)) fs.copyFileSync(target, path.join(backup, 'SKILL.md'));
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target);
  console.log(JSON.stringify({ updated: true, backup }));
}
const details = cli(['get', name]);
console.log(details);
assertConnected(details);
const issues = inspectInstallation(config, path.dirname(__dirname));
if (issues.length) throw Error(issues.join('\n'));
console.log('Verified: MCP connected and enabled; installed skill matches repository and permits normal invocation.');
