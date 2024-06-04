sensorgnome-control
===================

Main control process for a sensorgnome field computer.

The main control process consists of a JavaScript node.js application found in the src
directory. Npm is used to install all the dependencies: run `npm install`.

The `gen-package.sh` script produces a debian package that includes the application, the
systemd service file, and all the javascript dependencies (i.e., `npm install` is run as part
of the packaging process). The reason to bundle the dependencies is so the deb can be carried to
a station on a flash stick and used to upgrade without requiring an internet connection
(this may be more theoretical than practical...).

History: this repo used to hold both control and
[support](https://github.com/sensorgnome-org/sensorgnome-support)
software, but was split into two repos.
Also the term "master" has been replaced by "main".

The structure of the software is that each source file is a relatively self-contained module,
almost like a little subprocess on its own.
Modules communicate through a JavaScript event bus, called "the matron" in the codebase.
The main module instantiates all the modules, hooks them together where one module needs to
make direct calls into another one, and then starts all the modules.

Of note is that the code has a notion of sensors that operate according to a schedule (could be
at night only, for example). The radios are such "sensors". Currently this structure is not
really used as everything runs 24x7, so it may be more confusing than anything else at first sight.

A slightly confusing relic of the past is that `uploader.js` does not upload the data to Motus.
It used to be able to send detections live to the sensorgnome.net server, but that is no longer
used. Uploads to Motus used to be by having the server SSH into each Sensorgnome in turn and pull
files, i.e., there is no code here for that. The current uploading mechanism is in `motus_up.js`
and uploads directly to the Motus site.
hwclock
The web ui is directly integrated into the codebase.
It uses the [FlexDash](https://github.com/flexdash/flexdash) dashboard, which is driven by
the dashboard configuration in `fd-config.json`. The config is edited live by launching the app
and using the editing functionality built into the dashboard itself.

The dashboard communicates with the app using socket.io and that is all implemented in
`flexdash.js`, which is largely Sensorgnome-agnostic. The code is `dashboard.js` links
events and data in the app with values displayed in the dashboard, and it receives actions from
the dashboard and calls the appropriate functions in the rest of the app.
This avoids having dashboard-specific code strewn around the entire app.

## RTL-SDR gain setting

### E4000 tuner

The E4000 tuner is not so common as it's a discontinued chip, however, Nooelec still has them
available to a large degree because they can be tuned to slightly higher frequencies than the more
common Rafael Micro tuners (this is of no import to Motus use).

The E4000 tuner has different tuner gain settings and the driver requires that they be set exactly,
otherwise the gain is not changed. This is a problem in that the default Sensorgnome acquisitions.json
file specifies a gain of 40.2 for all RTL-SDR and that gain is not supported by the E4000.
The setting needs to be changed, for example to 42.0.

In addition, the E4000 supports setting 6 IF gain stages (the Rafael Micro tuners have
2 IF stages that are set automatically).
The internal gain settings can be chosen to have high sensitivity or high linearity, see
https://hz.tools/e4k/. For Motus use sensitivity is what matters.

The settings in the acquisitions.json file TvE recommends are 6, 9, 6, 0, 3, 3 for a total 30dB gain.
Setting this properly requires Sensorgnome V2 build 2024-140 or RC15 or later.
The default in the driver is 6, 0, 0, 0, 9, 9, which is neither in the list of high sensitivity
settings nor high linearity...

Note that the tuner gain setting is separate and in addition to the 6 IF gain settings.

## Analog to Digital inputs

The CTT SensorStations all have an ADC to measure voltages.

### SS V1: TLC1543 11-input ADC

Inputs:
0. main bat div 6
1. solar div 6
2. RTC bat
3. NTCLG100E2104 with 100K pull-down
4. J7 with 100K pull-down (labeled "photo sensor")
5-9. J8 with 6 pins

### SS V2: ADS7924 4-input ADC, TMP102 temperature

0. solar (div 6)
1. bat (div 6)
2. RTC bat

### SS V3: MAX11645 2-input ADC, no temp sensor

0. solar
1. bat
