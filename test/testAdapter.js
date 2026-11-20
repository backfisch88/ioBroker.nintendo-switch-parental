'use strict';

const path = require('node:path');
const { EventEmitter } = require('node:events');
const { expect } = require('chai');
const L = require('../lib/logic');

/** Minimal stand-in for the ioBroker Adapter base class, backed by in-memory maps. */
class FakeAdapter extends EventEmitter {
	constructor(options) {
		super();
		this.options = options;
		this.namespace = 'nintendo-switch-parental.0';
		this.config = FakeAdapter.config;
		this.states = new Map();
		this.objects = new Map();
		this.foreign = [];
		this.sent = [];
		this.timers = [];
		this.logs = [];
		this.log = { debug: () => {}, info: m => this.logs.push(['info', m]), warn: m => this.logs.push(['warn', m]), error: m => this.logs.push(['error', m]) };
		FakeAdapter.last = this;
	}
	async setState(id, val) {
		this.states.set(id, typeof val === 'object' && val !== null && 'val' in val ? val.val : val);
	}
	async setObjectNotExistsAsync(id, obj) {
		if (!this.objects.has(id)) {
			this.objects.set(id, obj);
		}
	}
	async extendObjectAsync(id, obj) {
		const current = this.objects.get(id) || {};
		this.objects.set(id, { ...current, ...obj, common: { ...current.common, ...obj.common } });
	}
	async subscribeStatesAsync() {}
	async getStateAsync(id) {
		return this.states.has(id) ? { val: this.states.get(id), ack: true } : null;
	}
	async getForeignObjectAsync() {
		return { common: { language: 'de' } };
	}
	async extendForeignObjectAsync(id, obj) {
		this.foreign.push([id, obj]);
	}
	encrypt(v) {
		return `enc:${v}`;
	}
	sendTo(to, cmd, response) {
		this.sent.push(response);
	}
	setTimeout(cb, ms) {
		const t = ms >= 60000 ? { pending: cb } : setTimeout(cb, 1);
		this.timers.push(t);
		return t;
	}
	clearTimeout(t) {
		this.timers = this.timers.filter(x => x !== t);
		if (t && !t.pending) {
			clearTimeout(t);
		}
	}
}

const adapterCorePath = require.resolve('@iobroker/adapter-core');
const mainPath = path.join(__dirname, '..', 'main.js');

