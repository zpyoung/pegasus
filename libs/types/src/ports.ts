/**
 * Centralized port configuration for Pegasus
 *
 * These ports are reserved for the Pegasus application and should never be
 * killed or terminated by AI agents during feature implementation.
 */

/** Port for the static/UI server (Vite dev server) */
export const STATIC_PORT = 3007;

/** Port for the backend API server (Express + WebSocket) */
export const SERVER_PORT = 3008;

/** Array of all reserved Pegasus ports */
export const RESERVED_PORTS = [STATIC_PORT, SERVER_PORT] as const;
