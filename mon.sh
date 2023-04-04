#! /bin/bash
[[ -f /usr/bin/nodemon ]] || sudo npm install -g nodemon
export NODE_ENV=production
export NODE_PATH=/home/gnome/sensorgnome-control/src
export LC_ALL="C.UTF-8"
cd $NODE_PATH
sudo UV_THREADPOOL_SIZE=20 nodemon -i fd-config.json main.js
