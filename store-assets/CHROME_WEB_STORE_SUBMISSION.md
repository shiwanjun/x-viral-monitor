# Chrome Web Store Submission — X-Tools

The files in this folder are ready for the product-details form shown in the supplied screenshots.

## Fill these fields

| Console field | Value / file |
| --- | --- |
| Title | `X-Tools` |
| Summary | `Viral detection & follow insights: velocity badges, mutual-follow marks, one-way follow, unfollow alerts. All local, zero data.` |
| Description | Copy the **English — Detailed Description** section from `store-listing.md`. |
| Category | Tools |
| Store icon | `store-icon-128.png` (128 × 128 PNG) |
| Screenshots | `screenshot-1280x800.png` (1280 × 800 PNG) |
| Small promo tile | `promo-440x280.png` (440 × 280 PNG) |
| Marquee promo tile | `banner-1400x560.png` (1400 × 560 PNG) |
| Homepage URL | `https://x.jieyiai.dev/` |
| Support URL | `https://x.jieyiai.dev/support.html` |
| Privacy policy URL | `https://x.jieyiai.dev/privacy.html` |
| Adult content | No |

## Privacy tab

Copy the single-purpose and permission explanations from `../docs/chrome-web-store/privacy.md`.

- Remote code: **No**.
- Declare only the data types actually required by the final packaged build.
- Complete the three Chrome Web Store data-use certifications truthfully.

## Before uploading

1. Deploy `docs/` so Privacy, Terms, and Support are publicly reachable over HTTPS.
2. Run `npm run package:store`; upload the generated zip, not the repository root.
3. Check the zip contains no `.env`, `secrets/`, development-only files, or remote executable code.
4. Confirm the version in `manifest.json` is greater than the published version.
5. Validate every statement against the final build. Do not claim "zero data" if optional external services are enabled without explaining them.

## Owner confirmation required

Google sign-in, asset upload, data-use declarations, and submission are account-level actions. They require review and confirmation by the extension owner in the Chrome Web Store Developer Dashboard.
