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

// ==================================================================================================
// Tool State Manager (Singleton)
// Based on AIClient-2-API's ToolStateManager
// ==================================================================================================

interface CurrentToolCall {
    id: string
    name: string
    arguments: string
    startTime: number
}

/**
 * Global tool state manager for tracking tool calls across streaming
 * Implements singleton pattern for consistent state management
 */
class ToolStateManager {
    private static instance: ToolStateManager | null = null

    // Map function name -> tool ID for correlation
    private _toolMappings: Map<string, string> = new Map()

    // Track current tool calls in progress
    private _currentToolCalls: Map<string, CurrentToolCall> = new Map()

    // Deduplication: track recently processed tool call IDs
    private _processedToolIds: Set<string> = new Set()
    private _maxProcessedIds = 100

    private constructor() {
        // Private constructor for singleton
    }

    static getInstance(): ToolStateManager {
        if (!ToolStateManager.instance) {
            ToolStateManager.instance = new ToolStateManager()
        }
        return ToolStateManager.instance
    }

    /**
     * Store mapping from function name to tool ID
     */
    storeToolMapping(funcName: string, toolId: string): void {
        this._toolMappings.set(funcName, toolId)
    }

    /**
     * Get tool ID by function name
     */
    getToolId(funcName: string): string | null {
        return this._toolMappings.get(funcName) || null
    }

    /**
     * Start tracking a tool call
     */
    startToolCall(id: string, name: string): void {
        this._currentToolCalls.set(id, {
            id,
            name,
            arguments: "",
            startTime: Date.now(),
        })
    }

    /**
     * Append arguments to a tool call
     */
    appendToolArguments(id: string, args: string): void {
        const call = this._currentToolCalls.get(id)
        if (call) {
            call.arguments += args
        }
    }

    /**
     * Get and finalize a tool call
     */
    finalizeToolCall(id: string): CurrentToolCall | null {
        const call = this._currentToolCalls.get(id)
        if (call) {
            this._currentToolCalls.delete(id)
            this._markProcessed(id)
            return call
        }
        return null
    }

    /**
     * Get current tool call by ID
     */
    getToolCall(id: string): CurrentToolCall | null {
        return this._currentToolCalls.get(id) || null
    }

    /**
     * Check if a tool call ID was already processed (deduplication)
     */
    isProcessed(id: string): boolean {
        return this._processedToolIds.has(id)
    }

    /**
     * Mark a tool call ID as processed
     */
    private _markProcessed(id: string): void {
        this._processedToolIds.add(id)

        // Cleanup old IDs to prevent memory leak
        if (this._processedToolIds.size > this._maxProcessedIds) {
            const idsArray = Array.from(this._processedToolIds)
            const toRemove = idsArray.slice(0, Math.floor(this._maxProcessedIds / 2))
            toRemove.forEach(oldId => this._processedToolIds.delete(oldId))
        }
    }

    /**
     * Clear all mappings (call between conversations)
     */
    clearMappings(): void {
        this._toolMappings.clear()
    }

    /**
     * Clear all state (call between requests)
     */
    clearAll(): void {
        this._toolMappings.clear()
        this._currentToolCalls.clear()
        this._processedToolIds.clear()
    }

    /**
     * Get count of active tool calls
     */
    get activeToolCallCount(): number {
        return this._currentToolCalls.size
    }
}

// Export singleton instance
export const toolStateManager = ToolStateManager.getInstance()