/** Fake Nintendo cloud */
function createCloud() {
	const cloud = {
		calls: [],
		extra: null,
		regs: {
			timerMode: 'DAILY',
			restrictionMode: 'ALARM',
			dailyRegulations: {
				timeToPlayInOneDay: { enabled: true, limitTime: 90 },
				bedtime: { enabled: false, startingTime: { hour: 6, minute: 0 }, endingTime: null },
			},
		},
		fail: null,
	};
	cloud.fetch = async (url, init = {}) => {
		const u = new URL(url);
		const body = init.body && u.hostname.includes('znma') ? JSON.parse(init.body) : init.body;
		cloud.calls.push({ path: u.pathname, body });
		const json = (data, status = 200) => ({ status, ok: status < 300, text: async () => JSON.stringify(data) });
		if (u.pathname.endsWith('/api/token')) {
			return json({ id_token: 'ID', expires_in: 900 });
		}
		if (cloud.fail) {
			return json({}, cloud.fail);
		}
		switch (u.pathname) {
			case '/v2/actions/user/fetchOwnedDevices':
				return json({ ownedDevices: [{ deviceId: 'D1', label: 'Kid', device: {} }] });
			case '/v2/actions/parentalControlSetting/fetchParentalControlSetting':
				return json({
					parentalControlSetting: {
						deviceId: 'D1',
						functionalRestrictionLevel: 'CHILDREN',
						playTimerRegulations: cloud.regs,
						whitelistedApplicationList: [{ applicationId: '0100AA', title: 'Game', imageUri: 'x', safeLaunch: 'NONE' }],
						etag: 'E',
					},
					ownedDevice: {
						deviceId: 'D1',
						label: 'Kid',
						device: { platformGeneration: 'P00', alarmSetting: { visibility: 'VISIBLE' }, extraPlayingTime: cloud.extra },
					},
				});
			case '/v2/actions/playSummary/fetchDailySummaries':
				return json({
					dailySummaries: [
						{
							date: L.zonedNow('Europe/Berlin').date,
							playingTime: 25,
							players: [{ profile: { playerId: 'P-1', nickname: 'Anna', imageUri: 'i' }, playingTime: 25, playedGames: [{ meta: { applicationId: '0100AA' }, playingTime: 25 }] }],
						},
					],
				});
			case '/v3/actions/parentalControlSetting/updatePlayTimer':
				cloud.regs = { ...cloud.regs, ...body.playTimerRegulations };
				return json({});
			case '/v2/actions/device/updateExtraPlayingTime':
				if (body.status === 'TO_ADDED' && body.additionalTime > 60) {
					return json({ errors: [{ message: 'additionalTime must be less than or equal to 60' }] }, 400);
				}
				if (body.status === 'TO_CANCELED') {
					cloud.extra = null;
				} else if (body.status === 'TO_INFINITY') {
					cloud.extra = { inOneDay: { duration: 0, isInfinity: true } };
				} else {
					const previous = (cloud.extra && cloud.extra.inOneDay && cloud.extra.inOneDay.duration) || 0;
					cloud.extra = { inOneDay: { duration: previous + body.additionalTime, isInfinity: false } };
				}
				return json({ status: 'SUCCESS' });
			case '/v2/actions/parentalControlSetting/updateRestrictionLevel':
				return json({});
			default:
				return json({}, 404);
		}
	};
	return cloud;
}

async function start(config, cloud) {
	FakeAdapter.config = { sessionToken: 'S', pollInterval: 300, timezone: 'Europe/Berlin', language: 'de-DE', createApplicationStates: true, ...config };
	require.cache[adapterCorePath] = { id: adapterCorePath, filename: adapterCorePath, loaded: true, exports: { Adapter: FakeAdapter } };
	delete require.cache[mainPath];
	global.fetch = cloud.fetch;
	const create = require(mainPath);
	const adapter = create({});
	await adapter.onReady();
	return adapter;
}

const idle = () => new Promise(resolve => setTimeout(resolve, 50));

