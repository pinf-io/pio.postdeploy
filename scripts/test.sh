#!/bin/bash -e

if ! hash pio-postdeploy 2>/dev/null; then
	echo "'pio-postdeploy' command not found on path!"
	echo '<wf name="result">{"success": false}</wf>'
	exit 1
fi

which pio-postdeploy

echo '<wf name="result">{"success": true}</wf>'

exit 0
