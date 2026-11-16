# UI screenshots for pull request #159

Before: `94a8fa3adf10485f7687f707eda6be4b175102d0`.
After: `9a0342e21c7cf1152e46809d640a48f9addb47f2`.

Captured from local builds with synthetic data. Both versions use the same caller
(Warehouse portal), providers (Directory API and Inventory API), and user roles.
Desktop viewport: 1280 x 900 CSS pixels. Mobile viewport: 390 x 900 CSS pixels.
Light and dark appearance use the application's existing theme support.
The PNGs are unmodified browser captures; mobile captures use a 2x pixel scale.

- `before-member`: the member catalog at the PR base, without connection actions.
- `flow-catalog`: choose an API, then enter its dedicated connection flow.
- `flow-choose-app`: choose an app the member manages.
- `flow-configure`: select an entrypoint and name the binding before submitting.
- `flow-result`: the actual submitted request and its next steps.
- `flow-connected`: direct connection saved for an app that has not been deployed.
- `flow-availability`: a separate administrator page for provider availability.
- `flow-review`: administrator review with pending, approved and rejected requests.
- `flow-connections`: saved binding expanded on the caller's Connections page;
  mobile views are scrolled to the binding details.

The guided steps and result pages have no equivalent in the base version.
These files are review assets for https://github.com/widefleet/widefleet/pull/159.
