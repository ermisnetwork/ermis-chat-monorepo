# @ermis-network/ermis-chat-react

The official React UI components for Ermis Chat.

## E2EE UI Support

- `CreateChannelModal` supports E2EE direct/group creation when `client.mlsManager` is initialized.
- Channel info actions can enable E2EE for an existing standard channel when the viewer is the owner and MLS is initialized.
- Channel message lists listen for `e2ee.message_decrypted` and refresh decrypted message content from the SDK MLS storage.
- Channel info add/remove/leave member actions use MLS member commits for E2EE channels and fall back to standard channel APIs otherwise.
- Consumers can customize E2EE toggle rendering through `E2eeToggleComponent` and receive E2EE status/key-rotation props in channel info cover/actions components.

## Documentation

For full documentation, component references, and integration guides, please visit our official documentation website:

👉 **[Ermis Chat Documentation](https://ermisnetwork.github.io/ermis-chat-monorepo/)**
