# Security

## The live bridge has no authentication

`server.py` accepts DMX frames from any client that can reach its port and forwards them to your show network. By
default it listens only on `127.0.0.1`. Use `--bind 0.0.0.0` only on a network you trust, and never expose the
bridge port to the internet. The editor itself (`app/`) is static and safe to host publicly.

## Reporting a vulnerability

Please use GitHub's [private vulnerability reporting](https://github.com/pascalseguin/lightmeup/security/advisories/new)
rather than a public issue. You can expect a reply within a week.
