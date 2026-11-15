'use strict';

/*
 * Created with @iobroker/create-adapter v3.1.5
 */

const utils = require('@iobroker/adapter-core');
const { NintendoAuth, AuthError, createLoginSession } = require('./lib/auth');
const { MoonApi } = require('./lib/api');
const L = require('./lib/logic');
const { RESTRICTION_LEVELS } = require('./lib/const');

const MIN_POLL_SECONDS = 60;
const MAX_POLL_SECONDS = 3600;
const DEFAULT_POLL_SECONDS = 300;
const DEFAULT_TIMEZONE = 'Europe/Berlin';
const DEFAULT_LANGUAGE = 'de-DE';
const EXTRA_TIME_SYNC_ATTEMPTS = 3;
const EXTRA_TIME_SYNC_DELAY_MS = 2000;
const LOGIN_SESSION_MS = 15 * 60 * 1000;

/** @param {string} value - External identifier */
const safeId = value => String(value).replace(/[^A-Za-z0-9_-]/g, '_');

/**
 * State definitions below devices.<id>. `get` reads the value from the snapshot.
 */
const DEVICE_STATES = [
	{ id: 'name', name: 'Console name', type: 'string', role: 'text', get: s => s.name },
	{ id: 'model', name: 'Console model', type: 'string', role: 'text', get: s => s.model },
	{ id: 'firmware', name: 'Firmware version', type: 'string', role: 'text', get: s => s.firmware },
	{ id: 'lastSync', name: 'Last sync with Nintendo', type: 'number', role: 'date', get: s => s.lastSync },
	{
		id: 'playTimeToday',
		name: 'Play time today',
		type: 'number',
		role: 'value',
		unit: 'min',
		get: s => s.playedToday,
	},
	{
		id: 'timeRemaining',
		name: 'Remaining play time today',
		type: 'number',
		role: 'value',
		unit: 'min',
		get: s => s.remaining,
	},
	{
		id: 'playTimeMonth',
		name: 'Play time this month',
		type: 'number',
		role: 'value',
		unit: 'min',
		get: s => s.playedMonth,
	},
	{
		id: 'limit',
		name: 'Daily play time limit (-1 = no limit)',
		type: 'number',
		role: 'value',
		unit: 'min',
		min: -1,
		max: 360,
		write: true,
		get: s => s.limit,
	},
	{
		id: 'extraTime',
		name: 'Extra play time today (-1 = unlimited)',
		type: 'number',
		role: 'value',
		unit: 'min',
		get: s => (s.extra === null ? 0 : s.extra),
	},
	{
		id: 'addExtraTime',
		name: 'Add extra play time today in minutes (-1 = unlimited)',
		type: 'number',
		role: 'value',
		unit: 'min',
		min: -1,
		def: 0,
		read: false,
		write: true,
		get: () => 0,
	},
	{
		id: 'cancelExtraTime',
		name: 'Cancel extra play time today',
		type: 'boolean',
		role: 'button',
		read: false,
		write: true,
		get: () => false,
	},
	{
		id: 'bedtimeAlarm',
		name: 'Bedtime start HH:MM (16:00-23:59, 00:00 = off)',
		type: 'string',
		role: 'text',
		write: true,
		get: s => s.bedtimeAlarm,
	},
	{
		id: 'bedtimeEnd',
		name: 'Bedtime end HH:MM (05:00-09:00, 00:00 = off)',
		type: 'string',
		role: 'text',
		write: true,
		get: s => s.bedtimeEnd,
	},
	{
		id: 'suspendSoftware',
		name: 'Suspend software when time is up',
		type: 'boolean',
		role: 'switch',
		write: true,
		get: s => s.forcedTermination,
	},
	{
		id: 'timerMode',
		name: 'Timer mode',
		type: 'string',
		role: 'text',
		write: true,
		states: { DAILY: 'Same limit every day', EACH_DAY_OF_THE_WEEK: 'Limit per weekday' },
		get: s => s.timerMode,
	},
	{
		id: 'restrictionLevel',
		name: 'Restriction level',
		type: 'string',
		role: 'text',
		write: true,
		states: RESTRICTION_LEVELS,
		get: s => s.restrictionLevel,
	},
	{ id: 'alarmsEnabled', name: 'Alarms enabled', type: 'boolean', role: 'indicator', get: s => s.alarmsEnabled },
];

