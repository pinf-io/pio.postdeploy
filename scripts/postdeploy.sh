#!/bin/bash -e

CONFIGURED_DIR=$(date +%s%N)

if [ ! -d "configured/$CONFIGURED_DIR" ]; then
	mkdir -p configured/$CONFIGURED_DIR
fi
cp -Rf sync/scripts configured/$CONFIGURED_DIR/scripts
cp -Rf sync/source configured/$CONFIGURED_DIR/source
cp -Rf sync/source configured/$CONFIGURED_DIR/install


cd configured/$CONFIGURED_DIR/install
sudo mkdir node_modules
sudo chown $PIO_SERVICE_OS_USER:$PIO_SERVICE_OS_USER node_modules
npm install --production
cd ../../..

cp sync/.pio.json configured/$CONFIGURED_DIR

rm -f live || true
ln -s configured/$CONFIGURED_DIR live


rm -f ../../bin/pio-postdeploy || true
ln -s $PIO_SERVICE_PATH/live/install/index.js ../../bin/pio-postdeploy
