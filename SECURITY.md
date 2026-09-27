# Security policy

Stopline is an experimental research and teaching project. It is not a
production security control, and running the examples does not make an agent
workflow safe.

## Reporting a concern

Please report a reproducible security concern through a private GitHub
security advisory if that option is available for the repository. If GitHub
does not offer that option, open a minimal public issue that says a private
report is needed; do not include credentials, tokens, personal information,
or a complete exploit in the issue.

Include:

- the commit or release tested;
- the smallest reproduction command or fixture;
- the observed behaviour and the expected behaviour; and
- any conditions needed to reproduce it.

I will assess reports against the code and the documented scope. A report may
describe an implementation defect, an unsafe default in the example, or a
limitation that is already documented. There is no response-time or patching
guarantee.

## Scope boundary

The repository does not promise protection for a surrounding application,
browser profile, model provider, deployment, or workflow that embeds the
examples. Do not use the examples with real credentials, payment details, or
other sensitive data.
