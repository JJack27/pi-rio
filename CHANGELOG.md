# Changelog

All notable changes to `pi-rio` will be documented in this file.

## [0.1.0] - 2026-11-23

### Added

- Initial standalone open-source release of `pi-rio`.
- Two-layer zero-blocking sidecar architecture (instant Layer 0 tool/file tracking + async Layer 1 cheap-model patch stream).
- Three granularity levels (`low`, `medium`, `high`) with dedicated system prompts, token budgets, and matching TUI widget/overlay density.
- Configurable output language (`/rio lang <en|zh|auto|code>`) with localized TUI chrome for English and Chinese.
- Configurable default sidecar model (`/rio model <provider/id|auto>`) with automatic cheap-model fallback.
- Interactive fullscreen reasoning trail overlay (`Ctrl+Shift+I`) with step expansion and session request history navigation.
- Session branch persistence across `/tree` switches and atomic live JSON publishing (`~/.pi/agent/rio-live/`).
