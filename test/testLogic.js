'use strict';

const { expect } = require('chai');
const L = require('../lib/logic');

const now = { date: '2025-12-08', hour: 14, minute: 0, weekday: 0 };

const pcsResponse = (regs, extra = null) => ({
	parentalControlSetting: {
		deviceId: 'D1',
		functionalRestrictionLevel: 'CHILDREN',
		playTimerRegulations: regs,
		whitelistedApplicationList: [{ applicationId: '0100AA', title: 'Game', imageUri: 'x', safeLaunch: 'NONE' }],
	},
	ownedDevice: {
		deviceId: 'D1',
		label: 'Kid',
		device: { platformGeneration: 'P01', alarmSetting: { visibility: 'VISIBLE' }, extraPlayingTime: extra },
	},
});

const regs = () => ({
	timerMode: 'DAILY',
	restrictionMode: 'ALARM',
	dailyRegulations: {
		timeToPlayInOneDay: { enabled: true, limitTime: 90 },
		bedtime: { enabled: true, startingTime: { hour: 6, minute: 0 }, endingTime: { hour: 20, minute: 0 } },
	},
	eachDayOfTheWeekRegulations: { monday: { timeToPlayInOneDay: { enabled: true, limitTime: 30 } } },
});

const daily = {
	dailySummaries: [
		{
			date: '2025-12-08',
			playingTime: 40,
			players: [
				{
					profile: { playerId: 'P1', nickname: 'Anna', imageUri: 'img' },
					playingTime: 40,
					playedGames: [{ meta: { applicationId: '0100AA' }, playingTime: 40 }],
				},
			],
		},
		{ date: '2025-12-01', playingTime: 20, players: [] },
		{ date: '2025-11-30', playingTime: 99, players: [] },
	],
};

