'use strict';

const { expect } = require('chai');
const { NintendoAuth, AuthError, createLoginSession, parseRedirectLink } = require('../lib/auth');
const { MoonApi, ApiError } = require('../lib/api');

/**
 * @param {Array<{status?: number, body?: any}>} responses - Queued responses
 * @returns {{fetch: Function, calls: Array<{url: string, init: any}>}} Fake fetch
 */
function fakeFetch(responses) {
	const calls = [];
	const fn = async (url, init) => {
		calls.push({ url, init });
		const next = responses.shift();
		if (!next) {
			throw new Error(`Unexpected request to ${url}`);
		}
		const status = next.status || 200;
		const text = JSON.stringify(next.body ?? {});
		return { status, ok: status >= 200 && status < 300, text: async () => text, json: async () => JSON.parse(text) };
	};
	return { fetch: fn, calls };
}

const tokenOk = { body: { id_token: 'ID', access_token: 'AT', expires_in: 900 } };

describe('auth', () => {
	it('creates a PKCE login URL', () => {
		const s = createLoginSession();
		const url = new URL(s.loginUrl);
		expect(url.origin + url.pathname).to.equal('https://accounts.nintendo.com/connect/1.0.0/authorize');
		expect(url.searchParams.get('state')).to.equal(s.state);
		expect(url.searchParams.get('session_token_code_challenge_method')).to.equal('S256');
		expect(url.searchParams.get('redirect_uri')).to.equal('npf54789befb391a838://auth');
	});

	it('parses redirect links', () => {
		expect(parseRedirectLink('npf54789befb391a838://auth#session_token_code=abc&state=xyz&session_state=q')).to.deep.equal({
			code: 'abc',
			state: 'xyz',
		});
		expect(parseRedirectLink('session_token_code=abc')).to.deep.equal({ code: 'abc', state: undefined });
		expect(() => parseRedirectLink('')).to.throw('empty');
		expect(() => parseRedirectLink('npf://auth#foo=bar')).to.throw('session_token_code');
		expect(() => parseRedirectLink('npf://auth#error=access_denied')).to.throw('access_denied');
	});

	it('completes the login and exchanges the code', async () => {
		const f = fakeFetch([{ body: { session_token: 'SESSION' } }]);
		const session = createLoginSession();
		const token = await new NintendoAuth('', f.fetch).completeLogin(`npf://auth#session_token_code=CODE&state=${session.state}`, session);
		expect(token).to.equal('SESSION');
		expect(f.calls[0].init.body).to.contain('session_token_code=CODE').and.contain(`session_token_code_verifier=${session.verifier}`);
	});

	it('rejects a link from another login attempt', async () => {
		const f = fakeFetch([]);
		let error;
		try {
			await new NintendoAuth('', f.fetch).completeLogin('npf://auth#session_token_code=C&state=other', createLoginSession());
		} catch (e) {
			error = e;
		}
		expect(error.message).to.contain('current login attempt');
		expect(f.calls).to.have.length(0);
	});

	it('caches the id token until shortly before expiry', async () => {
		const f = fakeFetch([tokenOk]);
		const auth = new NintendoAuth('S', f.fetch);
		expect(await auth.getAuthorization()).to.equal('Bearer ID');
		expect(await auth.getAuthorization()).to.equal('Bearer ID');
		expect(f.calls).to.have.length(1);
		auth.expiresAt = Date.now() + 60 * 1000;
		f.calls.length = 0;
		const f2 = fakeFetch([{ body: { id_token: 'ID2', expires_in: 900 } }]);
		auth.fetch = f2.fetch;
		expect(await auth.getAuthorization()).to.equal('Bearer ID2');
	});

	it('flags a rejected session token as fatal', async () => {
		const auth = new NintendoAuth('S', fakeFetch([{ status: 400, body: { error: 'invalid_grant' } }]).fetch);
		let error;
		try {
			await auth.getAuthorization();
		} catch (e) {
			error = e;
		}
		expect(error).to.be.instanceOf(AuthError);
		expect(error.fatal).to.equal(true);
	});

	it('treats server errors as temporary', async () => {
		const auth = new NintendoAuth('S', fakeFetch([{ status: 503 }]).fetch);
		let error;
		try {
			await auth.getAuthorization();
		} catch (e) {
			error = e;
		}
		expect(error).to.be.instanceOf(AuthError);
		expect(error.fatal).to.equal(false);
	});
});

