#! /bin/bash
# Install node v18 if it's not there. This is a hack 'cause SG versions prior to 2023-080
# don't supporting updating the package source and so we can't just state nodejs >= 18 in
# the sg-control package control file
[[ $(node --version) == v18* ]] && exit 0
apt install -y nodejs
