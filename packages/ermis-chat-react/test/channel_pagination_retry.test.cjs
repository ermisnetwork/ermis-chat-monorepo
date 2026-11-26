const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const hookSource = fs.readFileSync(path.join(__dirname, '../src/hooks/useLoadMessages.ts'), 'utf8');
const hookCode = ts.transpileModule(hookSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

for (const direction of ['before', 'after']) {
  test(`pagination ${direction} stops after failure and can retry the same anchor`, async () => {
    const frames = [];
    const anchors = [];
    const messagesRef = { current: [{ id: 'current', msg_seq: 10 }] };
    const older = direction === 'before';
    const channel = {
      cid: 'messaging:fixture',
      async queryMessagesBySeq({ messages_seq }) {
        assert.equal(messages_seq[direction], 50);
        anchors.push(messages_seq.anchor_seq);
        if (anchors.length === 1) throw new Error('fixture request failed');
        if (anchors.length > 2) return { messages: [] };
        return { messages: [{ id: 'next-page', msg_seq: older ? 9 : 11 }] };
      },
    };
    const fixture = { exports: {} };
    const dependencies = {
      react: {
        useRef: (current) => ({ current }),
        useState: (initial) => [initial, () => {}],
        useCallback: (callback) => callback,
        useEffect: (effect) => effect(),
      },
      './useChatCore': { useChatCore: () => ({ activeChannel: channel }) },
      './useChatMessages': {
        useChatMessages: () => ({ setMessages: (update) => { messagesRef.current = update(messagesRef.current); } }),
      },
      '@ermis-network/ermis-chat-sdk': { formatMessage: (message) => message },
    };
    vm.runInNewContext(hookCode, {
      exports: fixture.exports,
      require: (name) => dependencies[name],
      console: { error: () => {} },
      requestAnimationFrame: (callback) => frames.push(callback),
    });
    const hook = fixture.exports.useLoadMessages({
      messagesRef,
      vlistRef: { current: { scrollOffset: 0, viewportSize: 100, scrollSize: 100 } },
      jumpingRef: { current: false },
    });
    hook.hasNewerRef.current = !older;
    const load = older ? hook.loadMore : hook.loadNewer;

    await load();
    assert.deepEqual(anchors, [10]);
    assert.equal(frames.length, 0, 'failed request must not schedule another request');
    await load();
    assert.deepEqual(anchors, [10, 10]);
    assert.equal(frames.length, 1, 'successful page can continue filling the viewport');
    frames.shift()();
    await Promise.resolve();
    assert.deepEqual(anchors, [10, 10, older ? 9 : 11]);
    assert.equal(frames.length, 0, 'empty page ends the continuation');
  });
}
