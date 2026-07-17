import type { Tool } from '@openai/agents';
import type { RiskClass } from '../permissions.js';

export type ProviderCompatibility = 'chat-completions';

export type CapabilityManifestEntry = {
  id: string;
  description: string;
  risk: RiskClass;
  providerCompatibility: ProviderCompatibility[];
  tools: string[];
  source: 'builtin' | 'mcp';
};

export type RuntimeCapabilityManifest = {
  capabilities: CapabilityManifestEntry[];
  failedCapabilities: Array<{ id: string; error: string }>;
};

export type CapabilitySelection = {
  ids: string[];
  tools: Tool[];
};

export type CapabilityDefinition = {
  manifest: CapabilityManifestEntry;
  tools: Tool[];
};

export interface CapabilityRegistryApi {
  manifest(): RuntimeCapabilityManifest;
  select(ids?: string[]): CapabilitySelection;
  close(): Promise<void>;
}
