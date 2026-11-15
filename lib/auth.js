'use strict';

const crypto = require('node:crypto');
const C = require('./const');

/**
 * Authentication error, `fatal` means a new login is required.
 */
class AuthError extends Error {
	/**
	 * @param {string} message - Error message
	 * @param {boolean} fatal - True when the session token is unusable and a new login is required
	 */
	constructor(message, fatal) {
		super(message);
		this.name = 'AuthError';
		this.fatal = fatal;
	}
}

/**
 * Create a PKCE login session.
 *
 * @returns {{loginUrl: string, state: string, verifier: string}} Login URL plus values needed to finish the login
 */
function createLoginSession() {
	const state = crypto.randomBytes(36).toString('base64url');
	const verifier = crypto.randomBytes(32).toString('base64url');
	const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
	const params = new URLSearchParams({
		state,
		redirect_uri: C.REDIRECT_URI,
		client_id: C.CLIENT_ID,
		scope: C.SCOPES,
		response_type: 'session_token_code',
		session_token_code_challenge: challenge,
		session_token_code_challenge_method: 'S256',
		theme: 'login_form',
	});
	return { loginUrl: `${C.AUTHORIZE_URL}?${params.toString()}`, state, verifier };
}

/**
 * Extract session_token_code (and state) from the copied redirect link `npf...://auth#session_token_code=...`.
 *
 * @param {string} link - Redirect link copied from the browser
 * @returns {{code: string, state: string | undefined}} Parsed values
 */
function parseRedirectLink(link) {
	const text = String(link || '').trim();
	if (!text) {
		throw new Error('Redirect link is empty');
	}
	const hash = text.indexOf('#');
	const query = text.indexOf('?');
	let params;
	if (hash >= 0) {
		params = text.slice(hash + 1);
	} else if (query >= 0) {
		params = text.slice(query + 1);
	} else if (text.includes('session_token_code=')) {
		params = text;
	} else {
		throw new Error('Redirect link contains no session_token_code');
	}
	const parsed = new URLSearchParams(params);
	if (parsed.has('error')) {
		throw new Error(parsed.get('error_description') || parsed.get('error') || 'Nintendo login error');
	}
	const code = parsed.get('session_token_code');
	if (!code) {
		throw new Error('Redirect link contains no session_token_code');
	}
	return { code, state: parsed.get('state') || undefined };
}

/**
 * Holds the session token and keeps a valid id token.
 */
class NintendoAuth {
	/**
	 * @param {string} sessionToken - Long-lived Nintendo session token (may be empty before login)
	 * @param {typeof fetch} [fetchImpl] - fetch implementation (injectable for tests)
	 */
	constructor(sessionToken, fetchImpl) {
		this.sessionToken = sessionToken || '';
		this.fetch = fetchImpl || fetch;
		this.idToken = '';
		this.expiresAt = 0;
	}

	/**
	 * Exchange the code from the redirect link for a session token.
	 *
	 * @param {string} link - Redirect link copied from the browser
	 * @param {{state: string, verifier: string}} session - Session from createLoginSession
	 * @returns {Promise<string>} Session token
	 */
	async completeLogin(link, session) {
		const { code, state } = parseRedirectLink(link);
		if (state && state !== session.state) {
			throw new Error('Redirect link does not belong to the current login attempt, create a new login link');
		}
		const response = await this.fetch(C.SESSION_TOKEN_URL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				Accept: 'application/json',
				'User-Agent': 'NASDKAPI; Android',
			},
			body: new URLSearchParams({
				client_id: C.CLIENT_ID,
				session_token_code: code,
				session_token_code_verifier: session.verifier,
			}).toString(),
			signal: AbortSignal.timeout(C.REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) {
			throw new Error(`Nintendo rejected the login (HTTP ${response.status}), create a new login link`);
		}
		const data = JSON.parse(await response.text());
		if (!data.session_token) {
			throw new Error('Nintendo did not return a session token');
		}
		this.sessionToken = data.session_token;
		return this.sessionToken;
	}

	/**
	 * Return the Authorization header value, refreshing the id token when needed.
	 *
	 * @param {boolean} [force] - Force a refresh
	 * @returns {Promise<string>} Header value
	 */
	async getAuthorization(force = false) {
		if (!this.sessionToken) {
			throw new AuthError('No session token configured', true);
		}
		if (!force && this.idToken && Date.now() < this.expiresAt - C.TOKEN_EXPIRY_BUFFER_MS) {
			return `Bearer ${this.idToken}`;
		}
		const response = await this.fetch(C.TOKEN_URL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
				'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 8.0.0)',
			},
			body: JSON.stringify({
				client_id: C.CLIENT_ID,
				session_token: this.sessionToken,
				grant_type: C.GRANT_TYPE,
			}),
			signal: AbortSignal.timeout(C.REQUEST_TIMEOUT_MS),
		});
		if (response.status === 400 || response.status === 401) {
			throw new AuthError(`Session token rejected by Nintendo (HTTP ${response.status})`, true);
		}
		if (!response.ok) {
			throw new AuthError(`Token refresh failed (HTTP ${response.status})`, false);
		}
		const data = JSON.parse(await response.text());
		if (!data.id_token) {
			throw new AuthError('Nintendo did not return an id token', false);
		}
		this.idToken = data.id_token;
		this.expiresAt = Date.now() + (Number(data.expires_in) || 900) * 1000;
		return `Bearer ${this.idToken}`;
	}
}

module.exports = { NintendoAuth, AuthError, createLoginSession, parseRedirectLink };
