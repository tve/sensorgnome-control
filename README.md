# sensorgnome-control

Main control process for a sensorgnome field computer.

The main control process consists of a JavaScript node.js application found in the src
directory. Npm is used to install all the dependencies: run `npm install`.

The `gen-package.sh` script produces a debian package that includes the application, the
systemd service file, and all the javascript dependencies (i.e., `npm install` is run as part
of the packaging process). The reason to bundle the dependencies is so the deb can be carried to
a station on a flash stick and used to upgrade without requiring an internet connection.

History: this repo used to hold both control and
[support](https://github.com/sensorgnome-org/sensorgnome-support)
software, but was split into two repos.
Also the term "master" has been replaced by "main".

## Known issues

- rtlsdr radios do not work, do not plug any in
- after a file download the dashboard is unresponsive for 10-20 seconds because the websocket disconnects, has to time-out and reconnect
- ability to upload tag database is missing
- logging is too verbose, need to distinguish info/warn/err
