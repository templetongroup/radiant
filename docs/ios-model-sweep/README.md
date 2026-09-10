# Weekly iPhone/iPad model sweep

Standing instruction from Tony (2026-09-10): *"for the ios/ipados versions I
want you to check for relevant models every sunday night and update the app
monday morning as needed."*

Two scheduled tasks in the Claude app carry it out:

- **Sunday 9 pm — `radiant-ios-model-sweep`.** Runs `npm run catalog:check`
  against the live catalogue, looks for new MLX-format instruct models from
  the makers already here (and notable new families), verifies each against
  the Hugging Face API the way `scripts/catalog-check.py` does, and writes a
  report here as `<YYYY-MM-DD>.md`. Rows it recommends go onto a branch
  `ios-models/<YYYY-MM-DD>`, checked, not merged.
- **Monday 8 am — `radiant-ios-model-apply`.** Merges that branch, publishes
  the catalogue to the website (which is what installed apps read at launch),
  rebuilds the app and installs it on every paired device via
  `scripts/ios-install-all.sh`, updates the in-app Read me, files the Linear
  issue.

Both run only while the Claude desktop app is open on Tony's Mac; a missed
slot runs at the next launch. Nothing here touches App Store Connect — a new
row reaches installed apps through the published catalogue, and a new
*architecture* needs a new binary, which the Monday report will call out for
Tony to decide.
