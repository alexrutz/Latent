import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

import type { Store } from './db.js';

/**
 * Encryption for the local image archive.
 *
 * The archive exists so rated images outlive the GPU that made them — which
 * means they sit on disk indefinitely. Encrypting them is what stops anyone with
 * access to that machine, or to a backup of it, from browsing them.
 *
 * Design:
 *
 *   KEK = scrypt(password, salt)          derived fresh on every unlock
 *   MK  = 32 random bytes                 the key files are actually encrypted with
 *   stored: salt, AES-GCM(KEK, MK)
 *
 * The indirection matters: changing the password re-wraps MK and nothing has to
 * be re-encrypted. The password itself is never stored, and MK only ever exists
 * in memory — so a stolen disk is useless, and a restarted server stays locked
 * until somebody logs in.
 *
 * Image *metadata* (prompt, seed, settings) deliberately stays readable in the
 * database, so filtering and sorting by rating still work server-side.
 */

const MAGIC = Buffer.from('LTNTv1');
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

const SALT_SETTING = 'vault_salt';
const WRAPPED_SETTING = 'vault_key';

export class VaultLockedError extends Error {
  override name = 'VaultLockedError';
  constructor() {
    super('The image archive is locked. Sign in to unlock it.');
  }
}

export class Vault {
  /** The master key, present only while unlocked. Never written to disk. */
  private masterKey: Buffer | null = null;

  constructor(private readonly store: Store) {}

  get isUnlocked(): boolean {
    return this.masterKey !== null;
  }

  /** True once a master key exists, whether or not it is currently unlocked. */
  get isInitialised(): boolean {
    return this.store.getSecretSetting(WRAPPED_SETTING) !== null;
  }

  private deriveKek(password: string, salt: Buffer): Buffer {
    return scryptSync(password, salt, KEY_LENGTH);
  }

  /**
   * Create the master key. Called once, when the password is first chosen.
   */
  initialise(password: string): void {
    if (this.isInitialised) return;

    const salt = randomBytes(16);
    const masterKey = randomBytes(KEY_LENGTH);
    const wrapped = this.seal(this.deriveKek(password, salt), masterKey);

    this.store.setSecretSetting(SALT_SETTING, salt.toString('base64'));
    this.store.setSecretSetting(WRAPPED_SETTING, wrapped.toString('base64'));
    this.masterKey = masterKey;
  }

  /**
   * Unlock with the password. Called on every successful login, and at boot when
   * `LATENT_PASSWORD` supplies one.
   */
  unlock(password: string): boolean {
    const saltRaw = this.store.getSecretSetting(SALT_SETTING);
    const wrappedRaw = this.store.getSecretSetting(WRAPPED_SETTING);
    if (!saltRaw || !wrappedRaw) {
      // No vault yet — a server that predates encryption, or a fresh one whose
      // password is being set right now.
      this.initialise(password);
      return true;
    }

    try {
      const kek = this.deriveKek(password, Buffer.from(saltRaw, 'base64'));
      this.masterKey = this.open(kek, Buffer.from(wrappedRaw, 'base64'));
      return true;
    } catch {
      this.masterKey = null;
      return false;
    }
  }

  lock(): void {
    this.masterKey?.fill(0);
    this.masterKey = null;
  }

  /**
   * Re-wrap the master key under a new password.
   *
   * Only the wrapper changes — every archived file stays exactly as it is, which
   * is the entire reason for having a master key rather than encrypting with a
   * password-derived key directly.
   */
  rewrap(currentPassword: string, newPassword: string): boolean {
    if (!this.isInitialised) {
      this.initialise(newPassword);
      return true;
    }
    if (!this.unlock(currentPassword)) return false;
    const masterKey = this.masterKey;
    if (!masterKey) return false;

    const salt = randomBytes(16);
    this.store.setSecretSetting(SALT_SETTING, salt.toString('base64'));
    this.store.setSecretSetting(
      WRAPPED_SETTING,
      this.seal(this.deriveKek(newPassword, salt), masterKey).toString('base64'),
    );
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* File encryption                                                   */
  /* ---------------------------------------------------------------- */

  encrypt(plaintext: Buffer): Buffer {
    const key = this.masterKey;
    if (!key) throw new VaultLockedError();
    return this.seal(key, plaintext);
  }

  decrypt(payload: Buffer): Buffer {
    const key = this.masterKey;
    if (!key) throw new VaultLockedError();
    return this.open(key, payload);
  }

  /** True when the bytes carry our header, so legacy plaintext files still work. */
  static isEncrypted(payload: Buffer): boolean {
    return payload.length > MAGIC.length && payload.subarray(0, MAGIC.length).equals(MAGIC);
  }

  /** `MAGIC | iv | tag | ciphertext` */
  private seal(key: Buffer, plaintext: Buffer): Buffer {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
  }

  private open(key: Buffer, payload: Buffer): Buffer {
    if (!Vault.isEncrypted(payload)) {
      throw new Error('Not an encrypted Latent file');
    }
    const iv = payload.subarray(MAGIC.length, MAGIC.length + IV_LENGTH);
    const tag = payload.subarray(MAGIC.length + IV_LENGTH, MAGIC.length + IV_LENGTH + TAG_LENGTH);
    const ciphertext = payload.subarray(MAGIC.length + IV_LENGTH + TAG_LENGTH);

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    // GCM authenticates: a tampered or wrong-key payload throws here rather
    // than returning garbage.
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  /** Used by tests to prove a wrong key cannot read the data. */
  static keysMatch(a: Buffer, b: Buffer): boolean {
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
