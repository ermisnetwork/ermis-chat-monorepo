// Optional source-only test preload. Transpile in memory; never writes dist or
// consumes another run's claimed build output. Normal tests use built bundles.
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const ts = require('typescript'), cp = require('node:child_process');
const root = path.resolve(__dirname, '..'), resolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, ...rest) {
  if (parent?.filename.startsWith(root + path.sep) && /(?:^|\/)dist\/(?:encryption\/)?index\.cjs$/.test(request)) {
    request = path.join(root, request.includes('/encryption/') ? 'src/encryption/index.ts' : 'src/index.ts');
  }
  return resolve.call(this, request, parent, ...rest);
};
require.extensions['.ts'] = (module, filename) => {
  let source = fs.readFileSync(filename, 'utf8');
  if (process.env.SDK_SOURCE_BASELINE === '1' && filename.startsWith(path.join(root, 'src') + path.sep)) {
    const result = cp.spawnSync('git', ['show', 'HEAD:packages/ermis-chat-sdk/' + path.relative(root, filename)], {cwd: root, encoding: 'utf8'});
    if (result.status === 0) source = result.stdout;
  }
  module._compile(ts.transpileModule(source, {compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  }, fileName: filename}).outputText, filename);
};
