# Security Policy

## Supported version

Only the latest GitHub Release is supported.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for issues involving API keys, local file access, PDF parsing, SSRF protections or arbitrary code execution. Do not place secrets, private papers or school credentials in a public issue.

The local server intentionally binds only to `127.0.0.1`. Changes that expose it on `0.0.0.0` should be treated as security-sensitive.
