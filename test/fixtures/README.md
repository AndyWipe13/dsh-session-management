# Fixture Bank

Read-only regression fixtures for dsh-session-management.

## Provenance

Files are desensitized copies of real local Claude Code, Codex (including
`archived_sessions`) and DSH session logs from the generating machine. DSH
artifacts are stored as decompressed plaintext `.jsonl` for readability; the
original durable encoding is multi-frame zstd `session.jsonl.zstd`.

## Read-only contract

Tests MUST NOT modify, move, or delete any file under this directory. Before
and after a test run, every fixture file's bytes and mtime must be unchanged.
