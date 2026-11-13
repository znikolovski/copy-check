/**
 * Replaces the default Parcel build of web assets: the plugin is plain ES modules and is
 * served as-is. Copies plugin/tools/copy-check into the static bundle and points it at
 * this app's broker, so sites need no copy of the plugin.
 */
const fs = require('fs');
const path = require('path');

const PLUGIN_DIR = path.resolve(__dirname, '../../plugin/tools/copy-check');
const API_ACTION = 'copy-check/api';

function brokerUrl(config) {
  try {
    const urls = JSON.parse(fs.readFileSync(config.web.injectedConfig, 'utf8'));
    if (urls[API_ACTION]) return urls[API_ACTION];
  } catch {
    // fall through to the conventional URL
  }
  const host = new URL(config.ow.apihost).host;
  return `https://${config.ow.namespace}.${host}/api/v1/web/${API_ACTION}`;
}

module.exports = async (config) => {
  const out = config.web.distProd;
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(PLUGIN_DIR, out, { recursive: true });
  const html = path.join(out, 'copy-check.html');
  const url = brokerUrl(config).replace(/"/g, '&quot;');
  const page = fs.readFileSync(html, 'utf8');
  const stamped = page.replace('<meta name="copy-check-broker" content="">', `<meta name="copy-check-broker" content="${url}">`);
  if (stamped === page) throw new Error('copy-check.html has no empty copy-check-broker meta tag.');
  fs.writeFileSync(html, stamped);
  return true;
};
