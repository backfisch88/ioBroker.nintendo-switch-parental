'use strict';

const CLIENT_ID = '54789befb391a838';
const REDIRECT_URI = 'npf54789befb391a838://auth';
const SCOPES = [
	'openid',
	'user',
	'moonUser:administration',
	'moonDevice:create',
	'moonOwnedDevice:administration',
	'moonParentalControlSetting',
	'moonParentalControlSetting:update',
	'moonParentalControlSettingState',
	'moonPairingState',
	'moonSmartDevice:administration',
	'moonDailySummary',
	'moonMonthlySummary',
].join(' ');

const AUTHORIZE_URL = 'https://accounts.nintendo.com/connect/1.0.0/authorize';
const SESSION_TOKEN_URL = 'https://accounts.nintendo.com/connect/1.0.0/api/session_token';
const TOKEN_URL = 'https://accounts.nintendo.com/connect/1.0.0/api/token';
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer-session-token';

const BASE_URL = 'https://app.lp1.znma.srv.nintendo.net';
const APP_PKG = 'com.nintendo.znma';
const APP_VERSION = '2.6.0';
const APP_BUILD = '700';
const OS_NAME = 'ANDROID';
const OS_VERSION = '34';
const DEVICE_MODEL = 'Pixel 4 XL';
const USER_AGENT = `moon_ANDROID/${APP_VERSION} (${APP_PKG}; build:${APP_BUILD}; ${OS_NAME} ${OS_VERSION})`;

const REQUEST_TIMEOUT_MS = 30000;
/** Refresh the id token this long before it expires */
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

const DAYS_OF_WEEK = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

const RESTRICTION_LEVELS = {
	NONE: 'None',
	CHILDREN: 'Young child',
	YOUNG_TEENS: 'Child',
	OLDER_TEENS: 'Teen',
	CUSTOM: 'Custom',
};

const MAX_DAILY_PLAYTIME = 360;

module.exports = {
	CLIENT_ID,
	REDIRECT_URI,
	SCOPES,
	AUTHORIZE_URL,
	SESSION_TOKEN_URL,
	TOKEN_URL,
	GRANT_TYPE,
	BASE_URL,
	APP_PKG,
	APP_VERSION,
	APP_BUILD,
	OS_NAME,
	OS_VERSION,
	DEVICE_MODEL,
	USER_AGENT,
	REQUEST_TIMEOUT_MS,
	TOKEN_EXPIRY_BUFFER_MS,
	DAYS_OF_WEEK,
	RESTRICTION_LEVELS,
	MAX_DAILY_PLAYTIME,
};
