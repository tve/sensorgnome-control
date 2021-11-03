#! /bin/bash -e
DESTDIR=build-temp
rm -rf $DESTDIR
mkdir $DESTDIR

(cd src; npm install)

DEST=$DESTDIR/opt/sensorgnome/control
install -d $DEST
cp -r src $DEST

install -d $DESTDIR/data/config
install -m 644 defaultDeployment.txt $DESTDIR/data/config/DEPLOYMENT.TXT
install -d $DESTDIR/etc/systemd/system
install -m 644 *.service $DESTDIR/etc/systemd/system

cp -r DEBIAN $DESTDIR
mkdir -p packages
dpkg-deb -v --build $DESTDIR packages/sg-control.deb
# dpkg-deb --contents packages/sg-control.deb
ls -lh packages/sg-control.deb
