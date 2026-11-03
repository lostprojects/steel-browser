#!/bin/sh
# Limit Chrome and its children to eight available CPUs. Railway's CPU numbers
# need not start at zero, so read this process's permitted range.
set -eu
cpus=$(awk '/Cpus_allowed_list/ {print $2}' /proc/self/status)
selected=$(printf '%s\n' "$cpus" | awk -F, '{n=0; for(i=1;i<=NF && n<8;i++){split($i,a,"-"); end=a[2] ? a[2] : a[1]; for(j=a[1];j<=end && n<8;j++){printf "%s%d", n ? "," : "", j; n++}}}')
exec taskset -c "$selected" /usr/bin/google-chrome-stable "$@"
