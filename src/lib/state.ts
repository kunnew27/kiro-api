/**
 * Global Application State
 */

import type { KiroAuthManager } from "./auth"

export interface AppState {
    // Server port
    port: number

    // Verbose logging
    verbose: boolean

    // Global auth manager (for simple mode)
    authManager: KiroAuthManager | null

    // Model cache
    modelCache: Map<string, any>
    modelCacheLastUpdate: number | null
}

export const state: AppState = {
    port: 8000,
    verbose: false,
    authManager: null,
    modelCache: new Map(),
    modelCacheLastUpdate: null,
}

