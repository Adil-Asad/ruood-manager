/**
 * The Android implementation of `SessionStore`.
 *
 * The port has two halves and so does this: the bearer token goes to
 * `expo-secure-store`, which on Android is the AndroidKeyStore, and everything
 * else goes to `AsyncStorage`, which is an ordinary file in the app's sandbox.
 *
 * That split is the whole security design of the client side, so it is worth
 * being explicit about what is on each side of it:
 *
 *   keystore      the Manager bearer token, and nothing else.
 *   AsyncStorage  ordinary preferences — never a credential,
 *                 and screen preferences. No credential, ever.
 *
 * ## What is NEVER stored anywhere on the device
 *
 * The RUOOD announcement signing key. It is an Ed25519 private key at
 * `~/.ruood/announcement-signing.key` on the operator's own machine, mode 0600,
 * outside every repository. The phone never has it, never asks for it, and has
 * nothing that could use it — the signing happens in the Manager process during
 * a publish, exactly as it did before this app existed.
 *
 * A GitHub token is in the same category. The app never talks to GitHub; the
 * Manager server commits and pushes with whatever git is configured with on
 * that machine.
 *
 * ## Why the failures are swallowed
 *
 * SecureStore can genuinely fail — a device with no screen lock on some OEM
 * builds, a keystore entry invalidated by a biometric change, a restore onto a
 * new device. Every one of those means "this device is not paired any more",
 * which is a screen, not a crash. A throw here would take down the app on
 * launch, which is the one outcome worth engineering against.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import type { SessionStore } from '@ruood/announcement-client';

/**
 * SecureStore keys may only contain alphanumerics, `.`, `-` and `_`.
 *
 * The shared keys use dots and are already legal; this asserts it rather than
 * assuming it, because the failure is a throw at runtime on the one call that
 * stores the credential.
 */
function secureKey(key: string): string {
  const safe = key.replace(/[^A-Za-z0-9._-]/g, '_');
  return safe;
}

export const androidSessionStore: SessionStore = {
  async readSecret(key) {
    try {
      return await SecureStore.getItemAsync(secureKey(key));
    } catch {
      // An unreadable keystore is an unpaired device, not a broken app.
      return null;
    }
  },

  async writeSecret(key, value) {
    // Deliberately NOT caught. Pairing that silently fails to store the token
    // would leave an app that works until it is next opened, and the operator
    // would have no reason to suspect the keystore.
    await SecureStore.setItemAsync(secureKey(key), value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED,
    });
  },

  async deleteSecret(key) {
    try {
      await SecureStore.deleteItemAsync(secureKey(key));
    } catch {
      // Signing out must always appear to succeed. If the entry cannot be
      // deleted it is already unreadable, which is the same outcome.
    }
  },

  async read(key) {
    try {
      return await AsyncStorage.getItem(key);
    } catch {
      return null;
    }
  },

  async write(key, value) {
    await AsyncStorage.setItem(key, value);
  },

  async delete(key) {
    try {
      await AsyncStorage.removeItem(key);
    } catch {
      /* already gone */
    }
  },
};

/**
 * Screen preferences: the last filter, the last channel, and nothing else.
 *
 * Kept separate from the session so that clearing preferences can never take
 * the credential with it, and so a reader of this file can see at a glance that
 * nothing sensitive passes through it.
 */
const PREF_PREFIX = 'ruood.manager.pref.';

export async function readPreference(name: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(`${PREF_PREFIX}${name}`);
  } catch {
    return null;
  }
}

export async function writePreference(name: string, value: string): Promise<void> {
  try {
    await AsyncStorage.setItem(`${PREF_PREFIX}${name}`, value);
  } catch {
    // A preference that will not persist is a preference that resets. That is
    // not worth an error in front of the operator.
  }
}
