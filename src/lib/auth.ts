/**
 * Kiro Authentication Manager
 * Handles token lifecycle, refresh, and credentials loading
 */

import consola from "consola"
import { readFileSync, writeFileSync, existsSync } from "fs"
import { config, getKiroRefreshUrl, getKiroApiHost, getKiroQHost } from "./config"
import { getMachineFingerprint, maskToken, sleep } from "./utils"
import { TokenRefreshError } from "./error"

export class KiroAuthManager {
    private _refreshToken: string
    private _profileArn: string
    private _region: string
    private _credsFile: string | null

    private _accessToken: string | null = null
    private _expiresAt: Date | null = null
    private _refreshLock: Promise<void> | null = null

    private _refreshUrl: string
    private _apiHost: string
    private _qHost: string
    private _fingerprint: string

    constructor(options: {
        refreshToken?: string
        profileArn?: string
        region?: string
        credsFile?: string | null
    } = {}) {
        this._refreshToken = options.refreshToken || ""
        this._profileArn = options.profileArn || ""
        this._region = options.region || "us-east-1"
        this._credsFile = options.credsFile || null

        // Dynamic URLs based on region
        this._refreshUrl = getKiroRefreshUrl(this._region)
        this._apiHost = getKiroApiHost(this._region)
        this._qHost = getKiroQHost(this._region)

        // Machine fingerprint for User-Agent
        this._fingerprint = getMachineFingerprint()

        // Load credentials from file if specified
        if (this._credsFile) {
            this._loadCredentialsFromFile(this._credsFile)
        }
    }

    /**
     * Check if path is a URL
     */
    private _isUrl(path: string): boolean {
        return path.startsWith("http://") || path.startsWith("https://")
    }

    /**
     * Load credentials from JSON file or remote URL
     */
    private _loadCredentialsFromFile(filePath: string): void {
        try {
            let data: any

            if (this._isUrl(filePath)) {
                // Fetch from remote URL (synchronous for constructor)
                // Note: In production, consider async initialization
                consola.info(`Loading credentials from URL: ${filePath}`)
                const response = Bun.spawnSync(["curl", "-s", filePath])
                if (response.exitCode === 0) {
                    data = JSON.parse(response.stdout.toString())
                } else {
                    consola.warn(`Failed to fetch credentials from URL: ${filePath}`)
                    return
                }
            } else {
                // Load from local file
                if (!existsSync(filePath)) {
                    consola.warn(`Credentials file not found: ${filePath}`)
                    return
                }
                const content = readFileSync(filePath, "utf-8")
                data = JSON.parse(content)
                consola.info(`Credentials loaded from file: ${filePath}`)
            }

            if (data.refreshToken) this._refreshToken = data.refreshToken
            if (data.accessToken) this._accessToken = data.accessToken
            if (data.profileArn) this._profileArn = data.profileArn
            if (data.region) {
                this._region = data.region
                this._refreshUrl = getKiroRefreshUrl(this._region)
                this._apiHost = getKiroApiHost(this._region)
                this._qHost = getKiroQHost(this._region)
            }

            // Parse expiresAt
            if (data.expiresAt) {
                try {
                    this._expiresAt = new Date(data.expiresAt)
                } catch (e) {
                    consola.warn(`Failed to parse expiresAt: ${e}`)
                }
            }
        } catch (e) {
            consola.error(`Error loading credentials: ${e}`)
        }
    }

    /**
     * Save updated credentials to JSON file
     */
    private _saveCredentialsToFile(): void {
        if (!this._credsFile || this._isUrl(this._credsFile)) return

        try {
            let existingData: any = {}
            if (existsSync(this._credsFile)) {
                existingData = JSON.parse(readFileSync(this._credsFile, "utf-8"))
            }

            existingData.accessToken = this._accessToken
            existingData.refreshToken = this._refreshToken
            if (this._expiresAt) {
                existingData.expiresAt = this._expiresAt.toISOString()
            }
            if (this._profileArn) {
                existingData.profileArn = this._profileArn
            }

            writeFileSync(this._credsFile, JSON.stringify(existingData, null, 2))
            consola.debug(`Credentials saved to ${this._credsFile}`)
        } catch (e) {
            consola.error(`Error saving credentials: ${e}`)
        }
    }

