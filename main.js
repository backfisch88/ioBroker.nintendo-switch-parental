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
const MAX_EXTRA_STEP = 60; // Nintendo accepts at most 60 minutes per request
const RESTORE_JITTER_MS = 5 * 60 * 1000;
const RESTORE_RETRY_MS = 15 * 60 * 1000;
const RESTORE_ATTEMPTS = 3;
const UI_LANGUAGES = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];

/** @param {string} value - External identifier */
const safeId = value => String(value).replace(/[^A-Za-z0-9_-]/g, '_');

/**
 * State definitions below devices.<id>. `get` reads the value from the snapshot.
 */
const DEVICE_STATES = [
	{ id: 'name', name: 'Console name', type: 'string', role: 'text', get: s => s.name },
	{ id: 'model', name: 'Console model', type: 'string', role: 'text', get: s => s.model },
	{ id: 'firmware', name: 'Firmware version', type: 'string', role: 'text', get: s => s.firmware },
	{ id: 'lastSync', name: 'Last settings sync of the console', type: 'number', role: 'date', get: s => s.lastSync },
	{ id: 'lastUpdate', name: 'Last update from Nintendo', type: 'number', role: 'date', get: s => s.updatedAt },
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
		role: 'level',
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
		role: 'level',
		unit: 'min',
		min: -1,
		max: 360,
		def: 0,
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
	{
		id: 'saveTemplate',
		name: 'Save the current play time rules as template',
		type: 'boolean',
		role: 'button',
		read: false,
		write: true,
		get: () => false,
	},
	{
		id: 'pauseToday',
		name: 'Pause today: set the play time limit to 0 until midnight',
		type: 'boolean',
		role: 'button',
		read: false,
		write: true,
		get: () => false,
	},
	{
		id: 'resumeToday',
		name: 'End the pause and restore the previous limit',
		type: 'boolean',
		role: 'button',
		read: false,
		write: true,
		get: () => false,
	},
	{
		id: 'restoreTemplate',
		name: 'Write the saved template back to the console',
		type: 'boolean',
		role: 'button',
		read: false,
		write: true,
		get: () => false,
	},
];

