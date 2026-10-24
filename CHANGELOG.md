# Changelog

All notable changes to LightMeUp are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-23

First public release.

### Added
- Show editor with a timeline, waveform and live stage preview, for skeletons (arm, mouth, body turn) and RGB or
  dimmer lights.
- Auto mouth (vocal-band lip sync, optionally from a separate vocals file), auto lights (flash, chase or follow on
  bass, mid or treble) and auto turn (look-around or sway).
- Point, freehand-draw and erase editing, pose sliders, section selection and looping, undo/redo, and autosave.
- Exports: FSEQ v1 for Falcon Player / xLights, CSV channel data, and a channel map.
- `server.py`: local web server plus live E1.31/sACN output (unicast or multicast).
- Arduino Uno/Nano (DMX) and ESP32 (WiFi sACN) receiver sketches.
- Windows installer and portable zip, Linux `.deb` and AppImage.

[0.1.0]: https://github.com/pascalseguin/lightmeup/releases/tag/v0.1.0
