#! /bin/bash -e
DESTDIR=build-temp
sudo rm -rf $DESTDIR
mkdir $DESTDIR

# npm update to pull in the latest versions of all dependencies
(cd src; npm --no-fund update)

# install FlexDash in there
mkdir src/public/flexdash
curl -L https://s3.amazonaws.com/s3.voneicken.com/flexdash/flexdash-0.3.18.tgz | \
    tar xzf - -C src/public/flexdash

# install the control application files as user gnome=1000
SG=$DESTDIR/opt/sensorgnome
install -d $SG/control
cp -r src/* $SG/control
cp gen-support $SG
cp install-node-18.sh $SG
sudo chown -R 1000:1000 $SG/control

# install default acquisition file and tag database into templates dir
sudo install -d $DESTDIR/opt/sensorgnome/templates -o 1000 -g 1000
sudo install -m 644 acquisition.json SG_tag_database.sqlite $DESTDIR/opt/sensorgnome/templates

# service file should be owned by root
sudo install -d $DESTDIR/etc/systemd/system -o 0 -g 0
sudo install -m 644 -o 0 -g 0 *.service $DESTDIR/etc/systemd/system

# logrotate control file
sudo install -d $DESTDIR/etc/logrotate.d
sudo install -m 644 sg-control.rotate $DESTDIR/etc/logrotate.d/sg-control

cp -r DEBIAN $DESTDIR
sed -e "/^Version/s/:.*/: $(TZ=PST8PDT date +%Y.%j)/" -i $DESTDIR/DEBIAN/control # set version: YYYY.DDD
mkdir -p packages
dpkg-deb -Zxz --build $DESTDIR packages
# dpkg-deb --contents packages
ls -lh packages