describe('logic', () => {
	it('zonedNow returns civil time of the zone', () => {
		const t = L.zonedNow('Europe/Berlin', new Date('2025-12-08T23:30:00Z'));
		expect(t).to.deep.equal({ date: '2025-12-09', hour: 0, minute: 30, second: 0, weekday: 1 });
	});

	it('validates timezones', () => {
		expect(L.isValidTimezone('Europe/Berlin')).to.equal(true);
		expect(L.isValidTimezone('Nowhere/City')).to.equal(false);
		expect(L.isValidTimezone('')).to.equal(false);
	});

	it('parses and validates times', () => {
		expect(L.parseTimeString('20:30')).to.deep.equal({ hour: 20, minute: 30 });
		expect(() => L.parseTimeString('25:00')).to.throw();
		expect(() => L.parseTimeString('abc')).to.throw();
		expect(L.apiTimeToString(null)).to.equal('00:00');
		expect(L.apiTimeToString({ hour: 7, minute: 5 })).to.equal('07:05');
	});

	describe('remainingMinutes', () => {
		const base = { now, limit: 90, extra: null, bedtimeAlarm: null, alarmsEnabled: true, played: 40 };
		it('uses the play limit', () => {
			expect(L.remainingMinutes(base)).to.equal(50);
		});
		it('adds extra time and handles unlimited', () => {
			expect(L.remainingMinutes({ ...base, extra: 30 })).to.equal(80);
			expect(L.remainingMinutes({ ...base, extra: -1 })).to.equal(600);
			expect(L.remainingMinutes({ ...base, limit: -1 })).to.equal(600);
		});
		it('never goes below zero', () => {
			expect(L.remainingMinutes({ ...base, played: 200 })).to.equal(0);
		});
		it('is capped by bedtime when alarms are enabled', () => {
			const bedtimeAlarm = { hour: 14, minute: 20 };
			expect(L.remainingMinutes({ ...base, bedtimeAlarm })).to.equal(20);
			expect(L.remainingMinutes({ ...base, bedtimeAlarm, alarmsEnabled: false })).to.equal(50);
			expect(L.remainingMinutes({ ...base, bedtimeAlarm: { hour: 13, minute: 0 } })).to.equal(0);
		});
	});

	describe('buildSnapshot', () => {
		it('builds device, player and app data', () => {
			const response = pcsResponse(regs());
			const s = L.buildSnapshot({ owned: response.ownedDevice, pcsResponse: response, daily, now });
			expect(s).to.include({
				id: 'D1',
				name: 'Kid',
				model: 'Switch 2',
				limit: 90,
				bedtimeAlarm: '20:00',
				bedtimeEnd: '06:00',
				playedToday: 40,
				playedMonth: 60,
				remaining: 50,
				alarmsEnabled: true,
				forcedTermination: false,
				restrictionLevel: 'CHILDREN',
			});
			expect(s.players).to.deep.equal([{ id: 'P1', nickname: 'Anna', image: 'img', playingTime: 40 }]);
			expect(s.apps).to.deep.equal([{ id: '0100AA', name: 'Game', image: 'x', allowed: false, playingTime: 40 }]);
		});

		it('treats a stale summary as zero play time', () => {
			const stale = { dailySummaries: [{ ...daily.dailySummaries[0], date: '2025-12-07' }] };
			const s = L.buildSnapshot({ owned: null, pcsResponse: pcsResponse(regs()), daily: stale, now });
			expect(s.playedToday).to.equal(0);
			expect(s.players[0].playingTime).to.equal(0);
		});

		it('uses the weekday regulation in EACH_DAY_OF_THE_WEEK mode', () => {
			const r = regs();
			r.timerMode = 'EACH_DAY_OF_THE_WEEK';
			const s = L.buildSnapshot({ owned: null, pcsResponse: pcsResponse(r), daily, now });
			expect(s.limit).to.equal(30);
			expect(s.bedtimeAlarm).to.equal('00:00');
		});

		it('reports -1 when no limit is enabled', () => {
			const r = regs();
			r.dailyRegulations.timeToPlayInOneDay = { enabled: false, limitTime: null };
			expect(L.buildSnapshot({ owned: null, pcsResponse: pcsResponse(r), daily, now }).limit).to.equal(-1);
		});

		it('parses extra time', () => {
			const extra = { inOneDay: { duration: 15, isInfinity: false } };
			expect(L.buildSnapshot({ owned: null, pcsResponse: pcsResponse(regs(), extra), daily, now }).extra).to.equal(15);
			const inf = { inOneDay: { isInfinity: true } };
			expect(L.currentExtraTime(pcsResponse(regs(), inf), now)).to.equal(-1);
			expect(L.currentExtraTime(pcsResponse(regs(), null), now)).to.equal(null);
		});

		it('derives extra time from an extended bedtime', () => {
			const extra = { bedtime: { endTime: { hour: 20, minute: 45 } } };
			const s = L.buildSnapshot({ owned: null, pcsResponse: pcsResponse(regs(), extra), daily, now });
			expect(s.extra).to.equal(45);
			expect(s.bedtimeAlarm).to.equal('20:45');
		});
	});

	describe('mutations', () => {
		it('sets and removes the limit without touching the input', () => {
			const input = regs();
			const out = L.withLimit(input, now, 45);
			expect(out.dailyRegulations.timeToPlayInOneDay).to.deep.equal({ enabled: true, limitTime: 45 });
			expect(input.dailyRegulations.timeToPlayInOneDay.limitTime).to.equal(90);
			const off = L.withLimit(input, now, -1);
			expect(off.dailyRegulations.timeToPlayInOneDay).to.deep.equal({ enabled: false });
		});

		it('writes the weekday regulation in EACH_DAY_OF_THE_WEEK mode', () => {
			const input = { ...regs(), timerMode: 'EACH_DAY_OF_THE_WEEK' };
			const out = L.withLimit(input, now, 60);
			expect(out.eachDayOfTheWeekRegulations.monday.timeToPlayInOneDay.limitTime).to.equal(60);
			expect(out.dailyRegulations.timeToPlayInOneDay.limitTime).to.equal(90);
		});

		it('rejects invalid limits', () => {
			for (const v of [-2, 361, 1.5, NaN]) {
				expect(() => L.withLimit(regs(), now, v), String(v)).to.throw();
			}
		});

		it('sets and disables bedtime', () => {
			const alarm = L.withBedtimeAlarm(regs(), now, '21:15');
			expect(alarm.dailyRegulations.bedtime).to.deep.include({ enabled: true, endingTime: { hour: 21, minute: 15 } });
			const off = L.withBedtimeAlarm(regs(), now, '00:00');
			expect(off.dailyRegulations.bedtime).to.deep.include({ enabled: false, endingTime: null });
			expect(() => L.withBedtimeAlarm(regs(), now, '15:59')).to.throw();

			const end = L.withBedtimeEnd(regs(), now, '07:30');
			expect(end.dailyRegulations.bedtime.startingTime).to.deep.equal({ hour: 7, minute: 30 });
			const endOff = L.withBedtimeEnd(regs(), now, '00:00');
			expect(endOff.dailyRegulations.bedtime).to.deep.include({ enabled: false, startingTime: { hour: 6, minute: 0 } });
			expect(() => L.withBedtimeEnd(regs(), now, '09:01')).to.throw();
			expect(() => L.withBedtimeEnd(regs(), now, '04:59')).to.throw();
		});

		it('sets restriction and timer mode', () => {
			expect(L.withRestrictionMode(regs(), true).restrictionMode).to.equal('FORCED_TERMINATION');
			expect(L.withRestrictionMode(regs(), false).restrictionMode).to.equal('ALARM');
			expect(L.withTimerMode(regs(), 'EACH_DAY_OF_THE_WEEK').timerMode).to.equal('EACH_DAY_OF_THE_WEEK');
			expect(() => L.withTimerMode(regs(), 'WEEKLY')).to.throw();
		});

		it('toggles the allow list entry', () => {
			const pcs = pcsResponse(regs()).parentalControlSetting;
			expect(L.withAppAllowed(pcs, '0100aa', true).whitelistedApplicationList[0].safeLaunch).to.equal('ALLOW');
			expect(() => L.withAppAllowed(pcs, 'NOPE', true)).to.throw();
		});
	});
});

