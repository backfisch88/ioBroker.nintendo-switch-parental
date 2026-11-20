'use strict';

const { DAYS_OF_WEEK, MAX_DAILY_PLAYTIME } = require('./const');

/**
 * Current civil time in a timezone.
 *
 * @param {string} timezone - IANA timezone
 * @param {Date} [date] - Point in time
 * @returns {{date: string, hour: number, minute: number, second: number, weekday: number}} weekday: 0 = Monday
 */
function zonedNow(timezone, date = new Date()) {
	const parts = {};
	for (const p of new Intl.DateTimeFormat('en-GB', {
		timeZone: timezone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23',
		weekday: 'short',
	}).formatToParts(date)) {
		parts[p.type] = p.value;
	}
	const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday);
	return {
		date: `${parts.year}-${parts.month}-${parts.day}`,
		hour: Number(parts.hour),
		minute: Number(parts.minute),
		second: Number(parts.second),
		weekday,
	};
}

/**
 * @param {string} timezone - IANA timezone name
 * @returns {boolean} True if the runtime knows the timezone
 */
function isValidTimezone(timezone) {
	try {
		new Intl.DateTimeFormat('en-GB', { timeZone: timezone });
		return typeof timezone === 'string' && timezone.length > 0;
	} catch {
		return false;
	}
}

/**
 * @param {{hour: number, minute: number} | null | undefined} t - API time object
 * @returns {string} HH:MM, or 00:00 when missing (= disabled)
 */
function apiTimeToString(t) {
	if (!t) {
		return '00:00';
	}
	return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
}

/**
 * @param {string} value - HH:MM
 * @returns {{hour: number, minute: number}} API time object
 */
function parseTimeString(value) {
	const match = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
	if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
		throw new Error(`Invalid time "${value}", expected HH:MM`);
	}
	return { hour: Number(match[1]), minute: Number(match[2]) };
}

const isMidnight = t => t.hour === 0 && t.minute === 0;
const toMinutes = t => t.hour * 60 + t.minute;

/**
 * @param {object} pcs - parentalControlSetting
 * @param {{weekday: number}} now - Current zoned time
 * @returns {any} Regulation object of today
 */
function todayRegulation(pcs, now) {
	const regs = pcs.playTimerRegulations || {};
	if (regs.timerMode === 'EACH_DAY_OF_THE_WEEK') {
		return (regs.eachDayOfTheWeekRegulations || {})[DAYS_OF_WEEK[now.weekday]] || {};
	}
	return regs.dailyRegulations || {};
}

/**
 * Remaining play minutes from play limit and bedtime.
 *
 * @param {object} p - Inputs
 * @param {{hour: number, minute: number}} p.now - Current zoned time
 * @param {number} p.limit - Daily limit in minutes, -1 = none
 * @param {number | null} p.extra - Extra time in minutes, -1 = unlimited, null = none
 * @param {{hour: number, minute: number} | null} p.bedtimeAlarm - Bedtime alarm time (null = disabled)
 * @param {boolean} p.alarmsEnabled - Alarm visibility enabled
 * @param {number} p.played - Minutes played today
 * @returns {number} Minutes
 */
function remainingMinutes({ now, limit, extra, bedtimeAlarm, alarmsEnabled, played }) {
	const nowMin = now.hour * 60 + now.minute;
	const endOfDay = 1440 - nowMin;
	let byLimit = endOfDay;
	if (limit !== -1 && extra !== -1) {
		byLimit = limit + (extra || 0) - played;
	}
	let byBedtime = endOfDay;
	if (bedtimeAlarm && !isMidnight(bedtimeAlarm) && alarmsEnabled) {
		let alarm = toMinutes(bedtimeAlarm);
		if (alarm <= nowMin && bedtimeAlarm.hour < 6 && now.hour >= 6) {
			alarm += 1440;
		}
		byBedtime = Math.max(0, alarm - nowMin);
	}
	return Math.max(0, Math.floor(Math.min(byLimit, byBedtime)));
}

