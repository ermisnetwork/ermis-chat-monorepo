const assert = require('node:assert/strict'), test = require('node:test');
const fs = require('node:fs'), Module = require('node:module'), path = require('node:path'), ts = require('typescript');
const filename = path.resolve(__dirname, '../src/utils/browserPaint.ts');
const fixture = new Module(filename, module);
fixture._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS}}).outputText, filename);
const {waitForBrowserPaint} = fixture.exports;

function browser(t, visibility = 'visible') {
  const oldWindow = global.window, oldDocument = global.document;
  let sequence = 0;
  const timers = new Map(), frames = new Map(), listeners = new Set(), canceled = [];
  global.window = {
    setTimeout(fn, ms) {const id = ++sequence; timers.set(id, {fn, ms}); return id;},
    clearTimeout(id) {timers.delete(id);},
    requestAnimationFrame(fn) {const id = ++sequence; frames.set(id, fn); return id;},
    cancelAnimationFrame(id) {canceled.push(id); frames.delete(id);},
  };
  global.document = {
    visibilityState: visibility,
    addEventListener(type, listener) {assert.equal(type, 'visibilitychange'); listeners.add(listener);},
    removeEventListener(type, listener) {assert.equal(type, 'visibilitychange'); listeners.delete(listener);},
  };
  t.after(() => {
    if (oldWindow === undefined) delete global.window; else global.window = oldWindow;
    if (oldDocument === undefined) delete global.document; else global.document = oldDocument;
  });
  return {timers, frames, listeners, canceled,
    hide() {global.document.visibilityState = 'hidden'; for (const listener of [...listeners]) listener();},
    fireTimer(ms) {const entry = [...timers].find(([, value]) => value.ms === ms); assert.ok(entry); timers.delete(entry[0]); entry[1].fn();},
    fireFrame() {const entry = [...frames][0]; assert.ok(entry); frames.delete(entry[0]); entry[1]();},
    assertClean() {assert.equal(timers.size, 0); assert.equal(frames.size, 0); assert.equal(listeners.size, 0);},
  };
}

test('hidden tab continues startup without requesting a suspended animation frame', async t => {
  const b = browser(t, 'hidden'); await waitForBrowserPaint(); b.assertClean();
});
test('visible startup yields through a frame and the following task', async t => {
  const b = browser(t); let complete = false;
  const work = waitForBrowserPaint().then(() => {complete = true;});
  await Promise.resolve(); assert.equal(complete, false);
  b.fireFrame(); await Promise.resolve(); assert.equal(complete, false);
  b.fireTimer(0); await work; b.assertClean();
});
test('missing frame completes at the fixed fallback and cancels its frame', async t => {
  const b = browser(t), work = waitForBrowserPaint();
  b.fireTimer(100); await work; assert.equal(b.canceled.length, 1); b.assertClean();
});
test('becoming hidden releases a pending frame and late callbacks do no work', async t => {
  const b = browser(t), work = waitForBrowserPaint(), lateFrame = [...b.frames.values()][0];
  b.hide(); await work; lateFrame(); b.assertClean();
});
test('becoming hidden after a frame clears the queued paint task', async t => {
  const b = browser(t), work = waitForBrowserPaint();
  b.fireFrame(); b.hide(); await work; b.assertClean();
});
test('frame scheduling failure releases startup and cleans its listener', async t => {
  const b = browser(t); global.window.requestAnimationFrame = () => {throw Error('Rendering unavailable');};
  await waitForBrowserPaint(); b.assertClean();
});
test('a browser without animation frame support proceeds directly', async t => {
  const b = browser(t); delete global.window.requestAnimationFrame;
  await waitForBrowserPaint(); b.assertClean();
});
test('server rendering does not require browser globals', async () => {
  await waitForBrowserPaint();
});
