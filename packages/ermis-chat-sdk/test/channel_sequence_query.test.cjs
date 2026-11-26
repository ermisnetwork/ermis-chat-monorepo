const assert = require('node:assert/strict');
const test = require('node:test');
const { ErmisChat } = require('../dist/index.cjs');

for (const selfHosted of [false, true]) {
  test(`sequence query uses the project contract with selfHosted=${selfHosted}`, async () => {
    const client = new ErmisChat({
      apiKey: 'fixture-key',
      baseURL: 'https://fixture.test',
      projectId: 'fixture-project',
      selfHosted,
      browser: false,
    });
    client.userID = 'fixture-user';
    client.user = { id: 'fixture-user' };
    const channel = client.channel('messaging', 'fixture-project:channel');
    const requests = [];
    client.post = async (url, body) => {
      requests.push({ url, body });
      return { messages: [] };
    };
    const options = { messages_seq: { anchor_seq: 42, before: 10 } };
    await channel.queryMessagesBySeq(options);

    assert.deepEqual(requests, [{
      url: 'https://fixture.test/channels/messaging/fixture-project:channel/query',
      body: selfHosted ? options : { ...options, project_id: 'fixture-project' },
    }]);
    assert.equal(Object.hasOwn(options, 'project_id'), false);
  });
}
