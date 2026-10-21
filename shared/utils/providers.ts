/**
 * The services a reader can hold a key for.
 *
 * Shared because both sides name them: the server stores one row per provider,
 * and the settings page draws a field per provider. Two lists would drift, and
 * the one that drifted would be the one nobody noticed until a key went to the
 * wrong service.
 */
export const PROVIDERS = {
  vision: { label: 'Google Cloud Vision' },
  openrouter: { label: 'OpenRouter' },
  anthropic: { label: 'Anthropic' },
  deepseek: { label: 'DeepSeek' },
} as const

export type Provider = keyof typeof PROVIDERS

export const PROVIDER_IDS = Object.keys(PROVIDERS) as Provider[]
