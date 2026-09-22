const fs = require('node:fs');
const path = require('node:path');
const name = 'local-codex-tools';
const skillName = 'codex-mcp-tools';
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const normalize = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
  return normalize(a) === normalize(b);
}
function inspectInstallation(config, repoDir) {
  const issues = [];
  const mcp = readJson(path.join(config.configDir, 'mcp.json'));
  const server = mcp.mcpServers?.[name];
  if (!server) issues.push('MCP server is missing.');
  else {
    if (server.disabled === true || mcp.disabledMcpServers?.includes(name)) issues.push('MCP server is disabled.');
    if (server.type !== 'stdio' || !samePath(server.command, config.nodePath) ||
        server.args?.length !== 1 || !samePath(server.args[0], path.join(repoDir, 'codex-tools', 'server.mjs'))) {
      issues.push('MCP command does not point to this repository and configured Node runtime.');
    }
  }
  const settingsFile = path.join(config.configDir, 'settings.json');
  const override = fs.existsSync(settingsFile) ? readJson(settingsFile).skillOverrides?.[skillName] : undefined;
  if (override !== undefined && override !== 'on') issues.push(`Skill invocation is overridden: ${String(override)}.`);
  const source = path.join(repoDir, 'skills', skillName);
  const installed = path.join(config.configDir, 'skills', skillName);
  function compare(sourceDir, targetDir) {
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
      const src = path.join(sourceDir, entry.name), dst = path.join(targetDir, entry.name);
      if (entry.isDirectory()) {
        if (!fs.existsSync(dst) || !fs.statSync(dst).isDirectory()) issues.push(`Installed skill directory is missing: ${entry.name}`);
        else compare(src, dst);
      } else if (entry.isFile()) {
        if (!fs.existsSync(dst) || !fs.statSync(dst).isFile()) issues.push(`Installed skill file is missing: ${entry.name}`);
        else if (!fs.readFileSync(src).equals(fs.readFileSync(dst))) issues.push(`Installed skill differs from repository: ${entry.name}`);
      }
    }
  }
  if (!fs.existsSync(path.join(source, 'SKILL.md'))) issues.push('Repository skill source is missing.');
  else compare(source, installed);
  return issues;
}
function assertConnected(output) {
  const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
  if (!/Status:\s*✓\s*Connected/.test(plain)) throw Error('WorkBuddy did not report a connected MCP server.\n' + plain);
}
module.exports = { readJson, inspectInstallation, assertConnected };
