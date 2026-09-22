import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const dir = path.dirname(fileURLToPath(import.meta.url));
const name = 'github-desktop-repos';
const action = process.argv[2];
if (!['install', 'check'].includes(action)) throw Error('Usage: node workbuddy-install.mjs install|check');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const config = json(path.join(dir, 'local-install.json'));
for (const field of ['nodePath', 'cliPath', 'configDir', 'databasePath', 'gitPath']) if (!path.isAbsolute(config[field] || '') || !fs.existsSync(config[field])) throw Error(`Configure an existing absolute ${field} in local-install.json`);
const env = { ...process.env, CODEBUDDY_CONFIG_DIR: config.configDir, WORKBUDDY_CONFIG_DIR: config.configDir };
function cli(args) { const r = spawnSync(config.nodePath, [config.cliPath, 'mcp', ...args], { env, encoding: 'utf8', timeout: 45000, windowsHide: true }); if (r.error || r.status !== 0) throw Error(r.error?.message || r.stderr || r.stdout || 'WorkBuddy CLI failed'); return r.stdout; }
const mcpFile = path.join(config.configDir, 'mcp.json'), settingsFile = path.join(config.configDir, 'settings.json');
const skillSource = path.join(dir, '..', 'skills', name), skillTarget = path.join(config.configDir, 'skills', name);
const desired = { type: 'stdio', command: config.nodePath, args: [path.join(dir, 'server.mjs')], env: { GITHUB_DESKTOP_DB_PATH: config.databasePath, GITHUB_DESKTOP_GIT_PATH: config.gitPath }, disabled: false };
if (action === 'install') {
  const mcp = fs.existsSync(mcpFile) ? json(mcpFile) : {};
  if (mcp.mcpServers?.[name] || fs.existsSync(skillTarget)) throw Error('A same-named MCP or skill already exists; compare before replacing it.');
  if (!fs.existsSync(path.join(skillSource, 'SKILL.md'))) throw Error('Skill source missing');
  const backup = path.join(config.configDir, 'backups', `github-desktop-repos-${Date.now()}`); fs.mkdirSync(backup, { recursive: true });
  for (const file of [mcpFile, settingsFile]) if (fs.existsSync(file)) fs.copyFileSync(file, path.join(backup, path.basename(file)));
  console.log(cli(['add-json', '--scope', 'user', name, JSON.stringify(desired)]));
  const updated = json(mcpFile); updated.mcpServers[name].disabled = false;
  if (Array.isArray(updated.disabledMcpServers)) updated.disabledMcpServers = updated.disabledMcpServers.filter(x => x !== name);
  fs.writeFileSync(mcpFile, JSON.stringify(updated, null, 2) + '\n');
  fs.cpSync(skillSource, skillTarget, { recursive: true, force: false, errorOnExist: true });
  if (fs.existsSync(settingsFile)) { const settings = json(settingsFile); if (settings.skillOverrides && Object.hasOwn(settings.skillOverrides, name)) { delete settings.skillOverrides[name]; fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n'); } }
  console.log(JSON.stringify({ installed: true, backup, skillTarget }));
}
const installed = json(mcpFile), actual = installed.mcpServers?.[name];
if (!actual || actual.disabled || installed.disabledMcpServers?.includes(name) || actual.command !== desired.command || JSON.stringify(actual.args) !== JSON.stringify(desired.args) || actual.env?.GITHUB_DESKTOP_DB_PATH !== config.databasePath || actual.env?.GITHUB_DESKTOP_GIT_PATH !== config.gitPath) throw Error('MCP configuration does not match or is disabled');
if (!fs.readFileSync(path.join(skillSource, 'SKILL.md')).equals(fs.readFileSync(path.join(skillTarget, 'SKILL.md')))) throw Error('Installed skill differs from source');
if (fs.existsSync(settingsFile) && Object.hasOwn(json(settingsFile).skillOverrides || {}, name)) throw Error('Skill override exists; inspect whether invocation is disabled');
const details = cli(['get', name]); console.log(details);
if (!/Status:\s*[^\r\n]*Connected/i.test(details) || /not connected|disconnected|failed/i.test(details)) throw Error('WorkBuddy did not confirm MCP connection');
console.log('Verified: MCP connected and enabled; installed skill matches source.');
