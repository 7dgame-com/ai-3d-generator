import { IProviderAdapter } from './IProviderAdapter';

export class ProviderRegistry {
  private adapters = new Map<string, IProviderAdapter>();

  register(adapter: IProviderAdapter): void {
    this.adapters.set(adapter.providerId, adapter);
  }

  get(providerId: string): IProviderAdapter | undefined {
    return this.adapters.get(providerId);
  }

  getAll(): IProviderAdapter[] {
    return Array.from(this.adapters.values());
  }

  getEnabledIds(): string[] {
    return Array.from(this.adapters.keys());
  }

  isEnabled(providerId: string): boolean {
    return this.adapters.has(providerId);
  }
}

export const providerRegistry = new ProviderRegistry();
