/**
 * AuthManager Cache for Multi-Tenant Support
 * LRU cache for KiroAuthManager instances
 */

import consola from "consola"
import { KiroAuthManager } from "./auth"
import { config } from "./config"
import { maskToken } from "./utils"

export class AuthManagerCache {
    private maxSize: number
    private cache: Map<string, KiroAuthManager>

    constructor(maxSize: number = 100) {
        this.maxSize = maxSize
        this.cache = new Map()
        consola.info(`AuthManager cache initialized with max_size=${maxSize}`)
    }

    /**
     * Get or create AuthManager for given refresh token
     * Uses LRU cache: moves accessed items to end, evicts oldest when full
     */
    async getOrCreate(
        refreshToken: string,
        region?: string,
        profileArn?: string
    ): Promise<KiroAuthManager> {
        // Check if already cached
        if (this.cache.has(refreshToken)) {
            // Move to end (most recently used) - delete and re-add
            const manager = this.cache.get(refreshToken)!
            this.cache.delete(refreshToken)
            this.cache.set(refreshToken, manager)
            consola.debug(`AuthManager cache hit for token: ${maskToken(refreshToken)}`)
            return manager
        }

        // Create new AuthManager
        consola.info(`Creating new AuthManager for token: ${maskToken(refreshToken)}`)
        const authManager = new KiroAuthManager({
            refreshToken,
            region: region || config.region,
            profileArn: profileArn || config.profileArn,
        })

        // Add to cache
        this.cache.set(refreshToken, authManager)

        // Evict oldest if cache is full
        if (this.cache.size > this.maxSize) {
            const oldestKey = this.cache.keys().next().value
            if (oldestKey) {
                this.cache.delete(oldestKey)
                consola.info(`AuthManager cache full, evicted oldest token: ${maskToken(oldestKey)}`)
            }
        }

        consola.debug(`AuthManager cache size: ${this.cache.size}/${this.maxSize}`)
        return authManager
    }

    /**
     * Clear all cached AuthManager instances
     */
    clear(): void {
        const count = this.cache.size
        this.cache.clear()
        consola.info(`AuthManager cache cleared, removed ${count} instances`)
    }

    /**
     * Remove specific AuthManager from cache
     */
    remove(refreshToken: string): boolean {
        if (this.cache.has(refreshToken)) {
            this.cache.delete(refreshToken)
            consola.info(`Removed AuthManager from cache: ${maskToken(refreshToken)}`)
            return true
        }
        return false
    }

    /**
     * Get current cache size
     */
    get size(): number {
        return this.cache.size
    }
}

// Global cache instance
export const authCache = new AuthManagerCache(100)

