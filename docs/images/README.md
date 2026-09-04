# Screenshots

Optimised PNG screenshots of the dashboard, captured from sanitised fixture
data (not the live database). Used in the documentation handbook.

Screenshots to add before v0.1.0 launch:
- `fleet-tab.png` — Fleet tab with a few runners grouped by project
- `runs-tab.png` — Runs tab with active and recent jobs
- `capacity-tab.png` — Capacity tab with sizing recommendations
- `lint-tab.png` — Lint tab with concurrency advisor findings
- `hosts-tab.png` — Hosts tab in a federated two-Mac setup
- `runner-drawer.png` — Runner detail drawer showing diagnostics

Instructions for capturing:
1. Load the dashboard with `FLEET_DB=dashboard/test/fixtures/demo.db`
2. Set `FLEET_READ_ONLY=1` so the fixture data cannot be mutated
3. Crop to 1440×900 and run through `pngcrush` or `optipng`
4. Commit here with a plain, descriptive filename
