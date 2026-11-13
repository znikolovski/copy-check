'use strict';

const { handle, buildDeps } = require('../../lib/router');

/** Web action: the broker API. Routes on __ow_path, see lib/router.js. */
async function main(params) {
  const deps = await buildDeps(params);
  return handle(params, deps);
}

exports.main = main;
