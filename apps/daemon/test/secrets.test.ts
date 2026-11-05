import { describe, expect, it } from 'vitest';
import { keychainStore } from '../src/market/secrets.ts';

/** A password store that keeps what it's given in memory, unless told to garble it. */
function fakeVault(garble = false) {
  const keys = new Map<string, string>();
  const reads: string[] = [];
  return {
    keys,
    reads,
    read: async (name: string) => (reads.push(name), keys.get(name) ?? null),
    write: async (name: string, value: string) => void keys.set(name, garble ? 'something else' : value),
    remove: async (name: string) => void keys.delete(name),
  };
}

describe('API keys', () => {
  it('writes a key, reads it back, and then serves it without asking again', async () => {
    const vault = fakeVault();
    const store = keychainStore(vault);
    await store.set('brapi', 'a-test-key-12345');
    expect(vault.keys.get('brapi')).toBe('a-test-key-12345');
    vault.reads.length = 0;
    expect(await store.get('brapi')).toBe('a-test-key-12345');
    expect(await store.source('brapi')).toBe('keychain');
    expect(vault.reads).toEqual([]);
    await store.remove('brapi');
    expect(await store.get('brapi')).toBeNull();
  });

  it("doesn't trust a key that reads back differently", async () => {
    const store = keychainStore(fakeVault(true));
    await expect(store.set('brapi', 'a-test-key-12345')).rejects.toThrow('reads back differently');
  });

  it("doesn't ask again for a missing key for a minute", async () => {
    const vault = fakeVault();
    const store = keychainStore(vault);
    expect(await store.get('brapi')).toBeNull();
    expect(await store.get('brapi')).toBeNull();
    expect(vault.reads).toEqual(['brapi']);
  });
});

// Windows Credential Manager, for real: a key under a throwaway name, gone again afterwards.
// (The Mac's Keychain isn't tested here: a test shouldn't write to it, or set off its prompts.)

describe.runIf(process.platform === 'win32')('API keys on Windows', () => {
  const name = `bt-test-${process.pid}`;

  it('keeps a key where a new bloomd finds it, and removes it', async () => {
    const store = keychainStore();
    try {
      expect(await store.source(name)).toBeNull();
      await store.set(name, 'a-test-key-12345');
      expect(await store.get(name)).toBe('a-test-key-12345');
      const fresh = keychainStore();
      expect(await fresh.source(name)).toBe('keychain');
      expect(await fresh.get(name)).toBe('a-test-key-12345');
      await store.set(name, 'a-second-key-67890');
      expect(await keychainStore().get(name)).toBe('a-second-key-67890');
    } finally {
      await store.remove(name);
    }
    expect(await keychainStore().get(name)).toBeNull();
  });

  it('refuses what is not a key', async () => {
    await expect(keychainStore().set(name, 'has spaces in it')).rejects.toThrow("doesn't look like an API key");
  });
});
