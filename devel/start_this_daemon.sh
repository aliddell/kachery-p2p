#!/bin/bash

DIRECTORY=$(cd `dirname $0` && pwd)
export KACHERY_P2P_API_PORT=20451
export KACHERY_STORAGE_DIR=$DIRECTORY/kachery-storage
export KACHERY_P2P_CONFIG_DIR=$KACHERY_STORAGE_DIR
mkdir -p $KACHERY_STORAGE_DIR

kachery-p2p-start-daemon --channel test1 --method dev --verbose 2 --dverbose 1 --host localhost --port 3018 --bootstrap localhost:3008 "$@"
