![Logo](admin/nintendo-switch-parental.png)
# ioBroker.nintendo-switch-parental

[![NPM version](https://img.shields.io/npm/v/iobroker.nintendo-switch-parental.svg)](https://www.npmjs.com/package/iobroker.nintendo-switch-parental)
[![Downloads](https://img.shields.io/npm/dm/iobroker.nintendo-switch-parental.svg)](https://www.npmjs.com/package/iobroker.nintendo-switch-parental)
![Number of Installations](https://iobroker.live/badges/nintendo-switch-parental-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/nintendo-switch-parental-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.nintendo-switch-parental.png?downloads=true)](https://nodei.co/npm/iobroker.nintendo-switch-parental/)

**Tests:** ![Test and Release](https://github.com/backfisch88/ioBroker.nintendo-switch-parental/workflows/Test%20and%20Release/badge.svg)

## Nintendo Switch Parental Controls adapter for ioBroker

I use this adapter to read and change the settings of the [Nintendo Switch Parental Controls](https://www.nintendo.com/switch/parental-controls/) from ioBroker: play time, daily limit, extra time, bedtime and more. It works for Nintendo Switch and Nintendo Switch 2 and talks to Nintendo's cloud, the same service the official smartphone app uses. The cloud API and the login flow are ported from the [pynintendoparental](https://github.com/pantherale0/pynintendoparental) library behind the Home Assistant integration.

**Nintendo** and **Nintendo Switch** are trademarks of Nintendo. This project is not affiliated with or endorsed by Nintendo. The API is not public and Nintendo may change or block it at any time.

## Requirements

- Node.js 22 or newer, js-controller 6.0.11 or newer, admin 7.0.23 or newer
- A Nintendo Account that is the parent/guardian of at least one console in the Nintendo Switch Parental Controls app
- The console has to be online for Nintendo to receive the current play time

## Setup

1. Create an instance and open its settings.
2. Click **Create login link**. A Nintendo login page opens.
3. Sign in with your Nintendo Account. On the page *Linking an External Account*, right-click **Select this person** and copy the link address. Do not click the button.
4. Paste the link into **Copied link** and click **Complete login**.

The adapter stores the session token encrypted and restarts. Nothing else is needed. If Nintendo ever revokes the token, the log tells you to sign in again.

## States

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

- The data is polled from the cloud every 5 minutes by default (minimum 60 seconds). Commands are sent immediately and the console is re-read afterwards.
- Settings changed here reach the console the next time it connects to the internet.
- Changing the PIN is not supported.

## Changelog
<!--
	Placeholder for the next version (at the beginning of the line):
	### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**
- (backfisch88) initial release

## License
MIT License

Copyright (c) 2026 Henrik Schönhofen (backfisch88) <henrik.schoenhofen@icloud.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Credits
The cloud API and login flow follow [pynintendoparental](https://github.com/pantherale0/pynintendoparental) (MIT, Justin Hammond) and [pynintendoauth](https://pypi.org/project/pynintendoauth/).
