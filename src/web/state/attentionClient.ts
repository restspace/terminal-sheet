import { attentionIntegrationSetupSchema } from '../../shared/events';
import { fetchWithFrontendLease } from './frontendLeaseClient';

export async function fetchAttentionSetup() {
  const response = await fetchWithFrontendLease('/api/attention/setup');

  if (!response.ok) {
    throw new Error(`Attention setup request failed with ${response.status}`);
  }

  return attentionIntegrationSetupSchema.parse(await response.json());
}