/**
 * Parse extra playing time from the owned-device block.
 *
 * @param {any} ownedDevice - ownedDevice object of the PCS response
 * @param {boolean} bedtimeEnabled - Whether bedtime is enabled today
 * @param {{hour: number, minute: number} | null} alarm - Configured bedtime alarm
 * @returns {{extra: number | null, alarm: {hour: number, minute: number} | null}} Extra minutes and (possibly extended) alarm
 */
function parseExtraTime(ownedDevice, bedtimeEnabled, alarm) {
	const data = ownedDevice && ownedDevice.device && ownedDevice.device.extraPlayingTime;
	if (!data) {
		return { extra: null, alarm };
	}
	if (bedtimeEnabled && data.bedtime) {
		const end = data.bedtime.endTime;
		if (end && alarm) {
			return { extra: (toMinutes(end) - toMinutes(alarm) + 1440) % 1440, alarm: end };
		}
		return { extra: null, alarm };
	}
	const inOneDay = data.inOneDay;
	if (inOneDay && inOneDay.isInfinity) {
		return { extra: -1, alarm };
	}
	if (inOneDay) {
		return { extra: typeof inOneDay.duration === 'number' ? inOneDay.duration : null, alarm };
	}
	return { extra: null, alarm };
}

/**
 * Build the snapshot published to ioBroker for one device.
 *
 * @param {object} input - Raw API data
 * @param {any} input.owned - Entry of fetchOwnedDevices
 * @param {any} input.pcsResponse - fetchParentalControlSetting response
 * @param {any} input.daily - fetchDailySummaries response
 * @param {{date: string, hour: number, minute: number, weekday: number}} input.now - Current zoned time
 * @returns {object} Snapshot
 */
function buildSnapshot({ owned, pcsResponse, daily, now }) {
	const pcs = pcsResponse.parentalControlSetting || {};
	const regs = pcs.playTimerRegulations || {};
	const today = todayRegulation(pcs, now);
	const device = (pcsResponse.ownedDevice && pcsResponse.ownedDevice.device) || (owned && owned.device) || {};

	const limitRaw =
		today.timeToPlayInOneDay && today.timeToPlayInOneDay.enabled ? today.timeToPlayInOneDay.limitTime : null;
	const limit = typeof limitRaw === 'number' ? limitRaw : -1;

	const bedtime = today.bedtime || {};
	const bedtimeEnabled = Boolean(bedtime.enabled);
	let alarm = bedtimeEnabled && bedtime.endingTime ? bedtime.endingTime : null;
	const bedtimeEnd = bedtimeEnabled && bedtime.startingTime ? apiTimeToString(bedtime.startingTime) : '00:00';
	const extraInfo = parseExtraTime(pcsResponse.ownedDevice, bedtimeEnabled, alarm);
	alarm = extraInfo.alarm;

	const summaries = Array.isArray(daily && daily.dailySummaries) ? daily.dailySummaries : [];
	const first = summaries[0];
	const isToday = Boolean(first && first.date === now.date);
	const played = isToday ? Number(first.playingTime) || 0 : 0;

	const alarmsEnabled =
		((device.alarmSetting && device.alarmSetting.visibility) ||
			(owned && owned.device && owned.device.alarmSetting && owned.device.alarmSetting.visibility)) === 'VISIBLE';

	const monthPrefix = now.date.slice(0, 7);
	let monthPlayed = 0;
	for (const s of summaries) {
		if (typeof s.date === 'string' && s.date.startsWith(monthPrefix)) {
			monthPlayed += Number(s.playingTime) || 0;
		}
	}

	// players: union of all profiles seen in the summaries, today's playing time for the current day only
	const players = new Map();
	for (const s of summaries) {
		for (const p of s.players || []) {
			const profile = p.profile || {};
			if (profile.playerId && !players.has(profile.playerId)) {
				players.set(profile.playerId, {
					id: profile.playerId,
					nickname: profile.nickname || '',
					image: profile.imageUri || '',
					playingTime: 0,
				});
			}
		}
	}
	const appToday = new Map();
	if (isToday) {
		for (const p of first.players || []) {
			const entry = players.get((p.profile || {}).playerId);
			if (entry) {
				entry.playingTime = Number(p.playingTime) || 0;
			}
			for (const g of p.playedGames || []) {
				const id = g.meta && g.meta.applicationId;
				if (id) {
					appToday.set(id, (appToday.get(id) || 0) + (Number(g.playingTime) || 0));
				}
			}
		}
	}

	const apps = (pcs.whitelistedApplicationList || []).map(a => ({
		id: a.applicationId,
		name: a.title || a.applicationId,
		image: a.imageUri || '',
		allowed: a.safeLaunch === 'ALLOW',
		playingTime: appToday.get(a.applicationId) || 0,
	}));

	const generation = device.platformGeneration;
	const model = generation === 'P00' ? 'Switch' : generation === 'P01' ? 'Switch 2' : 'Unknown';
	const sync = device.synchronizedParentalControlSetting && device.synchronizedParentalControlSetting.synchronizedAt;

	return {
		id: (owned && owned.deviceId) || pcs.deviceId,
		name: (owned && owned.label) || '',
		model,
		firmware: (device.firmwareVersion && device.firmwareVersion.displayedVersion) || '',
		lastSync: typeof sync === 'number' ? sync * 1000 : 0,
		timerMode: regs.timerMode || 'DAILY',
		forcedTermination: regs.restrictionMode === 'FORCED_TERMINATION',
		restrictionLevel: pcs.functionalRestrictionLevel || 'NONE',
		limit,
		extra: extraInfo.extra,
		bedtimeAlarm: alarm ? apiTimeToString(alarm) : '00:00',
		bedtimeEnd,
		alarmsEnabled,
		playedToday: played,
		remaining: remainingMinutes({ now, limit, extra: extraInfo.extra, bedtimeAlarm: alarm, alarmsEnabled, played }),
		playedMonth: monthPlayed,
		players: [...players.values()],
		apps,
	};
}

