import type { DefaultGenerics, ExtendableGenerics } from '../types';
import type { EndUserApiMode, EndUserTransport } from './contract';
import { LegacyEndUserAuthApi, LegacyEndUserClientApi } from './legacy';
import { normalizeEndUserV1BaseURL, V1EndUserAuthApi, V1EndUserClientApi } from './v1';

export function resolveEndUserApiMode(mode: unknown, _selfHosted: boolean): EndUserApiMode {
  if (mode === undefined) return 'legacy';
  if (mode === 'legacy' || mode === 'v1') return mode;
  throw new Error(`Invalid endUserApiMode: ${String(mode)}`);
}

export function resolveEndUserBaseURL(input: string, _mode: EndUserApiMode): string {
  return normalizeEndUserV1BaseURL(input);
}

export function createEndUserAuthApi(args: {
  mode: EndUserApiMode;
  baseURL: string;
  apiKey: string;
  transport: EndUserTransport;
}) {
  return args.mode === 'v1'
    ? new V1EndUserAuthApi(args.baseURL, args.transport)
    : new LegacyEndUserAuthApi(args.baseURL, args.apiKey, args.transport);
}

export function createEndUserClientApi<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics>(args: {
  mode: EndUserApiMode;
  baseURL: string;
  apiKey: string;
  getProjectId: () => string | undefined;
  transport: EndUserTransport;
}) {
  return args.mode === 'v1'
    ? new V1EndUserClientApi<ErmisChatGenerics>(args.baseURL, args.transport)
    : new LegacyEndUserClientApi<ErmisChatGenerics>(args.baseURL, args.apiKey, args.getProjectId, args.transport);
}