describe('template helpers', () => {
	const regs = {
		timerMode: 'DAILY',
		restrictionMode: 'ALARM',
		dailyRegulations: { timeToPlayInOneDay: { enabled: true, limitTime: 60 } },
		other: 1,
	};

	it('extracts only the schedule keys', () => {
		expect(L.extractTemplate(regs)).to.have.all.keys('timerMode', 'restrictionMode', 'dailyRegulations');
	});

	it('validates templates', () => {
		expect(L.isTemplate(L.extractTemplate(regs))).to.equal(true);
		expect(L.isTemplate(null)).to.equal(false);
		expect(L.isTemplate({ timerMode: 'X', restrictionMode: 'ALARM', dailyRegulations: {} })).to.equal(false);
		expect(L.isTemplate({ timerMode: 'DAILY', restrictionMode: 'ALARM' })).to.equal(false);
		expect(L.isTemplate({ timerMode: 'EACH_DAY_OF_THE_WEEK', restrictionMode: 'ALARM', dailyRegulations: {} })).to.equal(false);
	});

	it('compares templates independent of key order and extra keys', () => {
		const other = { restrictionMode: 'ALARM', dailyRegulations: { timeToPlayInOneDay: { limitTime: 60, enabled: true } }, timerMode: 'DAILY' };
		expect(L.sameTemplate(regs, other)).to.equal(true);
		expect(L.sameTemplate(regs, { ...other, restrictionMode: 'FORCED_TERMINATION' })).to.equal(false);
	});

	it('computes the time until midnight', () => {
		const ms = L.msUntilMidnight('Europe/Berlin', new Date('2026-11-16T22:30:00Z'));
		expect(ms).to.equal(30 * 60 * 1000);
	});

	it('reads and writes the limit setting of a weekday', () => {
		const setting = L.todayLimitSetting(regs, { weekday: 2 });
		expect(setting).to.deep.equal({ enabled: true, limitTime: 60 });
		const paused = L.withLimit(regs, { weekday: 2 }, 0);
		const back = L.withLimitSetting(paused, 2, setting);
		expect(back.dailyRegulations.timeToPlayInOneDay).to.deep.equal(setting);
	});
});
