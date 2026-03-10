#!/bin/bash
set -euo pipefail

# Firewall rules are ephemeral and must be re-applied on every container start.
sudo /usr/local/bin/init-firewall.sh