class NintendoSwitchParental extends utils.Adapter {
	/**
	 * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
	 */
	constructor(options) {
		super({
			...options,
			name: 'nintendo-switch-parental',
		});
		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		this.on('message', this.onMessage.bind(this));
		this.on('unload', this.onUnload.bind(this));

		this.auth = null;
		this.api = null;
		this.timezone = DEFAULT_TIMEZONE;
		this.pollSeconds = DEFAULT_POLL_SECONDS;
		this.pollTimer = undefined;
		this.unloaded = false;
		this.pollingStopped = false;
		this.queue = Promise.resolve(undefined);
		this.loginSession = null;
		this.loginSessionCreated = 0;
		this.knownObjects = new Set();
		/** safe id -> Nintendo device id */
		this.deviceMap = new Map();
		/** "<safe device>.<safe app>" -> Nintendo application id */
		this.appMap = new Map();
	}

	async onReady() {
		await this.setState('info.connection', false, true);

		this.pollSeconds = Number(this.config.pollInterval);
		if (
			!Number.isFinite(this.pollSeconds) ||
			this.pollSeconds < MIN_POLL_SECONDS ||
			this.pollSeconds > MAX_POLL_SECONDS
		) {
			this.pollSeconds = Math.min(
				MAX_POLL_SECONDS,
				Math.max(MIN_POLL_SECONDS, Number.isFinite(this.pollSeconds) ? this.pollSeconds : DEFAULT_POLL_SECONDS),
			);
			this.log.warn(`Poll interval out of range, using ${this.pollSeconds} seconds`);
		}
		this.timezone = L.isValidTimezone(this.config.timezone) ? this.config.timezone : DEFAULT_TIMEZONE;
		if (this.timezone !== this.config.timezone) {
			this.log.warn(`Invalid timezone "${this.config.timezone}", using ${DEFAULT_TIMEZONE}`);
		}
		const language = /^[a-z]{2}-[A-Z]{2}$/.test(this.config.language) ? this.config.language : DEFAULT_LANGUAGE;

		if (!this.config.sessionToken) {
			this.log.warn(
				'No session token configured. Open the instance settings and use "Create login link" to sign in with your Nintendo Account',
			);
			return;
		}

		this.auth = new NintendoAuth(this.config.sessionToken);
		this.api = new MoonApi(this.auth, this.timezone, language);
		await this.subscribeStatesAsync('devices.*');
		await this.runExclusive(() => this.pollAll());
		this.scheduleNextPoll();
	}

	/**
	 * @returns {MoonApi} The API client
	 */
	requireApi() {
		if (!this.api) {
			throw new Error('Not signed in');
		}
		return this.api;
	}

