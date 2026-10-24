# Contributing to LightMeUp

Thanks for helping! Bug reports, hardware test results, new receiver sketches and code are all welcome.

## Reporting problems

Open an [issue](https://github.com/pascalseguin/lightmeup/issues) with:
- what you did, what you expected, and what happened
- your OS and browser, and the LightMeUp version (`LightMeUp --version`, or the release you downloaded)
- for hardware problems: the board, servo model, how DMX or sACN reaches it, and your channel map

Reports like "the .fseq played correctly on FPP 8.x" or "these servo limits work for a Home Depot 5 ft skeleton"
help a lot too.

## Making changes

The editor is plain HTML and JavaScript with no build step, and the bridge uses only the Python standard library.
Please keep it that way, so anyone can run it from a checkout.

```bash
python3 server.py --open                 # run it
node --test tests/core.test.js           # data model, exports, analysis
python3 -m unittest discover tests       # sACN packets and the HTTP bridge
```

- Put data, timing and export logic in `app/core.js` (no DOM access) and add a test for it.
- Keep pull requests focused, and describe how you tested them (on hardware if relevant).
- Add a line under an "Unreleased" heading in `CHANGELOG.md` for anything users will notice.

## Releasing (maintainers)

1. Bump `__version__` in `server.py` and move the changelog entries under the new version.
2. Commit, then tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
3. The Release workflow builds the Windows and Linux packages and publishes the GitHub release.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).
