#!/bin/bash

DIRECTORY=$(cd `dirname $0` && pwd)
export KACHERY_P2P_API_PORT=20451
export KACHERY_STORAGE_DIR=$DIRECTORY/kachery-storage
export KACHERY_P2P_CONFIG_DIR=$KACHERY_STORAGE_DIR

exec ipython
