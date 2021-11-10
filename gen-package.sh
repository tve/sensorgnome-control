#! /bin/bash -e
DESTDIR=build-temp
sudo rm -rf $DESTDIR
mkdir $DESTDIR

# npm update to pull in the latest versions of all dependencies
(cd src; npm --no-fund update)

# install the control application files as user pi=1000
SG=$DESTDIR/opt/sensorgnome
install -d $SG/control
cp -r src/* $SG/control
sudo chown -R 1000:1000 $SG/control

# install default deployment file into templates dir
# (can't install to /data/config 'cause that may be on FAT32 and dpkg will fail setting perms)
sudo install -d $DESTDIR/opt/sensorgnome/templates -o 1000 -g 1000
sudo install -o 1000 -g 1000 -m 644 deployment.txt $DESTDIR/opt/sensorgnome/templates

# service file should be owned by root
sudo install -d $DESTDIR/etc/systemd/system -o 0 -g 0
sudo install -m 644 -o 0 -g 0 *.service $DESTDIR/etc/systemd/system

cp -r DEBIAN $DESTDIR
sed -e "/^Version/s/:.*/: $(date +%Y.%j)/" -i $DESTDIR/DEBIAN/control # set version: YYYY.DDD
mkdir -p packages
dpkg-deb --build $DESTDIR packages
# dpkg-deb --contents packages
ls -lh packages
