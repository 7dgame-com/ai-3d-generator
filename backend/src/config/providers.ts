export const KNOWN_PROVIDERS = ['tripo3d', 'hyper3d'] as const;
export type KnownProvider = typeof KNOWN_PROVIDERS[number];

export function parseEnabledProviders(): string[] {
  const raw = process.env.ENABLED_PROVIDERS ?? '';
  if (!raw.trim()) {
    console.error('FATAL: ENABLED_PROVIDERS must specify at least one valid provider');
    process.exit(1);
  }
  const parsed = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const valid = [...new Set(parsed.filter(p => KNOWN_PROVIDERS.includes(p as KnownProvider)))];
  if (valid.length === 0) {
    console.error('FATAL: No valid providers found in ENABLED_PROVIDERS');
    process.exit(1);
  }
  return valid;
}
