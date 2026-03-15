import { attentionIntegrationSetupSchema } from '../../shared/events';

export async function fetchAttentionSetup() {
  const response = await fetch('/api/attention/setup');

  if (!response.ok) {
    throw new Error(`Attention setup request failed with ${response.status}`);
  }

  return attentionIntegrationSetupSchema.parse(await response.json());
}