	/**
	 * Serialize cloud access so that polling and commands never overlap.
	 *
	 * @template T
	 * @param {() => Promise<T>} fn - Work to run
	 * @returns {Promise<T>} Result of fn
	 */
	runExclusive(fn) {
		const run = this.queue.then(fn);
		this.queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	scheduleNextPoll() {
		if (this.unloaded || this.pollingStopped) {
			return;
		}
		this.pollTimer = this.setTimeout(async () => {
			this.pollTimer = undefined;
			await this.runExclusive(() => this.pollAll());
			this.scheduleNextPoll();
		}, this.pollSeconds * 1000);
	}

	/**
	 * @param {unknown} err - Error
	 * @param {string} context - What failed
	 */
	handleError(err, context) {
		const message = err instanceof Error ? err.message : String(err);
		if (err instanceof AuthError && err.fatal) {
			this.log.error(`${context}: ${message}. Please sign in again via the instance settings`);
			this.pollingStopped = true;
		} else {
			this.log.warn(`${context}: ${message}`);
		}
		this.setState('info.connection', false, true);
	}

	async pollAll() {
		if (this.unloaded || !this.api) {
			return;
		}
		try {
			const owned = await this.requireApi().fetchOwnedDevices();
			const list = Array.isArray(owned.ownedDevices) ? owned.ownedDevices : [];
			let failed = 0;
			for (const entry of list) {
				try {
					await this.refreshDevice(entry.deviceId, entry);
				} catch (err) {
					if (err instanceof AuthError && err.fatal) {
						throw err;
					}
					failed++;
					this.log.warn(
						`Could not update device ${entry.deviceId}: ${err instanceof Error ? err.message : err}`,
					);
				}
			}
			if (list.length === 0) {
				this.log.info('No consoles with Parental Controls found for this Nintendo Account');
			}
			await this.setState('info.connection', failed < list.length || list.length === 0, true);
		} catch (err) {
			this.handleError(err, 'Update failed');
		}
	}

	/**
	 * Fetch and publish one device.
	 *
	 * @param {string} deviceId - Nintendo device ID
	 * @param {any} [entry] - Entry of fetchOwnedDevices
	 */
	async refreshDevice(deviceId, entry) {
		const [pcsResponse, daily] = await Promise.all([
			this.requireApi().fetchParentalControlSetting(deviceId),
			this.requireApi().fetchDailySummaries(deviceId),
		]);
		const snapshot = L.buildSnapshot({
			owned: pcsResponse.ownedDevice || entry || { deviceId },
			pcsResponse,
			daily,
			now: L.zonedNow(this.timezone),
		});
		snapshot.id = deviceId;
		await this.publishDevice(snapshot);
	}

	/**
	 * @param {string} id - Object ID without namespace
	 * @param {ioBroker.SettableObject} obj - Object definition
	 */
	async ensureObject(id, obj) {
		if (this.knownObjects.has(id)) {
			return;
		}
		await this.setObjectNotExistsAsync(id, obj);
		this.knownObjects.add(id);
	}

	/**
	 * @param {string} id - Object ID
	 * @param {'folder' | 'device' | 'channel'} type - Structural object type
	 * @param {string} name - Display name
	 */
	ensureStructure(id, type, name) {
		return this.ensureObject(id, { type, common: { name }, native: {} });
	}

	/**
	 * @param {string} id - State ID
	 * @param {any} def - State definition
	 * @param {any} value - Value
	 */
	async publishState(id, def, value) {
		await this.ensureObject(id, {
			type: 'state',
			common: {
				name: def.name,
				type: def.type,
				role: def.role,
				read: def.read !== false,
				write: def.write === true,
				...(def.unit ? { unit: def.unit } : {}),
				...(def.min !== undefined ? { min: def.min } : {}),
				...(def.max !== undefined ? { max: def.max } : {}),
				...(def.def !== undefined ? { def: def.def } : {}),
				...(def.states ? { states: def.states } : {}),
			},
			native: {},
		});
		await this.setState(id, { val: value, ack: true });
	}

	/**
	 * @param {any} snap - Snapshot from buildSnapshot
	 */
	async publishDevice(snap) {
		const dev = safeId(snap.id);
		this.deviceMap.set(dev, snap.id);
		const base = `devices.${dev}`;
		await this.ensureStructure('devices', 'folder', 'Consoles');
		await this.ensureStructure(base, 'device', snap.name || snap.id);
		await Promise.all(DEVICE_STATES.map(def => this.publishState(`${base}.${def.id}`, def, def.get(snap))));

		if (snap.players.length > 0) {
			await this.ensureStructure(`${base}.players`, 'folder', 'Players');
		}
		for (const player of snap.players) {
			const pid = `${base}.players.${safeId(player.id)}`;
			await this.ensureStructure(pid, 'channel', player.nickname || player.id);
			await Promise.all([
				this.publishState(
					`${pid}.nickname`,
					{ name: 'Nickname', type: 'string', role: 'text' },
					player.nickname,
				),
				this.publishState(
					`${pid}.image`,
					{ name: 'Profile image', type: 'string', role: 'text.url' },
					player.image,
				),
				this.publishState(
					`${pid}.playTimeToday`,
					{ name: 'Play time today', type: 'number', role: 'value', unit: 'min' },
					player.playingTime,
				),
			]);
		}

		if (this.config.createApplicationStates && snap.apps.length > 0) {
			await this.ensureStructure(`${base}.apps`, 'folder', 'Games');
			for (const app of snap.apps) {
				const safeApp = safeId(app.id);
				this.appMap.set(`${dev}.${safeApp}`, app.id);
				const aid = `${base}.apps.${safeApp}`;
				await this.ensureStructure(aid, 'channel', app.name);
				await Promise.all([
					this.publishState(`${aid}.name`, { name: 'Title', type: 'string', role: 'text' }, app.name),
					this.publishState(
						`${aid}.allowed`,
						{
							name: 'On allow list (ignores age restrictions)',
							type: 'boolean',
							role: 'switch',
							write: true,
						},
						app.allowed,
					),
					this.publishState(
						`${aid}.playTimeToday`,
						{ name: 'Play time today', type: 'number', role: 'value', unit: 'min' },
						app.playingTime,
					),
				]);
			}
		}
	}

	/**
	 * @param {string} id - State ID
	 * @param {ioBroker.State | null | undefined} state - State
	 */
	onStateChange(id, state) {
		if (!state || state.ack || this.unloaded) {
			return;
		}
		const parts = id.slice(this.namespace.length + 1).split('.');
		if (parts[0] !== 'devices' || parts.length < 3) {
			return;
		}
		const deviceId = this.deviceMap.get(parts[1]);
		if (!deviceId || !this.api) {
			return;
		}
		if (this.pollingStopped) {
			this.log.warn('Ignoring command, sign in again via the instance settings');
			return;
		}
		const key = parts.slice(2);
		this.runExclusive(async () => {
			try {
				await this.executeCommand(deviceId, parts[1], key, state.val);
			} catch (err) {
				this.log.warn(`Command ${key.join('.')} failed: ${err instanceof Error ? err.message : err}`);
			}
			try {
				await this.refreshDevice(deviceId);
			} catch (err) {
				this.handleError(err, 'Update after command failed');
			}
		}).catch(err => this.log.error(`Unexpected error: ${err instanceof Error ? err.message : err}`));
	}

	/**
	 * @param {string} deviceId - Nintendo device ID
	 * @param {string} safeDevice - Sanitized device ID
	 * @param {string[]} key - State path below the device
	 * @param {ioBroker.StateValue} value - Written value
	 */
	async executeCommand(deviceId, safeDevice, key, value) {
		const api = this.requireApi();
		const now = L.zonedNow(this.timezone);
		const read = async () => {
			const res = await api.fetchParentalControlSetting(deviceId);
			return { res, pcs: res.parentalControlSetting || {} };
		};
		const guardExtra = res => {
			if (L.currentExtraTime(res, now)) {
				throw new Error('Not possible while extra play time is active, cancel it first');
			}
		};

		const name = key.join('.');
		if (key[0] === 'apps' && key[2] === 'allowed') {
			const appId = this.appMap.get(`${safeDevice}.${key[1]}`);
			if (!appId) {
				throw new Error('Unknown game');
			}
			const { pcs } = await read();
			await api.updateRestrictionLevel(deviceId, L.withAppAllowed(pcs, appId, Boolean(value)));
			return;
		}

		switch (name) {
			case 'limit': {
				const { res, pcs } = await read();
				guardExtra(res);
				await api.updatePlayTimer(deviceId, L.withLimit(pcs.playTimerRegulations, now, Number(value)));
				return;
			}
			case 'bedtimeAlarm':
			case 'bedtimeEnd': {
				const { res, pcs } = await read();
				guardExtra(res);
				const build = name === 'bedtimeAlarm' ? L.withBedtimeAlarm : L.withBedtimeEnd;
				await api.updatePlayTimer(deviceId, build(pcs.playTimerRegulations, now, String(value)));
				return;
			}
			case 'suspendSoftware': {
				const { res, pcs } = await read();
				guardExtra(res);
				await api.updatePlayTimer(deviceId, L.withRestrictionMode(pcs.playTimerRegulations, Boolean(value)));
				return;
			}
			case 'timerMode': {
				const { res, pcs } = await read();
				guardExtra(res);
				await api.updatePlayTimer(deviceId, L.withTimerMode(pcs.playTimerRegulations, String(value)));
				return;
			}
			case 'restrictionLevel': {
				const level = String(value);
				if (!Object.hasOwn(RESTRICTION_LEVELS, level)) {
					throw new Error(`Invalid restriction level "${level}"`);
				}
				const { pcs } = await read();
				await api.updateRestrictionLevel(deviceId, { ...pcs, functionalRestrictionLevel: level });
				return;
			}
			case 'addExtraTime': {
				const minutes = Number(value);
				if (!Number.isInteger(minutes) || (minutes !== -1 && (minutes < 1 || minutes > 360))) {
					throw new Error('Extra time must be -1 (unlimited) or 1-360 minutes');
				}
				if (minutes === 0) {
					return;
				}
				const response = await api.updateExtraPlayingTime(deviceId, { minutes });
				// Nintendo asks for confirmation when the extra time would run into bedtime
				if (response && response.nextStepDetail) {
					await api.confirmExtraPlayingTime(deviceId, minutes, true);
				}
				await this.waitForExtraTime(deviceId, now);
				return;
			}
			case 'cancelExtraTime':
				if (value) {
					await api.updateExtraPlayingTime(deviceId, { cancel: true });
					await this.waitForExtraTime(deviceId, now);
				}
				return;
			default:
				this.log.debug(`Ignoring write to read-only state ${name}`);
		}
	}

	/**
	 * Nintendo reflects extra time changes with a delay, so give the cloud a moment before re-reading.
	 *
	 * @param {string} deviceId - Nintendo device ID
	 * @param {{weekday: number}} now - Current zoned time
	 */
	async waitForExtraTime(deviceId, now) {
		const before = L.currentExtraTime(await this.requireApi().fetchParentalControlSetting(deviceId), now);
		for (let attempt = 0; attempt < EXTRA_TIME_SYNC_ATTEMPTS && !this.unloaded; attempt++) {
			await new Promise(resolve => this.setTimeout(() => resolve(undefined), EXTRA_TIME_SYNC_DELAY_MS));
			const current = L.currentExtraTime(await this.requireApi().fetchParentalControlSetting(deviceId), now);
			if (current !== before) {
				return;
			}
		}
	}

	/**
	 * Current login session, reused for a while so that the copy field and the button give the same link.
	 *
	 * @returns {{loginUrl: string, state: string, verifier: string}} Login session
	 */
	getLoginSession() {
		if (!this.loginSession || Date.now() - this.loginSessionCreated > LOGIN_SESSION_MS) {
			this.loginSession = createLoginSession();
			this.loginSessionCreated = Date.now();
		}
		return this.loginSession;
	}

	/**
	 * Text for the admin UI in the system language (German or English).
	 *
	 * @param {string} en - English text
	 * @param {string} de - German text
	 * @returns {Promise<string>} Text
	 */
	async uiText(en, de) {
		try {
			const config = await this.getForeignObjectAsync('system.config');
			return config && config.common && config.common.language === 'de' ? de : en;
		} catch {
			return en;
		}
	}

	/**
	 * @param {ioBroker.Message} obj - Message from the admin UI
	 */
	async onMessage(obj) {
		if (!obj || !obj.command) {
			return;
		}
		const reply = response => {
			if (obj.callback) {
				this.sendTo(obj.from, obj.command, response, obj.callback);
			}
		};
		try {
			if (obj.command === 'getLoginText') {
				reply(this.getLoginSession().loginUrl);
			} else if (obj.command === 'getLoginUrl') {
				const session = this.getLoginSession();
				reply({
					openUrl: session.loginUrl,
					window: '_blank',
					result: `${await this.uiText(
						'Sign in, then right-click "Select this person", copy the link and paste it below',
						'Anmelden, dann Rechtsklick auf "Diese Person auswählen", Link kopieren und unten einfügen',
					)}\n${session.loginUrl}`,
				});
			} else if (obj.command === 'completeLogin') {
				const link = obj.message && obj.message.redirectUrl;
				if (!this.loginSession) {
					throw new Error('Create a login link first');
				}
				const token = await new NintendoAuth('').completeLogin(link, this.loginSession);
				this.loginSession = null;
				await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
					native: { sessionToken: this.encrypt(token), redirectUrl: '' },
				});
				reply({
					result: await this.uiText(
						'Login successful, the instance restarts',
						'Anmeldung erfolgreich, die Instanz wird neu gestartet',
					),
					reloadBrowser: true,
				});
			}
		} catch (err) {
			reply({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	/**
	 * @param {() => void} callback - Callback function
	 */
	async onUnload(callback) {
		try {
			this.unloaded = true;
			if (this.pollTimer) {
				this.clearTimeout(this.pollTimer);
				this.pollTimer = undefined;
			}
			await this.setState('info.connection', false, true);
		} catch {
			// nothing to clean up beyond the timer
		} finally {
			callback();
		}
	}
}

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
	 */
	module.exports = options => new NintendoSwitchParental(options);
} else {
	// otherwise start the instance directly
	new NintendoSwitchParental();
}
