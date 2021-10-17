# sensorgnome-control

Master control process for a sensorgnome field computer.

This repo used to hold both control and [support](https://github.com/sensorgnome-org/sensorgnome-support)
software, but was split into two repos.

The bulk of the files in the `master` directory contain the javascript application itself.
To install the required javascript dependencies, run `npm install` in the directory.
When installed from a debian .deb the postinst script runs the npm install automatically.