/**
 * Extra playing time currently active for today (-1 = unlimited, null = none).
 *
 * @param {any} pcsResponse - fetchParentalControlSetting response
 * @param {{weekday: number}} now - Current zoned time
 * @returns {number | null} Extra minutes
 */
function currentExtraTime(pcsResponse, now) {
	const today = todayRegulation(pcsResponse.parentalControlSetting || {}, now);
	const bedtime = today.bedtime || {};
	const enabled = Boolean(bedtime.enabled);
	return parseExtraTime(pcsResponse.ownedDevice, enabled, enabled ? bedtime.endingTime || null : null).extra;
}

/**
 * @param {any} regs - playTimerRegulations
 * @returns {any} Deep copy
 */
const clone = regs => JSON.parse(JSON.stringify(regs));

/**
 * Select today's regulation inside a (cloned) playTimerRegulations object.
 *
 * @param {any} regs - playTimerRegulations
 * @param {{weekday: number}} now - Current zoned time
 * @returns {any} Regulation of today (created when missing)
 */
function regulationOf(regs, now) {
	if (regs.timerMode === 'EACH_DAY_OF_THE_WEEK') {
		regs.eachDayOfTheWeekRegulations = regs.eachDayOfTheWeekRegulations || {};
		const day = DAYS_OF_WEEK[now.weekday];
		regs.eachDayOfTheWeekRegulations[day] = regs.eachDayOfTheWeekRegulations[day] || {};
		return regs.eachDayOfTheWeekRegulations[day];
	}
	regs.dailyRegulations = regs.dailyRegulations || {};
	return regs.dailyRegulations;
}

/**
 * @param {any} regs - playTimerRegulations
 * @param {{weekday: number}} now - Current zoned time
 * @param {number} minutes - -1 = no limit, 0..360
 * @returns {any} New playTimerRegulations
 */
function withLimit(regs, now, minutes) {
	if (!Number.isInteger(minutes) || minutes < -1 || minutes > MAX_DAILY_PLAYTIME) {
		throw new Error(`Play time limit must be an integer between -1 and ${MAX_DAILY_PLAYTIME}`);
	}
	const out = clone(regs);
	const reg = regulationOf(out, now);
	reg.timeToPlayInOneDay = reg.timeToPlayInOneDay || {};
	if (minutes === -1) {
		reg.timeToPlayInOneDay.enabled = false;
		delete reg.timeToPlayInOneDay.limitTime;
	} else {
		reg.timeToPlayInOneDay.enabled = true;
		reg.timeToPlayInOneDay.limitTime = minutes;
	}
	return out;
}

