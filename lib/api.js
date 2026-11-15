'use strict';

const C = require('./const');
const { AuthError } = require('./auth');

/**
 * Error for failed Nintendo API requests.
 */
class ApiError extends Error {
	/**
	 * @param {string} message - Error message
	 * @param {number} status - HTTP status
	 */
	constructor(message, status) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
	}
}

const EXTRA_ERRORS = new Set(['NO_EFFECT', 'OVERTIME_ERROR', 'DURING_LATE_NIGHT_ERROR', 'FAILED']);

/**
 * Client for the Nintendo Parental Controls cloud API.
 */
class MoonApi {
	/**
	 * @param {import('./auth').NintendoAuth} auth - Authentication handler
	 * @param {string} timezone - IANA timezone sent as X-Moon-TimeZone
	 * @param {string} language - Language tag, e.g. de-DE
	 * @param {typeof fetch} [fetchImpl] - fetch implementation (injectable for tests)
	 */
	constructor(auth, timezone, language, fetchImpl) {
		this.auth = auth;
		this.timezone = timezone;
		this.language = language;
		this.fetch = fetchImpl || fetch;
	}

	/**
	 * @param {string} authorization - Authorization header value
	 * @returns {Record<string, string>} Request headers
	 */
	headers(authorization) {
		return {
			'User-Agent': C.USER_AGENT,
			'X-Moon-App-Id': C.APP_PKG,
			'X-Moon-Os': C.OS_NAME,
			'X-Moon-Os-Version': C.OS_VERSION,
			'X-Moon-Model': C.DEVICE_MODEL,
			'X-Moon-App-Display-Version': C.APP_VERSION,
			'X-Moon-App-Internal-Version': C.APP_BUILD,
			'X-Moon-TimeZone': this.timezone,
			'X-Moon-Os-Language': this.language,
			'X-Moon-App-Language': this.language,
			'Content-Type': 'application/json',
			Accept: 'application/json',
			Authorization: authorization,
		};
	}

	/**
	 * @param {'GET' | 'POST'} method - HTTP method
	 * @param {string} path - Path below the base URL
	 * @param {object} [body] - JSON body
	 * @returns {Promise<any>} Parsed JSON (empty object when the body is empty)
	 */
	async request(method, path, body) {
		let authorization = await this.auth.getAuthorization();
		for (let attempt = 0; attempt < 2; attempt++) {
			const response = await this.fetch(`${C.BASE_URL}${path}`, {
				method,
				headers: this.headers(authorization),
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(C.REQUEST_TIMEOUT_MS),
			});
			if (response.status === 401 && attempt === 0) {
				authorization = await this.auth.getAuthorization(true);
				continue;
			}
			if (response.status === 401 || response.status === 403) {
				throw new AuthError(`Nintendo denied access (HTTP ${response.status})`, response.status === 401);
			}
			if (!response.ok) {
				let detail = '';
				try {
					const err = JSON.parse(await response.text());
					detail = err.detail || err.errorCode || '';
				} catch {
					// ignore unparsable error bodies
				}
				throw new ApiError(
					`HTTP ${response.status}${detail ? `: ${detail}` : ''} (${path.split('?')[0]})`,
					response.status,
				);
			}
			try {
				return JSON.parse(await response.text());
			} catch {
				return {};
			}
		}
		throw new ApiError('Request failed', 0);
	}

	/**
	 * List all consoles of the account.
	 *
	 * @returns {Promise<any>} Response body
	 */
	fetchOwnedDevices() {
		return this.request('GET', '/v2/actions/user/fetchOwnedDevices');
	}

	/**
	 * Fetch the daily play summaries of a console.
	 *
	 * @param {string} deviceId - Device ID
	 * @returns {Promise<any>} Response body
	 */
	fetchDailySummaries(deviceId) {
		return this.request(
			'GET',
			`/v2/actions/playSummary/fetchDailySummaries?deviceId=${encodeURIComponent(deviceId)}`,
		);
	}

	/**
	 * Fetch the current parental control setting of a console.
	 *
	 * @param {string} deviceId - Device ID
	 * @returns {Promise<any>} Response body
	 */
	fetchParentalControlSetting(deviceId) {
		return this.request(
			'GET',
			`/v2/actions/parentalControlSetting/fetchParentalControlSetting?deviceId=${encodeURIComponent(deviceId)}`,
		);
	}

	/**
	 * @param {string} deviceId - Device ID
	 * @param {object} regulations - playTimerRegulations object
	 */
	updatePlayTimer(deviceId, regulations) {
		const keys = ['timerMode', 'restrictionMode', 'dailyRegulations', 'eachDayOfTheWeekRegulations'];
		const playTimerRegulations = {};
		for (const key of keys) {
			playTimerRegulations[key] = regulations[key];
		}
		return this.request('POST', '/v3/actions/parentalControlSetting/updatePlayTimer', {
			deviceId,
			playTimerRegulations,
		});
	}

	/**
	 * @param {string} deviceId - Device ID
	 * @param {object} setting - parentalControlSetting object
	 */
	updateRestrictionLevel(deviceId, setting) {
		const custom = setting.customSettings || {};
		return this.request('POST', '/v2/actions/parentalControlSetting/updateRestrictionLevel', {
			deviceId,
			customSettings: custom,
			parentalControlSettingEtag: setting.etag,
			vrRestrictionEtag: custom.vrRestrictionEtag,
			whitelistedApplicationList: setting.whitelistedApplicationList,
			functionalRestrictionLevel: setting.functionalRestrictionLevel,
		});
	}

	/**
	 * Add, make unlimited (-1) or cancel extra playing time of today.
	 * Nintendo answers HTTP 200 even when it rejects the request, so the status field is checked.
	 *
	 * @param {string} deviceId - Device ID
	 * @param {{minutes?: number, cancel?: boolean}} opts - Options
	 * @returns {Promise<any>} Response body
	 */
	async updateExtraPlayingTime(deviceId, opts) {
		const body = { deviceId };
		if (opts.cancel) {
			body.status = 'TO_CANCELED';
		} else if (opts.minutes === -1) {
			body.status = 'TO_INFINITY';
		} else {
			body.additionalTime = opts.minutes;
			body.status = 'TO_ADDED';
		}
		const response = await this.request('POST', '/v2/actions/device/updateExtraPlayingTime', body);
		checkExtraStatus(response);
		return response;
	}

	/**
	 * @param {string} deviceId - Device ID
	 * @param {number} minutes - Minutes
	 * @param {boolean} withBedtime - Push bedtime back as well
	 */
	async confirmExtraPlayingTime(deviceId, minutes, withBedtime) {
		const response = await this.request('POST', '/v2/actions/device/confirmExtraPlayingTime', {
			deviceId,
			additionalTime: minutes,
			withBedtime,
		});
		checkExtraStatus(response);
		return response;
	}
}

/**
 * @param {any} response - Response of an extra-playing-time endpoint
 */
function checkExtraStatus(response) {
	const status = response && response.status;
	if (typeof status === 'string' && EXTRA_ERRORS.has(status)) {
		throw new ApiError(`Nintendo rejected the extra time request: ${status}`, 200);
	}
}

module.exports = { MoonApi, ApiError, checkExtraStatus };
