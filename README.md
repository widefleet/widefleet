# UI screenshots for pull request #159

Before: `94a8fa3adf10485f7687f707eda6be4b175102d0`.
After: `e8f0a1c0274d4ff08988174362598486f3afc1e8`.

Captured from local builds with synthetic data. Both versions use the same caller
(Warehouse portal), providers (Directory API and Inventory API), and user roles.
Desktop viewport: 1280 x 900 CSS pixels. Mobile viewport: 390 x 900 CSS pixels.
Light and dark appearance use the application's existing theme support.
The PNGs are unmodified browser captures; mobile captures use a 2x pixel scale.

- `member`: API catalog as an ordinary app owner; both provider rows visible.
- `admin`: same Inventory API connection form before and after, filtered by Inventory.
- `request-form`: new member request form, expanded with ERP as the binding name.
- `availability`: new administrator availability setting, expanded.
- `review`: new administrator request list with pending, approved and rejected states.

The request form, availability setting and request list have no equivalent screen
in the base version and are shown as new views rather than fabricated before images.

These files are review assets for https://github.com/widefleet/widefleet/pull/159.
