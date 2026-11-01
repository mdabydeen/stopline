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

## Data handling and privacy

Stopline sends the current page text (truncated), page title and URL, the user
task, and the proposed action label and value to the configured model gateway.
Values for fields that look like credentials, payment details, or other secrets
(password, card, OTP, and similar) are masked in the action description, but
other typed values are not. Do not use real credentials, payment details,
personal information, or sensitive pages with these examples.

Evidence logs are written locally as JSONL and are not sent anywhere by this
project. They can still contain action labels, page URLs and titles, task text,
and model answers, so treat a log as sensitive as the session it recorded.

## Scope boundary

The repository does not promise protection for a surrounding application,
browser profile, model provider, deployment, or workflow that embeds the
examples. Do not use the examples with real credentials, payment details, or
other sensitive data.