/**
 * Bedtime alarm = time from which the console is locked (16:00-23:59), 00:00 disables bedtime.
 *
 * @param {any} regs - playTimerRegulations
 * @param {{weekday: number}} now - Current zoned time
 * @param {string} value - HH:MM
 * @returns {any} New playTimerRegulations
 */
function withBedtimeAlarm(regs, now, value) {
	const t = parseTimeString(value);
	if (!isMidnight(t) && (t.hour < 16 || t.hour > 23)) {
		throw new Error('Bedtime alarm must be between 16:00 and 23:59, or 00:00 to disable');
	}
	const out = clone(regs);
	const reg = regulationOf(out, now);
	const enabled = !isMidnight(t);
	reg.bedtime = { ...(reg.bedtime || {}), enabled, endingTime: enabled ? t : null };
	if (!reg.bedtime.startingTime) {
		reg.bedtime.startingTime = { hour: 6, minute: 0 };
	}
	return out;
}

/**
 * Bedtime end = time when the lock ends in the morning (05:00-09:00), 00:00 disables bedtime.
 *
 * @param {any} regs - playTimerRegulations
 * @param {{weekday: number}} now - Current zoned time
 * @param {string} value - HH:MM
 * @returns {any} New playTimerRegulations
 */
function withBedtimeEnd(regs, now, value) {
	const t = parseTimeString(value);
	if (!isMidnight(t) && (toMinutes(t) < 300 || toMinutes(t) > 540)) {
		throw new Error('Bedtime end must be between 05:00 and 09:00, or 00:00 to disable');
	}
	const out = clone(regs);
	const reg = regulationOf(out, now);
	const enabled = !isMidnight(t);
	const previous = (reg.bedtime && reg.bedtime.startingTime) || { hour: 6, minute: 0 };
	reg.bedtime = { ...(reg.bedtime || {}), enabled, startingTime: enabled ? t : previous };
	return out;
}

/**
 * @param {any} regs - playTimerRegulations
 * @param {boolean} forced - true = suspend software at limit, false = alarm only
 * @returns {any} New playTimerRegulations
 */
function withRestrictionMode(regs, forced) {
	const out = clone(regs);
	out.restrictionMode = forced ? 'FORCED_TERMINATION' : 'ALARM';
	return out;
}

/**
 * @param {any} regs - playTimerRegulations
 * @param {string} mode - DAILY or EACH_DAY_OF_THE_WEEK
 * @returns {any} New playTimerRegulations
 */
function withTimerMode(regs, mode) {
	if (mode !== 'DAILY' && mode !== 'EACH_DAY_OF_THE_WEEK') {
		throw new Error(`Invalid timer mode "${mode}"`);
	}
	const out = clone(regs);
	out.timerMode = mode;
	return out;
}

const TEMPLATE_KEYS = ['timerMode', 'restrictionMode', 'dailyRegulations', 'eachDayOfTheWeekRegulations'];

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The part of playTimerRegulations that makes up the saved schedule.
 *
 * @param {any} regs - playTimerRegulations
 * @returns {any} Template
 */
function extractTemplate(regs) {
	const out = {};
	for (const key of TEMPLATE_KEYS) {
		if (regs && regs[key] !== undefined) {
			out[key] = JSON.parse(JSON.stringify(regs[key]));
		}
	}
	return out;
}

/**
 * @param {any} value - Parsed template
 * @returns {boolean} True if the value can be written back as play timer rules
 */
function isTemplate(value) {
	if (!isObject(value)) {
		return false;
	}
	const t = value;
	if (t.timerMode !== 'DAILY' && t.timerMode !== 'EACH_DAY_OF_THE_WEEK') {
		return false;
	}
	if (t.restrictionMode !== 'ALARM' && t.restrictionMode !== 'FORCED_TERMINATION') {
		return false;
	}
	const needed = t.timerMode === 'DAILY' ? 'dailyRegulations' : 'eachDayOfTheWeekRegulations';
	return (
		isObject(t[needed]) &&
		(t.dailyRegulations === undefined || isObject(t.dailyRegulations)) &&
		(t.eachDayOfTheWeekRegulations === undefined || isObject(t.eachDayOfTheWeekRegulations))
	);
}

