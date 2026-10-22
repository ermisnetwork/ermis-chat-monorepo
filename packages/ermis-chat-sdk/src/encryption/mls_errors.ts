const MLS_REASON: Record<string, string> = {
  LifetimeRangeInvalid: 'lifetime_range_invalid', LeafNotYetValid: 'leaf_not_yet_valid',
  KeyPackageExpired: 'key_package_expired', InvalidClock: 'invalid_clock',
  StorageError: 'storage_error', StorageCorruption: 'storage_corruption',
  GroupInfoInvalid: 'group_info_invalid', EpochConflict: 'mls_protocol_epoch_gap',
  AcceptanceMetadataInvalid: 'acceptance_metadata_invalid', InvalidMessage: 'mls_invalid_message',
  CryptoError: 'mls_crypto_error', SerializationError: 'mls_invalid_message',
  DeserializationError: 'mls_invalid_message', GroupNotOperational: 'mls_group_not_operational',
  InvalidState: 'mls_invalid_state', TransportUnknown: 'transport_unknown',
};

/** Route by typed producer code; never parse a crypto exception message. */
export function normalizeMlsOperationError(value: unknown): unknown {
  const error = value as {code_name?: string | (() => string); free?: () => void};
  const name = typeof error?.code_name === 'function' ? error.code_name() : error?.code_name;
  if (typeof name !== 'string') return value;
  const reason = MLS_REASON[name] || 'mls_operation_failed';
  const result = new Error(`[Encryption] ${reason}`) as Error & {code: string};
  result.code = reason;
  error.free?.();
  return result;
}
