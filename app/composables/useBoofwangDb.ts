// SPDX-License-Identifier: GPL-3.0-or-later
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { StoredBackup, StoredSession } from '#core/storage/db.js'
import { DB_NAME, DB_VERSION, STORE_BACKUPS, STORE_PREFS, STORE_SESSIONS } from '#core/storage/db.js'

/**
 * IndexedDB plumbing.
 *
 * Thin on purpose: the record shapes and the mapping to and from a RadioImage
 * live in `#core/storage/db`, which is DOM-free and unit-tested. This file is
 * the part that can only run in a browser.
 */

interface BoofwangSchema extends DBSchema {
  [STORE_BACKUPS]: {
    key: string
    value: StoredBackup
    indexes: { 'by-radio': string; 'by-created': string }
  }
  [STORE_SESSIONS]: { key: string; value: StoredSession }
  [STORE_PREFS]: { key: string; value: unknown }
}

let dbPromise: Promise<IDBPDatabase<BoofwangSchema>> | null = null

function db() {
  dbPromise ??= openDB<BoofwangSchema>(DB_NAME, DB_VERSION, {
    upgrade(d) {
      if (!d.objectStoreNames.contains(STORE_BACKUPS)) {
        const s = d.createObjectStore(STORE_BACKUPS, { keyPath: 'id' })
        s.createIndex('by-radio', 'radioId')
        s.createIndex('by-created', 'createdAt')
      }
      if (!d.objectStoreNames.contains(STORE_SESSIONS)) d.createObjectStore(STORE_SESSIONS, { keyPath: 'id' })
      if (!d.objectStoreNames.contains(STORE_PREFS)) d.createObjectStore(STORE_PREFS)
    },
  })
  return dbPromise
}

export function useBoofwangDb() {
  return {
    async putBackup(b: StoredBackup) {
      await (await db()).put(STORE_BACKUPS, b)
    },

    async getBackup(id: string) {
      return (await db()).get(STORE_BACKUPS, id)
    },

    /** Newest first. */
    async listBackups(): Promise<StoredBackup[]> {
      const all = await (await db()).getAll(STORE_BACKUPS)
      return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    },

    async deleteBackup(id: string) {
      await (await db()).delete(STORE_BACKUPS, id)
    },

    async latestBackupFor(identHash: string) {
      const all = await (await db()).getAll(STORE_BACKUPS)
      return all
        .filter((b) => b.identHash === identHash)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    },

    async putSession(s: StoredSession) {
      await (await db()).put(STORE_SESSIONS, s)
    },

    async getSession(id: string) {
      return (await db()).get(STORE_SESSIONS, id)
    },

    async getPref<T>(key: string): Promise<T | undefined> {
      return (await db()).get(STORE_PREFS, key) as Promise<T | undefined>
    },

    async setPref(key: string, value: unknown) {
      await (await db()).put(STORE_PREFS, value, key)
    },

    /**
     * Ask the browser to keep this data through storage pressure.
     *
     * Worth asking for: best-effort storage is evicted LRU, and Safari drops
     * script-created data after seven days without interaction - which is
     * entirely plausible for a tool someone reaches for once a month. Firefox
     * prompts; Chromium decides silently from engagement, so the answer is
     * reported rather than assumed.
     */
    async requestPersistence(): Promise<boolean> {
      if (!navigator.storage?.persist) return false
      if (await navigator.storage.persisted()) return true
      return navigator.storage.persist()
    },

    async estimate() {
      return navigator.storage?.estimate ? navigator.storage.estimate() : null
    },
  }
}