/**
 * @param {any} value - Any JSON value
 * @returns {string} JSON with sorted keys
 */
function stableStringify(value) {
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(',')}]`;
	}
	if (isObject(value)) {
		const obj = value;
		return `{${Object.keys(obj)
			.sort()
			.filter(k => obj[k] !== undefined)
			.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
			.join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
}

/**
 * @param {any} regs - playTimerRegulations of the console
 * @param {any} template - Saved template
 * @returns {boolean} True if the console already uses the template
 */
function sameTemplate(regs, template) {
	return stableStringify(extractTemplate(regs)) === stableStringify(extractTemplate(template));
}

/**
 * @param {string} timezone - IANA timezone
 * @param {Date} [date] - Point in time
 * @returns {number} Milliseconds until the next local midnight (approximate on days with a clock change)
 */
function msUntilMidnight(timezone, date = new Date()) {
	const now = zonedNow(timezone, date);
	const seconds = (23 - now.hour) * 3600 + (59 - now.minute) * 60 + (60 - now.second);
	return seconds * 1000;
}

/**
 * @param {any} regs - playTimerRegulations
 * @param {{weekday: number}} now - Current zoned time
 * @returns {any} Copy of today's timeToPlayInOneDay setting
 */
function todayLimitSetting(regs, now) {
	const reg = regulationOf(clone(regs), now);
	return clone(reg.timeToPlayInOneDay || { enabled: false });
}

/**
 * @param {any} regs - playTimerRegulations
 * @param {number} weekday - 0 = Monday
 * @param {any} setting - timeToPlayInOneDay setting to write
 * @returns {any} New playTimerRegulations
 */
function withLimitSetting(regs, weekday, setting) {
	const out = clone(regs);
	regulationOf(out, { weekday }).timeToPlayInOneDay = clone(setting);
	return out;
}

/**
 * @param {any} pcs - parentalControlSetting
 * @param {string} applicationId - Application ID
 * @param {boolean} allowed - Allow list state
 * @returns {any} New parentalControlSetting
 */
function withAppAllowed(pcs, applicationId, allowed) {
	const out = clone(pcs);
	const app = (out.whitelistedApplicationList || []).find(
		a => a.applicationId.toUpperCase() === applicationId.toUpperCase(),
	);
	if (!app) {
		throw new Error(`Application ${applicationId} is not in the parental control list`);
	}
	app.safeLaunch = allowed ? 'ALLOW' : 'NONE';
	return out;
}

/**
 * List the timestamps found in a cloud object (paths and ISO times, no other data). Only used for debug logging.
 *
 * @param {unknown} value - Object to search
 * @param {string} [path] - Path of value
 * @param {string[]} [out] - Collected entries
 * @returns {string[]} Entries like "device.synchronizedParentalControlSetting.synchronizedAt=2026-11-16T08:02:45.000Z"
 */
function timeFields(value, path = '', out = []) {
	if (typeof value === 'number') {
		const ms = value > 1e9 && value < 4e9 ? value * 1000 : value > 1e12 && value < 4e12 ? value : 0;
		if (ms) {
			out.push(`${path}=${new Date(ms).toISOString()}`);
		}
	} else if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value)) {
		out.push(`${path}=${value}`);
	} else if (value && typeof value === 'object' && out.length < 50) {
		for (const [key, child] of Object.entries(value)) {
			timeFields(child, path ? `${path}.${key}` : key, out);
		}
	}
	return out;
}

module.exports = {
	zonedNow,
	timeFields,
	isValidTimezone,
	apiTimeToString,
	parseTimeString,
	todayRegulation,
	remainingMinutes,
	parseExtraTime,
	currentExtraTime,
	buildSnapshot,
	withLimit,
	withBedtimeAlarm,
	withBedtimeEnd,
	withRestrictionMode,
	withTimerMode,
	withAppAllowed,
	extractTemplate,
	isTemplate,
	sameTemplate,
	msUntilMidnight,
	todayLimitSetting,
	withLimitSetting,
};
