![Logo](admin/nintendo-switch-parental.png)

# ioBroker.nintendo-switch-parental

[![NPM version](https://img.shields.io/npm/v/iobroker.nintendo-switch-parental.svg)](https://www.npmjs.com/package/iobroker.nintendo-switch-parental)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Unofficial [Nintendo Switch Parental Controls](https://www.nintendo.com/switch/parental-controls/) integration for ioBroker. I use it to read and change play time, daily limit, extra time, bedtime and more. It works for Nintendo Switch and Nintendo Switch 2 and talks to Nintendo's cloud, the same service the official smartphone app uses. The cloud API and the login flow are ported from [pynintendoparental](https://github.com/pantherale0/pynintendoparental), the library behind the Home Assistant integration.

**Nintendo** and **Nintendo Switch** are trademarks of Nintendo. This project is not affiliated with or endorsed by Nintendo. The API is not public and Nintendo may change or block it at any time.

## Features

- Play time today and this month, time remaining, last sync per console
- Daily limit, timer mode (daily / per weekday) and suspend-software mode
- Extra time: add or cancel
- Bedtime start and end
- Restriction level (age rating)
- Play time per player and, optionally, per game (with allow list)
- Polling every 1-60 minutes (default 5), commands are sent immediately

## Requirements

- Node.js 22 or newer, js-controller 6.0.11 or newer, admin 7.0.23 or newer
- A Nintendo Account that is the parent/guardian of at least one console in the Nintendo Switch Parental Controls app
- The console has to be online for Nintendo to receive the current play time

## Installation

Install via ioBroker Admin UI.

## Configuration

Open the instance settings and sign in with your Nintendo Account:

1. Click **Create login link**. A Nintendo login page opens.
2. Sign in. On the page *Linking an External Account*, right-click **Select this person** and copy the link address. Do not click the button.
3. Paste the link into **Copied link** and click **Complete login**.

The session token is stored encrypted and the adapter restarts. If Nintendo ever revokes the token, the log tells you to sign in again.

| Setting | Description |
|---------|-------------|
| Poll interval | Seconds between cloud reads (60-3600, default 300) |
| Timezone | Used for "today" and the weekday limits (default Europe/Berlin) |
| Language | Nintendo cloud language (default de-DE) |
| Create states for each game | Creates `apps.<applicationId>.*` per game |

## Datapoints

Per console under `devices.<deviceId>`:

| State | Access | Description |
|-------|--------|-------------|
| `name`, `model`, `firmware` | R | Console label, model (Switch / Switch 2) and firmware |
| `lastSync` | R | Last time the console synced with Nintendo |
| `playTimeToday` | R | Minutes played today (all players) |
| `timeRemaining` | R | Minutes left today, considers limit, extra time and bedtime |
| `playTimeMonth` | R | Minutes played this month |
| `limit` | R/W | Daily limit in minutes, `-1` = no limit, maximum 360. Applies to today's regulation (the weekday in per-weekday mode) |
| `extraTime` | R | Extra time granted today in minutes, `-1` = unlimited |
| `addExtraTime` | W | Minutes of extra time to add today, `-1` = unlimited |
| `cancelExtraTime` | W | Button, removes today's extra time |
| `bedtimeAlarm` | R/W | Bedtime start `HH:MM` (16:00-23:59), `00:00` = bedtime off |
| `bedtimeEnd` | R/W | Bedtime end `HH:MM` (05:00-09:00), `00:00` = bedtime off |
| `suspendSoftware` | R/W | `true`: software is suspended when time is up, `false`: alarm only |
| `timerMode` | R/W | `DAILY` or `EACH_DAY_OF_THE_WEEK` |
| `restrictionLevel` | R/W | `NONE`, `CHILDREN`, `YOUNG_TEENS`, `OLDER_TEENS` or `CUSTOM` |
| `alarmsEnabled` | R | Whether alarms are shown on the console |
| `players.<playerId>.*` | R | Nickname, profile image and play time today per user |
| `apps.<applicationId>.*` | R/W | Only with *Create states for each game*: title, play time today and `allowed` (allow list, ignores age restrictions) |

Instance: `info.connection` is `true` while Nintendo's cloud is reachable and the login is valid.

While extra time is active, the adapter refuses to change the limit, bedtime, suspend mode and timer mode, so cancel the extra time first. Invalid values are refused with a warning and the state returns to the real value right after.

## Notes

- Settings changed here reach the console the next time it connects to the internet.
- While extra time is active, the adapter refuses to change the limit, bedtime, suspend mode and timer mode. Cancel the extra time first.
- Invalid values are refused with a warning and the state returns to the real value.
- Changing the PIN is not supported.

## Changelog
<!--
	Placeholder for the next version (at the beginning of the line):
	### **WORK IN PROGRESS**
-->

### 0.0.2 (2026-11-15)
- (backfisch88) test release (npm publishing)

### 0.0.1 (2026-11-15)
- (backfisch88) initial release

## License

MIT License

Copyright (c) 2026 Henrik Schönhofen (backfisch88) <henrik.schoenhofen@icloud.com>

See [LICENSE](LICENSE) for the full license text.

## Credits

The cloud API and login flow follow [pynintendoparental](https://github.com/pantherale0/pynintendoparental) (MIT, Justin Hammond) and [pynintendoauth](https://pypi.org/project/pynintendoauth/).
