import type {WelcomeRecoveryCheckpoint} from './types';
import {sameSyncCheckpointValue as equal} from './checkpoint_value';
import {recoveryControlError} from './recovery_control';

/** A reset receipt disposes the old public event; it never proves old Welcome application. */
export function validateWelcomeGenerationDisposition(row: WelcomeRecoveryCheckpoint): void {
  const cp = row.checkpoint, marker = cp?.marker, receipt = cp?.generation_receipt;
  if (row.status !== 'superseded_by_generation' || !cp || !/^[0-9a-f]{64}$/.test(cp.provider_sha256) ||
      cp.receipt || cp.authored_device_id || cp.ratchet_tree_sha256 || !marker || marker.cid !== row.cid ||
      marker.status !== 'active' || !Number.isSafeInteger(row.group_generation) || row.group_generation < 0 ||
      !Number.isSafeInteger(marker.group_generation) || marker.group_generation !== row.group_generation + 1 || !Number.isSafeInteger(marker.current_epoch) || marker.current_epoch < 0 ||
      !(marker.group_id instanceof Uint8Array) || marker.group_id.length < 1 || marker.group_id.length > 255 ||
      !receipt || receipt.version !== 1 || receipt.cid !== row.cid ||
      !['activated', 'delivery_failed_retryable'].includes(receipt.state) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(receipt.operation_id) ||
      marker.operation_id !== receipt.operation_id || receipt.expected_generation !== row.group_generation ||
      receipt.current_generation !== marker.group_generation || !Number.isSafeInteger(receipt.current_epoch) ||
      receipt.current_epoch < 0 || receipt.current_epoch > marker.current_epoch || !equal(receipt.group_id, marker.group_id) ||
      typeof receipt.activated_at !== 'string' || !Number.isFinite(Date.parse(receipt.activated_at)) ||
      !/^[0-9a-f]{64}$/.test(receipt.membership_version)) throw recoveryControlError('welcome_generation_receipt_invalid');
}