describe('adapter with mocked cloud', () => {
	const realFetch = global.fetch;
	after(() => {
		global.fetch = realFetch;
		delete require.cache[adapterCorePath];
		delete require.cache[mainPath];
	});

	it('creates the object tree and publishes values', async () => {
		const cloud = createCloud();
		const a = await start({}, cloud);
		const s = a.states;
		expect(s.get('info.connection')).to.equal(true);
		expect(s.get('devices.D1.name')).to.equal('Kid');
		expect(s.get('devices.D1.model')).to.equal('Switch');
		expect(s.get('devices.D1.limit')).to.equal(90);
		expect(s.get('devices.D1.playTimeToday')).to.equal(25);
		expect(s.get('devices.D1.timeRemaining')).to.equal(65);
		expect(s.get('devices.D1.suspendSoftware')).to.equal(false);
		expect(s.get('devices.D1.players.P-1.nickname')).to.equal('Anna');
		expect(s.get('devices.D1.apps.0100AA.allowed')).to.equal(false);
		expect(a.objects.get('devices').type).to.equal('folder');
		expect(a.objects.get('devices.D1').type).to.equal('device');
		expect(a.objects.get('devices.D1.players.P-1').type).to.equal('channel');
		expect(a.objects.get('devices.D1.cancelExtraTime').common).to.include({ role: 'button', read: false, write: true });
		// nested states only below structural objects
		for (const [id] of a.objects) {
			const parent = id.split('.').slice(0, -1).join('.');
			if (parent) {
				expect(a.objects.get(parent) && a.objects.get(parent).type, id).to.not.equal('state');
			}
		}
		await a.onUnload(() => {});
	});

	it('does not create game states unless enabled', async () => {
		const a = await start({ createApplicationStates: false }, createCloud());
		expect([...a.objects.keys()].some(id => id.includes('.apps'))).to.equal(false);
		await a.onUnload(() => {});
	});

	it('writes the limit and re-reads the console', async () => {
		const cloud = createCloud();
		const a = await start({}, cloud);
		a.onStateChange('nintendo-switch-parental.0.devices.D1.limit', { val: 45, ack: false });
		await idle();
		const update = cloud.calls.find(c => c.path.endsWith('updatePlayTimer'));
		expect(update.body.deviceId).to.equal('D1');
		expect(update.body.playTimerRegulations.dailyRegulations.timeToPlayInOneDay).to.deep.equal({ enabled: true, limitTime: 45 });
		expect(a.states.get('devices.D1.limit')).to.equal(45);
		await a.onUnload(() => {});
	});

	it('ignores acknowledged values and unrelated ids', async () => {
		const cloud = createCloud();
		const a = await start({}, cloud);
		await idle(); // let the start-up catch-up finish
		const before = cloud.calls.length;
		a.onStateChange('nintendo-switch-parental.0.devices.D1.limit', { val: 10, ack: true });
		a.onStateChange('nintendo-switch-parental.0.info.connection', { val: false, ack: false });
		a.onStateChange('nintendo-switch-parental.0.devices.D1.limit', null);
		await idle();
		expect(cloud.calls.length).to.equal(before);
		await a.onUnload(() => {});
	});

	it('rejects invalid input without calling the cloud and restores the value', async () => {
		const cloud = createCloud();
		const a = await start({}, cloud);
		a.onStateChange('nintendo-switch-parental.0.devices.D1.limit', { val: 999, ack: false });
		a.onStateChange('nintendo-switch-parental.0.devices.D1.bedtimeAlarm', { val: '12:00', ack: false });
		await idle();
		expect(cloud.calls.some(c => c.path.endsWith('updatePlayTimer'))).to.equal(false);
		expect(a.states.get('devices.D1.limit')).to.equal(90);
		expect(a.logs.filter(l => l[0] === 'warn')).to.have.length(2);
		await a.onUnload(() => {});
	});

	it('adds and cancels extra time, and blocks limit changes while it is active', async () => {
		const cloud = createCloud();
		const a = await start({}, cloud);
		a.onStateChange('nintendo-switch-parental.0.devices.D1.addExtraTime', { val: 15, ack: false });
		await new Promise(resolve => setTimeout(resolve, 200));
		expect(a.states.get('devices.D1.extraTime')).to.equal(15);
		expect(a.states.get('devices.D1.timeRemaining')).to.equal(80);

		a.onStateChange('nintendo-switch-parental.0.devices.D1.limit', { val: 30, ack: false });
		await idle();
		expect(cloud.calls.some(c => c.path.endsWith('updatePlayTimer'))).to.equal(false);

		a.onStateChange('nintendo-switch-parental.0.devices.D1.cancelExtraTime', { val: true, ack: false });
		await new Promise(resolve => setTimeout(resolve, 200));
		expect(a.states.get('devices.D1.extraTime')).to.equal(0);
		await a.onUnload(() => {});
	});

	it('sends extra time above 60 minutes in steps', async () => {
		const cloud = createCloud();
		const a = await start({}, cloud);
		a.onStateChange('nintendo-switch-parental.0.devices.D1.addExtraTime', { val: 140, ack: false });
		await new Promise(resolve => setTimeout(resolve, 1500));
		const sent = cloud.calls.filter(c => c.path.endsWith('updateExtraPlayingTime')).map(c => c.body.additionalTime);
		expect(sent).to.deep.equal([60, 60, 20]);
		expect(a.states.get('devices.D1.extraTime')).to.equal(140);
		expect(a.logs.some(l => l[0] === 'warn')).to.equal(false);
		await a.onUnload(() => {});
	});

	it('ignores extra time 0 without a warning', async () => {
		const cloud = createCloud();
		const a = await start({}, cloud);
		a.onStateChange('nintendo-switch-parental.0.devices.D1.addExtraTime', { val: 0, ack: false });
		await idle();
		expect(cloud.calls.some(c => c.path.endsWith('updateExtraPlayingTime'))).to.equal(false);
		expect(a.logs.some(l => l[0] === 'warn')).to.equal(false);
		expect(a.objects.get('devices.D1.addExtraTime').common.max).to.equal(360);
		await a.onUnload(() => {});
	});

	it('updates the definition of existing states but keeps a renamed object name', async () => {
		const a = await start({}, createCloud());
		const limit = a.objects.get('devices.D1.limit');
		limit.common.max = 1;
		limit.common.name = 'My name';
		a.knownObjects.clear();
		await a.refreshDevice('D1');
		expect(a.objects.get('devices.D1.limit').common.max).to.equal(360);
		expect(a.objects.get('devices.D1.limit').common.name).to.equal('My name');
		await a.onUnload(() => {});
	});

	it('toggles the allow list of a game', async () => {
		const cloud = createCloud();
		const a = await start({}, cloud);
		a.onStateChange('nintendo-switch-parental.0.devices.D1.apps.0100AA.allowed', { val: true, ack: false });
		await idle();
		const update = cloud.calls.find(c => c.path.endsWith('updateRestrictionLevel'));
		expect(update.body.whitelistedApplicationList[0].safeLaunch).to.equal('ALLOW');
		await a.onUnload(() => {});
	});

	it('stops polling and reports a fatal login problem', async () => {
		const cloud = createCloud();
		cloud.fail = 401;
		const a = await start({}, cloud);
		expect(a.states.get('info.connection')).to.equal(false);
		expect(a.logs.some(l => l[0] === 'error' && l[1].includes('sign in again'))).to.equal(true);
		expect(a.timers).to.have.length(0);
		await a.onUnload(() => {});
	});

	it('survives a temporary outage and keeps polling', async () => {
		const cloud = createCloud();
		cloud.fail = 503;
		const a = await start({}, cloud);
		expect(a.states.get('info.connection')).to.equal(false);
		expect(a.logs.some(l => l[0] === 'warn')).to.equal(true);
		// poll timer and nightly restore timer
		expect(a.timers).to.have.length(2);
		await a.onUnload(() => {});
		expect(a.timers).to.have.length(0);
	});

	it('clamps an invalid poll interval and timezone', async () => {
		const a = await start({ pollInterval: 1, timezone: 'Mars/Base' }, createCloud());
		expect(a.pollSeconds).to.equal(60);
		expect(a.timezone).to.equal('Europe/Berlin');
		await a.onUnload(() => {});
		const b = await start({ pollInterval: 'abc' }, createCloud());
		expect(b.pollSeconds).to.equal(300);
		await b.onUnload(() => {});
	});

	it('starts without a token and does not touch the cloud', async () => {
		const cloud = createCloud();
		const a = await start({ sessionToken: '' }, cloud);
		expect(cloud.calls).to.have.length(0);
		expect(a.logs.some(l => l[0] === 'warn')).to.equal(true);
		await a.onUnload(() => {});
	});

	it('answers the admin UI in the system language with an English fallback', async () => {
		const a = await start({}, createCloud());
		expect(await a.uiText('loginDone')).to.contain('Anmeldung');
		a.getForeignObjectAsync = async () => ({ common: { language: 'fr' } });
		expect(await a.uiText('loginDone')).to.contain('Connexion');
		a.getForeignObjectAsync = async () => ({ common: { language: '../x' } });
		expect(await a.uiText('loginDone')).to.equal('Login successful, the instance restarts');
		await a.onUnload(() => {});
	});

	it('handles the login messages from the admin UI', async () => {
		const cloud = createCloud();
		const a = await start({ sessionToken: '' }, cloud);
		await a.onMessage({ command: 'completeLogin', message: { redirectUrl: 'npf://auth#session_token_code=C' }, from: 'x', callback: 1 });
		expect(a.sent[0].error).to.contain('login link first');

		await a.onMessage({ command: 'getLoginText', message: {}, from: 'x', callback: 1 });
		const copyUrl = a.sent.pop();
		expect(copyUrl).to.be.a('string').and.match(/^https:\/\/accounts\.nintendo\.com\//);
		await a.onMessage({ command: 'getLoginUrl', message: {}, from: 'x', callback: 1 });
		expect(a.sent[1].openUrl).to.equal(copyUrl);
		expect(a.sent[1].result).to.be.a('string').and.contain('Rechtsklick');
		const url = new URL(a.sent[1].openUrl);
		const state = url.searchParams.get('state');

		global.fetch = async () => ({ status: 200, ok: true, text: async () => JSON.stringify({ session_token: 'NEWTOKEN' }) });
		await a.onMessage({ command: 'completeLogin', message: { redirectUrl: `npf://auth#session_token_code=C&state=${state}` }, from: 'x', callback: 1 });
		expect(a.sent[2].error).to.equal(undefined);
		expect(a.sent[2].result).to.be.a('string');
		expect(a.foreign).to.deep.equal([['system.adapter.nintendo-switch-parental.0', { native: { sessionToken: 'enc:NEWTOKEN', redirectUrl: '' } }]]);
		await a.onUnload(() => {});
	});

	describe('template and pause', () => {
		const write = async (a, key, val) => {
			a.onStateChange(`nintendo-switch-parental.0.devices.D1.${key}`, { val, ack: false });
			await idle();
		};
		const updates = cloud => cloud.calls.filter(c => c.path.endsWith('updatePlayTimer'));

		it('creates the template states without overwriting them on the next poll', async () => {
			const a = await start({}, createCloud());
			expect(a.objects.get('devices.D1.saveTemplate').common).to.include({ role: 'button', read: false, write: true });
			expect(a.objects.get('devices.D1.restoreTemplate').common).to.include({ role: 'button', read: false, write: true });
			expect(a.objects.get('devices.D1.restoreDaily').common).to.include({ role: 'switch', write: true });
			expect(a.objects.get('devices.D1.pausedLimit').common).to.include({ write: false });
			expect(a.states.get('devices.D1.restoreDaily')).to.equal(false);
			await write(a, 'restoreDaily', true);
			await a.runExclusive(() => a.pollAll());
			expect(a.states.get('devices.D1.restoreDaily')).to.equal(true);
			await a.onUnload(() => {});
		});

		it('saves the rules as template and writes them back', async () => {
			const cloud = createCloud();
			const a = await start({}, cloud);
			await write(a, 'saveTemplate', true);
			const saved = JSON.parse(a.states.get('devices.D1.template'));
			expect(saved.timerMode).to.equal('DAILY');
			expect(saved.dailyRegulations.timeToPlayInOneDay.limitTime).to.equal(90);
			expect(updates(cloud)).to.have.length(0);

			await write(a, 'limit', 30);
			expect(a.states.get('devices.D1.limit')).to.equal(30);
			await write(a, 'restoreTemplate', true);
			expect(a.states.get('devices.D1.limit')).to.equal(90);
			expect(updates(cloud)).to.have.length(2);

			// already identical: nothing is sent
			await write(a, 'restoreTemplate', true);
			expect(updates(cloud)).to.have.length(2);
			await a.onUnload(() => {});
		});

		it('warns when no template is stored and ignores an invalid template', async () => {
			const cloud = createCloud();
			const a = await start({}, cloud);
			await write(a, 'restoreTemplate', true);
			expect(updates(cloud)).to.have.length(0);
			expect(a.logs.some(l => l[0] === 'warn' && l[1].includes('No valid template'))).to.equal(true);

			await write(a, 'saveTemplate', true);
			const good = a.states.get('devices.D1.template');
			await write(a, 'template', '{"nonsense":true}');
			expect(a.states.get('devices.D1.template')).to.equal(good);
			await a.onUnload(() => {});
		});

		it('restores the template at night only where it is switched on', async () => {
			const cloud = createCloud();
			const a = await start({}, cloud);
			await write(a, 'saveTemplate', true);
			await write(a, 'limit', 30);
			await a.runDailyRestore(null, 1);
			expect(a.states.get('devices.D1.limit')).to.equal(30);

			await write(a, 'restoreDaily', true);
			await a.runDailyRestore(null, 1);
			expect(a.states.get('devices.D1.limit')).to.equal(90);
			await a.onUnload(() => {});
		});

		it('schedules the nightly restore and clears it on unload', async () => {
			const a = await start({}, createCloud());
			expect(a.restoreTimer).to.not.equal(undefined);
			await a.onUnload(() => {});
			expect(a.restoreTimer).to.equal(undefined);
		});

		it('pauses today with limit 0 and resumes with the previous limit', async () => {
			const cloud = createCloud();
			const a = await start({}, cloud);
			await write(a, 'pauseToday', true);
			expect(a.states.get('devices.D1.limit')).to.equal(0);
			expect(JSON.parse(a.states.get('devices.D1.pausedLimit')).setting).to.deep.equal({ enabled: true, limitTime: 90 });

			// a second press must not overwrite the saved limit
			await write(a, 'pauseToday', true);
			expect(JSON.parse(a.states.get('devices.D1.pausedLimit')).setting.limitTime).to.equal(90);

			await write(a, 'resumeToday', true);
			expect(a.states.get('devices.D1.limit')).to.equal(90);
			expect(a.states.get('devices.D1.pausedLimit')).to.equal('');
			await a.onUnload(() => {});
		});

		it('ends an old pause at night but keeps one started today', async () => {
			const cloud = createCloud();
			const a = await start({}, cloud);
			await write(a, 'pauseToday', true);
			await a.runDailyRestore(null, 1);
			expect(a.states.get('devices.D1.limit')).to.equal(0);

			const pause = JSON.parse(a.states.get('devices.D1.pausedLimit'));
			pause.date = '2000-01-01';
			await a.setState('devices.D1.pausedLimit', { val: JSON.stringify(pause), ack: true });
			await a.runDailyRestore(null, 1);
			expect(a.states.get('devices.D1.limit')).to.equal(90);
			expect(a.states.get('devices.D1.pausedLimit')).to.equal('');
			await a.onUnload(() => {});
		});

		it('remembers the day of the last nightly run and writes it after a run', async () => {
			const a = await start({}, createCloud());
			await idle();
			const today = L.zonedNow('Europe/Berlin').date;
			expect(a.states.get('info.lastNightlyRun')).to.equal(today);
			await a.setState('info.lastNightlyRun', { val: '2000-01-01', ack: true });
			await a.runDailyRestore(null, 1);
			expect(a.states.get('info.lastNightlyRun')).to.equal(today);
			await a.onUnload(() => {});
		});

		it('catches up a missed night after a restart', async () => {
			const cloud = createCloud();
			const a = await start({}, cloud);
			await write(a, 'saveTemplate', true);
			await write(a, 'restoreDaily', true);
			await write(a, 'limit', 30);

			// same day: nothing to catch up, the change of the day stays
			await a.catchUpNightly();
			expect(a.states.get('devices.D1.limit')).to.equal(30);

			await a.setState('info.lastNightlyRun', { val: '2000-01-01', ack: true });
			await a.catchUpNightly();
			expect(a.states.get('devices.D1.limit')).to.equal(90);
			expect(a.states.get('info.lastNightlyRun')).to.equal(L.zonedNow('Europe/Berlin').date);
			await a.onUnload(() => {});
		});

		it('ends an old pause at start even without a nightly run to catch up', async () => {
			const cloud = createCloud();
			const a = await start({}, cloud);
			await write(a, 'pauseToday', true);
			await write(a, 'saveTemplate', true);
			await write(a, 'restoreDaily', true);

			// a pause from today stays, and the template is not touched at a normal start
			await a.catchUpNightly();
			expect(a.states.get('devices.D1.limit')).to.equal(0);

			const pause = JSON.parse(a.states.get('devices.D1.pausedLimit'));
			pause.date = '2000-01-01';
			await a.setState('devices.D1.pausedLimit', { val: JSON.stringify(pause), ack: true });
			await a.catchUpNightly();
			expect(a.states.get('devices.D1.limit')).to.equal(90);
			expect(a.states.get('devices.D1.pausedLimit')).to.equal('');
			await a.onUnload(() => {});
		});

		it('publishes the time of the last update', async () => {
			const before = Date.now();
			const a = await start({}, createCloud());
			expect(a.states.get('devices.D1.lastUpdate')).to.be.within(before, Date.now());
			expect(a.objects.get('devices.D1.lastUpdate').common).to.include({ role: 'date', read: true, write: false });
			await a.onUnload(() => {});
		});

		it('does not mark a night as done when the restore failed on the last attempt', async () => {
			const cloud = createCloud();
			const a = await start({}, cloud);
			await write(a, 'saveTemplate', true);
			await write(a, 'restoreDaily', true);
			await a.setState('info.lastNightlyRun', { val: '2000-01-01', ack: true });
			cloud.fail = 503;
			await a.runDailyRestore(null, 3);
			expect(a.states.get('info.lastNightlyRun')).to.equal('2000-01-01');
			cloud.fail = null;
			await a.runDailyRestore(null, 3);
			expect(a.states.get('info.lastNightlyRun')).to.equal(L.zonedNow('Europe/Berlin').date);
			await a.onUnload(() => {});
		});

		it('reads a console again at night only if something was changed', async () => {
			const cloud = createCloud();
			const a = await start({}, cloud);
			await write(a, 'saveTemplate', true);
			await write(a, 'restoreDaily', true);
			const before = cloud.calls.length;
			await a.runDailyRestore(null, 3);
			// only the comparison with the template, no extra refresh
			expect(cloud.calls.length - before).to.equal(1);
			await write(a, 'limit', 30);
			await a.runDailyRestore(null, 3);
			expect(a.states.get('devices.D1.limit')).to.equal(90);
			await a.onUnload(() => {});
		});

		it('loads the console list at night when the first poll failed', async () => {
			const cloud = createCloud();
			cloud.fail = 503;
			const a = await start({}, cloud);
			expect(a.deviceMap.size).to.equal(0);
			cloud.fail = null;
			await a.runDailyRestore(null, 1);
			expect(a.deviceListLoaded).to.equal(true);
			expect(a.deviceMap.size).to.equal(1);
			expect(a.states.get('info.lastNightlyRun')).to.equal(L.zonedNow('Europe/Berlin').date);
			await a.onUnload(() => {});
		});

		it('retries later while the console list is unknown and stops on unload', async () => {
			const cloud = createCloud();
			cloud.fail = 503;
			const a = await start({}, cloud);
			const run = a.runDailyRestore(null, 1);
			await idle();
			expect(a.retryTimer).to.not.equal(undefined);
			await a.onUnload(() => {});
			await run;
			expect(a.retryTimer).to.equal(undefined);
		});

		it('refuses to pause while extra time is active', async () => {
			const cloud = createCloud();
			const a = await start({}, cloud);
			await write(a, 'addExtraTime', 15);
			const before = updates(cloud).length;
			await write(a, 'pauseToday', true);
			expect(updates(cloud)).to.have.length(before);
			expect(a.states.get('devices.D1.pausedLimit')).to.equal('');
			expect(a.logs.some(l => l[0] === 'warn' && l[1].includes('extra play time'))).to.equal(true);
			await a.onUnload(() => {});
		});
	});
});