/** States that hold values set by the user or the adapter itself, so polling must not overwrite them. */
const STORED_STATES = [
	{
		id: 'template',
		name: 'Saved play time rules (template)',
		type: 'string',
		role: 'json',
		write: true,
		initial: '',
	},
	{
		id: 'pausedLimit',
		name: 'Limit before the pause (empty = not paused)',
		type: 'string',
		role: 'json',
		write: false,
		initial: '',
	},
	{
		id: 'restoreDaily',
		name: 'Restore the template every night shortly after midnight',
		type: 'boolean',
		role: 'switch',
		write: true,
		def: false,
		initial: false,
	},
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
		this.restoreTimer = undefined;
		this.retryTimer = undefined;
		this.retryResolve = undefined;
		this.deviceListLoaded = false;
		this.storedReady = new Set();
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
		/** safe device id -> last valid template (JSON) */
		this.templates = new Map();
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
		this.scheduleDailyRestore();
		// not awaited: a retry after a failed catch-up can take a while
		this.catchUpNightly().catch(() => undefined);
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
	 * Schedule the nightly template restore for shortly after the next local midnight.
	 * The random delay keeps many installations from calling Nintendo at the same second.
	 */
	scheduleDailyRestore() {
		if (this.unloaded || this.pollingStopped) {
			return;
		}
		const delay = L.msUntilMidnight(this.timezone) + 1000 + Math.floor(Math.random() * RESTORE_JITTER_MS);
		this.restoreTimer = this.setTimeout(async () => {
			this.restoreTimer = undefined;
			// on days with a clock change the timer can fire an hour early, then just wait again
			if (L.zonedNow(this.timezone).hour < 12) {
				await this.runDailyRestore(null, 1);
			}
			this.scheduleDailyRestore();
		}, delay);
	}

	/**
	 * Make up for a midnight that passed while the adapter was not running: end old pauses and,
	 * if the nightly run was missed, restore the templates.
	 */
	async catchUpNightly() {
		if (this.unloaded || this.pollingStopped) {
			return;
		}
		try {
			await this.ensureObject('info.lastNightlyRun', {
				type: 'state',
				common: {
					name: 'Date of the last nightly run',
					type: 'string',
					role: 'text',
					read: true,
					write: false,
					def: '',
				},
				native: {},
			});
			const today = L.zonedNow(this.timezone).date;
			const last = await this.getStateAsync('info.lastNightlyRun');
			const lastDate = last && typeof last.val === 'string' ? last.val : '';
			if (lastDate && lastDate < today) {
				this.log.info(`Nightly run of ${lastDate} was missed, catching up`);
				await this.runDailyRestore(null, 1);
			} else {
				// old pauses must end even when there is nothing else to catch up
				await this.runDailyRestore(null, RESTORE_ATTEMPTS, true);
				if (!lastDate) {
					await this.setState('info.lastNightlyRun', { val: today, ack: true });
				}
			}
		} catch (err) {
			this.log.warn(`Catching up the nightly run failed: ${err instanceof Error ? err.message : err}`);
		}
	}

	/**
	 * Restore the template on all consoles that have the nightly restore switched on.
	 * Without a known console list (the first poll failed) the list is loaded first.
	 *
	 * @param {string[] | null} only - Safe device IDs to retry, null for all
	 * @param {number} attempt - Attempt number
	 * @param {boolean} [pausesOnly] - Only end old pauses, leave the template alone
	 */
	async runDailyRestore(only, attempt, pausesOnly = false) {
		if (!this.deviceListLoaded && !this.unloaded) {
			await this.runExclusive(() => this.pollAll());
		}
		const failed = [];
		const retryAll = !this.deviceListLoaded;
		for (const [dev, deviceId] of this.deviceMap) {
			if (this.unloaded || this.pollingStopped) {
				return;
			}
			if (only && !only.includes(dev)) {
				continue;
			}
			try {
				const enabled = await this.getStateAsync(`devices.${dev}.restoreDaily`);
				await this.runExclusive(async () => {
					const resumed = await this.resumePause(deviceId, dev, false);
					const restored =
						!pausesOnly && enabled && enabled.val === true
							? await this.restoreTemplate(deviceId, dev)
							: false;
					if (resumed || restored) {
						await this.refreshDevice(deviceId);
					}
				});
			} catch (err) {
				failed.push(dev);
				this.handleError(err, `Nightly restore of ${dev} failed`);
			}
		}
		if ((failed.length > 0 || retryAll) && attempt < RESTORE_ATTEMPTS && !this.unloaded && !this.pollingStopped) {
			await new Promise(resolve => {
				this.retryResolve = resolve;
				this.retryTimer = this.setTimeout(() => {
					this.retryTimer = undefined;
					this.retryResolve = undefined;
					resolve(undefined);
				}, RESTORE_RETRY_MS);
			});
			if (!this.unloaded) {
				await this.runDailyRestore(retryAll ? null : failed, attempt + 1, pausesOnly);
			}
			return;
		}
		// a night that still failed after the last attempt is not marked as done, the next start catches it up
		if (!pausesOnly && failed.length === 0 && !retryAll && !this.unloaded && !this.pollingStopped) {
			await this.setState('info.lastNightlyRun', { val: L.zonedNow(this.timezone).date, ack: true });
		}
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
		this.setState('info.connection', false, true).catch(() => undefined);
	}

	async pollAll() {
		if (this.unloaded || !this.api) {
			return;
		}
		try {
			const owned = await this.requireApi().fetchOwnedDevices();
			this.deviceListLoaded = true;
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
		snapshot.updatedAt = Date.now();
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
		if (obj.type === 'state') {
			// bring older installations up to date, a name changed by the user stays untouched
			const common = Object.fromEntries(Object.entries(obj.common || {}).filter(([key]) => key !== 'name'));
			await this.extendObjectAsync(id, { common });
		}
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
	 * Create a state whose value is owned by the user or the adapter and set it once if it has no value yet.
	 *
	 * @param {string} dev - Safe device ID
	 * @param {string} id - State ID
	 * @param {any} def - State definition
	 */
	async ensureStoredState(dev, id, def) {
		await this.ensureObject(id, {
			type: 'state',
			common: {
				name: def.name,
				type: def.type,
				role: def.role,
				read: true,
				write: def.write !== false,
				...(def.def !== undefined ? { def: def.def } : {}),
			},
			native: {},
		});
		if (this.storedReady.has(id)) {
			return;
		}
		const current = await this.getStateAsync(id);
		if (!current || current.val === null || current.val === undefined) {
			await this.setState(id, { val: def.initial, ack: true });
		} else if (def.id === 'template' && this.parseTemplate(current.val)) {
			this.templates.set(dev, String(current.val));
		}
		this.storedReady.add(id);
	}

	/**
	 * @param {string} dev - Safe device ID
	 * @returns {Promise<{date: string, weekday: number, setting: any} | null>} Stored pause, if any
	 */
	async readPause(dev) {
		const state = await this.getStateAsync(`devices.${dev}.pausedLimit`);
		if (!state || typeof state.val !== 'string' || !state.val) {
			return null;
		}
		try {
			const pause = JSON.parse(state.val);
			return pause && typeof pause.date === 'string' && Number.isInteger(pause.weekday) && pause.setting
				? pause
				: null;
		} catch {
			return null;
		}
	}

	/**
	 * Block play for the rest of the day by setting today's limit to 0. The previous setting is kept
	 * so that the pause ends at midnight or with resumeToday.
	 *
	 * @param {string} deviceId - Nintendo device ID
	 * @param {string} dev - Safe device ID
	 */
	async pauseToday(deviceId, dev) {
		const api = this.requireApi();
		const now = L.zonedNow(this.timezone);
		const res = await api.fetchParentalControlSetting(deviceId);
		if (L.currentExtraTime(res, now)) {
			throw new Error('Not possible while extra play time is active, cancel it first');
		}
		const regs = (res.parentalControlSetting || {}).playTimerRegulations;
		if (!(await this.readPause(dev))) {
			const backup = { date: now.date, weekday: now.weekday, setting: L.todayLimitSetting(regs, now) };
			await this.setState(`devices.${dev}.pausedLimit`, { val: JSON.stringify(backup), ack: true });
		}
		try {
			await api.updatePlayTimer(deviceId, L.withLimit(regs, now, 0));
		} catch (err) {
			if (!(await this.readPause(dev)) || (await this.readPause(dev))?.date === now.date) {
				await this.setState(`devices.${dev}.pausedLimit`, { val: '', ack: true });
			}
			throw err;
		}
		this.log.info(`Play paused on ${dev} until midnight`);
	}

	/**
	 * Restore the limit that was active before the pause.
	 *
	 * @param {string} deviceId - Nintendo device ID
	 * @param {string} dev - Safe device ID
	 * @param {boolean} force - End the pause even if it was started today
	 * @returns {Promise<boolean>} True if a pause was ended
	 */
	async resumePause(deviceId, dev, force) {
		const pause = await this.readPause(dev);
		const now = L.zonedNow(this.timezone);
		if (!pause || (!force && pause.date === now.date)) {
			return false;
		}
		const api = this.requireApi();
		const res = await api.fetchParentalControlSetting(deviceId);
		if (L.currentExtraTime(res, now)) {
			throw new Error('Not possible while extra play time is active, cancel it first');
		}
		const regs = (res.parentalControlSetting || {}).playTimerRegulations;
		await api.updatePlayTimer(deviceId, L.withLimitSetting(regs, pause.weekday, pause.setting));
		await this.setState(`devices.${dev}.pausedLimit`, { val: '', ack: true });
		this.log.info(`Pause on ${dev} ended, previous limit restored`);
		return true;
	}

	/**
	 * Write the saved template back to the console if the console differs from it.
	 *
	 * @param {string} deviceId - Nintendo device ID
	 * @param {string} dev - Safe device ID
	 * @returns {Promise<boolean>} True if the console was changed
	 */
	async restoreTemplate(deviceId, dev) {
		const state = await this.getStateAsync(`devices.${dev}.template`);
		const template = this.parseTemplate(state && state.val);
		if (!template) {
			this.log.warn(`No valid template stored for ${dev}, press saveTemplate first`);
			return false;
		}
		const api = this.requireApi();
		const res = await api.fetchParentalControlSetting(deviceId);
		if (L.currentExtraTime(res, L.zonedNow(this.timezone))) {
			throw new Error('Not possible while extra play time is active, cancel it first');
		}
		if (L.sameTemplate((res.parentalControlSetting || {}).playTimerRegulations, template)) {
			this.log.debug(`Play time rules of ${dev} already match the template`);
			return false;
		}
		await api.updatePlayTimer(deviceId, template);
		this.log.info(`Play time rules of ${dev} restored from the template`);
		return true;
	}

	/**
	 * @param {unknown} value - State value
	 * @returns {any} The template, or null if the value is not a usable template
	 */
	parseTemplate(value) {
		if (typeof value !== 'string' || !value) {
			return null;
		}
		try {
			const parsed = JSON.parse(value);
			return L.isTemplate(parsed) ? parsed : null;
		} catch {
			return null;
		}
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
		await Promise.all(STORED_STATES.map(def => this.ensureStoredState(dev, `${base}.${def.id}`, def)));

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
				if (minutes === 0) {
					return;
				}
				if (!Number.isInteger(minutes) || (minutes !== -1 && (minutes < 1 || minutes > 360))) {
					throw new Error('Extra time must be -1 (unlimited) or 1-360 minutes');
				}
				// Nintendo accepts at most 60 minutes per request, so longer grants are sent in steps
				const steps = [];
				for (let left = minutes; left > 0; left -= MAX_EXTRA_STEP) {
					steps.push(Math.min(left, MAX_EXTRA_STEP));
				}
				if (minutes === -1) {
					steps.push(-1);
				}
				let added = 0;
				for (const step of steps) {
					try {
						const response = await api.updateExtraPlayingTime(deviceId, { minutes: step });
						// Nintendo asks for confirmation when the extra time would run into bedtime
						if (response && response.nextStepDetail) {
							await api.confirmExtraPlayingTime(deviceId, step, true);
						}
						await this.waitForExtraTime(deviceId, now);
					} catch (err) {
						if (added > 0) {
							throw new Error(
								`Only ${added} of ${minutes} minutes were added: ${err instanceof Error ? err.message : err}`,
							);
						}
						throw err;
					}
					added += step;
				}
				return;
			}
			case 'saveTemplate': {
				if (value) {
					const { pcs } = await read();
					const template = L.extractTemplate(pcs.playTimerRegulations);
					if (!L.isTemplate(template)) {
						throw new Error('The console returned no complete play time rules to save');
					}
					const json = JSON.stringify(template);
					this.templates.set(safeDevice, json);
					await this.setState(`devices.${safeDevice}.template`, { val: json, ack: true });
					this.log.info(`Play time rules of ${safeDevice} saved as template`);
				}
				return;
			}
			case 'pauseToday':
				if (value) {
					await this.pauseToday(deviceId, safeDevice);
				}
				return;
			case 'resumeToday':
				if (value) {
					await this.resumePause(deviceId, safeDevice, true);
				}
				return;
			case 'restoreTemplate':
				if (value) {
					await this.restoreTemplate(deviceId, safeDevice);
				}
				return;
			case 'restoreDaily':
				await this.setState(`devices.${safeDevice}.restoreDaily`, { val: Boolean(value), ack: true });
				return;
			case 'template': {
				if (this.parseTemplate(value)) {
					this.templates.set(safeDevice, String(value));
					await this.setState(`devices.${safeDevice}.template`, { val: String(value), ack: true });
				} else {
					this.log.warn(`Ignoring ${safeDevice}.template: not a complete set of play time rules`);
					await this.setState(`devices.${safeDevice}.template`, {
						val: this.templates.get(safeDevice) || '',
						ack: true,
					});
				}
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
	 * Text for the admin UI in the system language, taken from admin/i18n (English as fallback).
	 *
	 * @param {string} key - Translation key
	 * @returns {Promise<string>} Text
	 */
	async uiText(key) {
		let language = 'en';
		try {
			const config = await this.getForeignObjectAsync('system.config');
			const configured = config && config.common && config.common.language;
			if (typeof configured === 'string' && UI_LANGUAGES.includes(configured)) {
				language = configured;
			}
		} catch {
			// keep English
		}
		const load = lang => {
			try {
				return require(`./admin/i18n/${lang}.json`);
			} catch {
				return {};
			}
		};
		return load(language)[key] || load('en')[key] || key;
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
					result: `${await this.uiText('loginHint')}\n${session.loginUrl}`,
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
					result: await this.uiText('loginDone'),
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
			if (this.restoreTimer) {
				this.clearTimeout(this.restoreTimer);
				this.restoreTimer = undefined;
			}
			if (this.retryTimer) {
				this.clearTimeout(this.retryTimer);
				this.retryTimer = undefined;
			}
			if (this.retryResolve) {
				this.retryResolve(undefined);
				this.retryResolve = undefined;
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
