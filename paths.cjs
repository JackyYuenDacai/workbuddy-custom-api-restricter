// Machine paths are separate from the policy injected into WorkBuddy.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const localPath = path.join(__dirname, 'paths.local.json');
const local = fs.existsSync(localPath) ? JSON.parse(fs.readFileSync(localPath, 'utf8').replace(/^\uFEFF/, '')) : {};
const configDir = process.env.WORKBUDDY_CONFIG_DIR || local.configDir || path.join(os.homedir(), '.workbuddy');
module.exports = Object.freeze({
  resourcesDir: process.env.WORKBUDDY_RESOURCES_DIR || local.resourcesDir ||
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'WorkBuddy', 'resources'),
  configDir,
  nodePath: process.env.WORKBUDDY_NODE_PATH || local.nodePath || process.execPath,
  backupDir: process.env.WORKBUDDY_BACKUP_DIR || local.backupDir || path.join(configDir, 'local-qwen-program-backup')
});
