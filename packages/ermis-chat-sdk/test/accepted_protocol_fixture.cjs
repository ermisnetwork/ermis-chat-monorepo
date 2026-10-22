const {sha256Hex} = require('../dist/encryption/index.cjs');
/** Simulates the backend envelope separately from the sender's signed MLS bytes. */
function accepted(manager, cid, bytes, epoch, generation = manager._groupGenerations.get(cid)?.group_generation || 0) {
  const envelope = {event_id: `fixture-${epoch}`, cid, group_generation: generation, epoch};
  return {acceptanceEnvelope: envelope, acceptanceContext: {version: 1, ...envelope,
    accepted_at: Math.floor(Date.now() / 1000), payload_sha256: sha256Hex(bytes), provenance: 'bellboy_transition_v1'}};
}
function processOwnAccepted(manager, cid, protocol) {
  return manager.processOwnMlsCommit(cid, protocol, accepted(manager, cid, protocol.commit, protocol.epoch, protocol.group_generation || 0));
}
module.exports = {accepted, processOwnAccepted};