    /**
     * Check if token is expiring soon
     */
    isTokenExpiringSoon(): boolean {
        if (!this._expiresAt) return true

        const now = Date.now()
        const threshold = now + config.tokenRefreshThreshold * 1000

        return this._expiresAt.getTime() <= threshold
    }

    /**
     * Execute token refresh request with exponential backoff retry
     */
    private async _refreshTokenRequest(): Promise<void> {
        if (!this._refreshToken) {
            throw new TokenRefreshError("Refresh token is not set")
        }

        consola.info("Refreshing Kiro token...")

        const payload = { refreshToken: this._refreshToken }
        const headers = {
            "Content-Type": "application/json",
            "User-Agent": `KiroGateway-${this._fingerprint.slice(0, 16)}`,
        }

        const maxRetries = 3
        const baseDelay = 1000 // 1 second
        let lastError: Error | null = null

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const response = await fetch(this._refreshUrl, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(payload),
                })

                if (!response.ok) {
                    const status = response.status
                    if ([429, 500, 502, 503, 504].includes(status)) {
                        // Retryable error
                        const delay = baseDelay * Math.pow(2, attempt)
                        consola.warn(`Token refresh failed (attempt ${attempt + 1}/${maxRetries}): HTTP ${status}, retrying in ${delay}ms`)
                        await sleep(delay)
                        continue
                    }
                    throw new TokenRefreshError(`HTTP ${status}: ${await response.text()}`)
                }

                const data = await response.json() as any

                const newAccessToken = data.accessToken
                const newRefreshToken = data.refreshToken
                const expiresIn = data.expiresIn || 3600
                const newProfileArn = data.profileArn

                if (!newAccessToken) {
                    throw new TokenRefreshError(`Response does not contain accessToken`)
                }

                // Update data
                this._accessToken = newAccessToken
                if (newRefreshToken) this._refreshToken = newRefreshToken
                if (newProfileArn) this._profileArn = newProfileArn

                // Calculate expiration time with buffer (minus 60 seconds)
                this._expiresAt = new Date(Date.now() + (expiresIn - 60) * 1000)

                consola.info(`Token refreshed, expires: ${this._expiresAt.toISOString()}`)

                // Save to file
                this._saveCredentialsToFile()
                return

            } catch (e) {
                lastError = e as Error
                if (e instanceof TokenRefreshError) throw e

                const delay = baseDelay * Math.pow(2, attempt)
                consola.warn(`Token refresh failed (attempt ${attempt + 1}/${maxRetries}): ${e}, retrying in ${delay}ms`)
                await sleep(delay)
            }
        }

        consola.error(`Token refresh failed after ${maxRetries} attempts`)
        throw lastError || new TokenRefreshError("All retry attempts failed")
    }

    /**
     * Get valid access token, refreshing if necessary
     * Thread-safe using promise-based lock
     */
    async getAccessToken(): Promise<string> {
        // If refresh is already in progress, wait for it
        if (this._refreshLock) {
            await this._refreshLock
        }

        if (!this._accessToken || this.isTokenExpiringSoon()) {
            // Start refresh and store the promise
            this._refreshLock = this._refreshTokenRequest().finally(() => {
                this._refreshLock = null
            })
            await this._refreshLock
        }

        if (!this._accessToken) {
            throw new TokenRefreshError("Failed to obtain access token")
        }

        return this._accessToken
    }

    /**
     * Force token refresh (used when receiving 403 from API)
     */
    async forceRefresh(): Promise<string> {
        if (this._refreshLock) {
            await this._refreshLock
        }

        this._refreshLock = this._refreshTokenRequest().finally(() => {
            this._refreshLock = null
        })
        await this._refreshLock

        return this._accessToken!
    }

    // Getters
    get profileArn(): string {
        return this._profileArn
    }

    get region(): string {
        return this._region
    }

    get apiHost(): string {
        return this._apiHost
    }

    get qHost(): string {
        return this._qHost
    }

    get fingerprint(): string {
        return this._fingerprint
    }

    get hasCredentials(): boolean {
        return !!this._refreshToken
    }
}

