#! /bin/bash
export NODE_ENV=production
export NODE_PATH=/home/pi/sensorgnome-control/src
export LC_ALL="C.UTF-8"
cd $NODE_PATH
sudo nodemon -i fd-config.json main.js