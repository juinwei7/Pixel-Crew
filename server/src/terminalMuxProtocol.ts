/** Increment whenever the web server and the long-lived terminal mux change
 * their wire protocol incompatibly. The mux intentionally survives an
 * ordinary server restart, so a plain liveness ping is not enough after an
 * application update. */
export const TERMINAL_MUX_PROTOCOL_VERSION = 2;