describe('api', () => {
	const make = responses => {
		const f = fakeFetch(responses);
		return { f, api: new MoonApi(new NintendoAuth('S', f.fetch), 'Europe/Berlin', 'de-DE', f.fetch) };
	};

	it('sends the Moon headers and the id token', async () => {
		const { f, api } = make([tokenOk, { body: { ownedDevices: [] } }]);
		await api.fetchOwnedDevices();
		const { url, init } = f.calls[1];
		expect(url).to.equal('https://app.lp1.znma.srv.nintendo.net/v2/actions/user/fetchOwnedDevices');
		expect(init.headers.Authorization).to.equal('Bearer ID');
		expect(init.headers['X-Moon-TimeZone']).to.equal('Europe/Berlin');
		expect(init.headers['X-Moon-App-Language']).to.equal('de-DE');
	});

	it('refreshes the token once on 401 and retries', async () => {
		const { f, api } = make([tokenOk, { status: 401 }, { body: { id_token: 'NEW', expires_in: 900 } }, { body: { ok: 1 } }]);
		expect(await api.fetchDailySummaries('D 1')).to.deep.equal({ ok: 1 });
		expect(f.calls[1].url).to.contain('deviceId=D%201');
		expect(f.calls[3].init.headers.Authorization).to.equal('Bearer NEW');
	});

	it('reports HTTP errors without leaking headers', async () => {
		const { api } = make([tokenOk, { status: 500 }]);
		let error;
		try {
			await api.fetchOwnedDevices();
		} catch (e) {
			error = e;
		}
		expect(error).to.be.instanceOf(ApiError);
		expect(error.message).to.equal('HTTP 500 (/v2/actions/user/fetchOwnedDevices)');
	});

	it('only sends the allowed play timer keys', async () => {
		const { f, api } = make([tokenOk, { body: {} }]);
		await api.updatePlayTimer('D1', { timerMode: 'DAILY', restrictionMode: 'ALARM', dailyRegulations: {}, bedtimeStartingTime: { hour: 6 } });
		const body = JSON.parse(f.calls[1].init.body);
		expect(body.deviceId).to.equal('D1');
		expect(Object.keys(body.playTimerRegulations).sort()).to.deep.equal(['dailyRegulations', 'restrictionMode', 'timerMode']);
	});

	it('maps extra time requests and checks the response status', async () => {
		const { f, api } = make([tokenOk, { body: { status: 'SUCCESS' } }, { body: { status: 'SUCCESS' } }, { body: { status: 'TO_INFINITY' } }]);
		await api.updateExtraPlayingTime('D1', { minutes: 15 });
		await api.updateExtraPlayingTime('D1', { cancel: true });
		await api.updateExtraPlayingTime('D1', { minutes: -1 });
		expect(JSON.parse(f.calls[1].init.body)).to.deep.equal({ deviceId: 'D1', additionalTime: 15, status: 'TO_ADDED' });
		expect(JSON.parse(f.calls[2].init.body)).to.deep.equal({ deviceId: 'D1', status: 'TO_CANCELED' });
		expect(JSON.parse(f.calls[3].init.body)).to.deep.equal({ deviceId: 'D1', status: 'TO_INFINITY' });
	});

	it('throws when Nintendo rejects extra time with HTTP 200', async () => {
		const { api } = make([tokenOk, { body: { status: 'OVERTIME_ERROR' } }]);
		let error;
		try {
			await api.updateExtraPlayingTime('D1', { minutes: 15 });
		} catch (e) {
			error = e;
		}
		expect(error.message).to.contain('OVERTIME_ERROR');
	});

	it('confirms extra time with bedtime', async () => {
		const { f, api } = make([tokenOk, { body: { status: 'SUCCESS' } }]);
		await api.confirmExtraPlayingTime('D1', 20, true);
		expect(JSON.parse(f.calls[1].init.body)).to.deep.equal({ deviceId: 'D1', additionalTime: 20, withBedtime: true });
	});

	it('builds the restriction level update from the setting', async () => {
		const { f, api } = make([tokenOk, { body: {} }]);
		await api.updateRestrictionLevel('D1', {
			etag: 'E',
			functionalRestrictionLevel: 'OLDER_TEENS',
			whitelistedApplicationList: [],
			customSettings: { vrRestrictionEtag: 'V' },
		});
		expect(JSON.parse(f.calls[1].init.body)).to.deep.equal({
			deviceId: 'D1',
			customSettings: { vrRestrictionEtag: 'V' },
			parentalControlSettingEtag: 'E',
			vrRestrictionEtag: 'V',
			whitelistedApplicationList: [],
			functionalRestrictionLevel: 'OLDER_TEENS',
		});
	});
});
