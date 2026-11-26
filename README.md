# herdr-glass

Standalone Herdr App layout repository for `glass` and `glass-insights` and other layouts, plus the original, forked and vendored third-party mods the layouts use.

See [`RECIPE.md`](./RECIPE.md) for installation and sync instructions and [`PROVENANCE.md`](./PROVENANCE.md) for mod attribution and provenance.

## Install

Run `scripts/install.sh` for a report of what is missing, then `scripts/install.sh --apply` to install the pack. See [`RECIPE.md`](./RECIPE.md) for the options.

## Validation

Validate mods with the Herdr App checker:

```bash
herdr-app check mods/<mod-name>
```

On macOS:

```bash
/Applications/Herdr.app/Contents/MacOS/Herdr check mods/<mod-name>
```

Run the pack's tests, including the check that `requirements.json` lists every program the mods run:

```bash
node --test tests/*.test.cjs
```

## License

MIT, see [`LICENSE`](./LICENSE). Forked and vendored mods keep their upstream licenses: see [`NOTICE`](./NOTICE) and [`LICENSES/`](./LICENSES/).
