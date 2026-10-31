# Sourced by install.sh and verify-install.sh.
#
# The router answering health must be the service's own: its process, or one
# that process started, as when a version manager's shim runs the real node as
# a child. A stray copy of the router holding the port is neither.

# Prints the service's process and every process it started, comma-separated,
# or nothing when the service runs none.
#   service_pids <platform> <launchd label> <systemd unit>
service_pids() {
  local pid=""
  case "$1" in
    Darwin)
      pid="$(launchctl print "gui/$(id -u)/$2" 2>/dev/null | awk '$1 == "pid" && $2 == "=" { print $3; exit }')"
      ;;
    Linux)
      pid="$(systemctl --user show -p MainPID --value "$3" 2>/dev/null || true)"
      ;;
  esac
  [[ -n "$pid" && "$pid" != 0 ]] || return 0
  printf '%s' "$pid"
  descendant_pids "$pid"
}

descendant_pids() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null || true); do
    printf ',%s' "$child"
    descendant_pids "$child"
  done
}

# Waits up to five seconds for the service's router to answer health.
#   wait_for_service_router <platform> <launchd label> <systemd unit> <verify-health.mjs> <router file> <health url>
wait_for_service_router() {
  local attempt
  for attempt in $(seq 1 25); do
    if node "$4" "$5" "$6" "--service-pid=$(service_pids "$1" "$2" "$3")" 2>/dev/null; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}
